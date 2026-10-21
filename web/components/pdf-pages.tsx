'use client';

/**
 * PDF pages drawn in the browser, with things placed on top of each page.
 *
 * pdf.js 4.10.38 is served from /public (pdf.min.mjs and its worker) and
 * loaded at run time, outside the bundler, so the app build never has to
 * understand it. Positions on top of a page are fractions of the page from
 * the top left — the same numbers the server uses to stamp the PDF — so what
 * a sender places and what a signer sees are the same spot whatever the
 * screen size.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';

type PdfJs = { GlobalWorkerOptions: { workerSrc: string }; getDocument: (src: { data: ArrayBuffer }) => { promise: Promise<PdfDoc> } };
type PdfDoc = { numPages: number; getPage: (n: number) => Promise<PdfPage> };
type PdfPage = { getViewport: (o: { scale: number }) => { width: number; height: number }; render: (o: { canvasContext: CanvasRenderingContext2D; viewport: unknown }) => { promise: Promise<void> } };

let loader: Promise<PdfJs> | null = null;
function pdfjs(): Promise<PdfJs> {
  if (!loader) {
    loader = (import(/* webpackIgnore: true */ '/pdf.min.mjs' as string) as Promise<PdfJs>).then((m) => { m.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs'; return m; });
  }
  return loader;
}

export function PdfPages({ data, overlay, onPageClick, onPageDrop, maxWidth = 820 }: {
  data: ArrayBuffer;
  /** What to draw on top of page n (1-based), positioned with fractions of the page. */
  overlay?: (page: number) => ReactNode;
  /** A click on a page, as fractions of the page from the top left. */
  onPageClick?: (page: number, x: number, y: number) => void;
  onPageDrop?: (page: number, x: number, y: number, kind: string) => void;
  maxWidth?: number;
}) {
  const [doc, setDoc] = useState<PdfDoc | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setDoc(null); setError(null);
    pdfjs().then((p) => p.getDocument({ data: data.slice(0) }).promise).then((d) => { if (!cancelled) setDoc(d); }).catch(() => { if (!cancelled) setError('This PDF could not be shown.'); });
    return () => { cancelled = true; };
  }, [data]);
  if (error) return <p role="alert">{error}</p>;
  if (!doc) return <p>Loading the document…</p>;
  return <div style={{ display: 'grid', gap: 16, minWidth: 0, width: '100%' }}>
    {Array.from({ length: doc.numPages }, (_, i) => <Page key={i} doc={doc} n={i + 1} maxWidth={maxWidth} overlay={overlay} onPageClick={onPageClick} onPageDrop={onPageDrop} />)}
  </div>;
}

function Page({ doc, n, maxWidth, overlay, onPageClick, onPageDrop }: { doc: PdfDoc; n: number; maxWidth: number; overlay?: (page: number) => ReactNode; onPageClick?: (page: number, x: number, y: number) => void; onPageDrop?: (page: number, x: number, y: number, kind: string) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [availableWidth, setAvailableWidth] = useState(maxWidth);
  useEffect(() => {
    const parent = box.current?.parentElement;
    if (!parent) return;
    const measure = () => setAvailableWidth(Math.max(1, parent.clientWidth));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(parent);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    let cancelled = false;
    let renderTask: { promise: Promise<void>; cancel?: () => void } | null = null;
    (async () => {
      const page = await doc.getPage(n);
      const width = Math.min(maxWidth, availableWidth);
      const base = page.getViewport({ scale: 1 });
      const scale = width / base.width;
      const viewport = page.getViewport({ scale: scale * (window.devicePixelRatio || 1) });
      const c = canvas.current; if (!c || cancelled) return;
      c.width = viewport.width; c.height = viewport.height;
      c.style.width = `${width}px`; c.style.height = `${base.height * scale}px`;
      setSize({ w: width, h: base.height * scale });
      renderTask = page.render({ canvasContext: c.getContext('2d')!, viewport });
      await renderTask.promise;
    })().catch(() => undefined);
    return () => { cancelled = true; renderTask?.cancel?.(); };
  }, [doc, n, maxWidth, availableWidth]);
  return <div ref={box} style={{ position: 'relative', width: size?.w ?? '100%', maxWidth: '100%', boxShadow: '0 1px 4px rgba(0,0,0,.25)', background: '#fff', margin: '0 auto' }}
    aria-label={`Page ${n}`} role="group"
    onDragOver={(e) => { if (onPageDrop && e.dataTransfer.types.includes('application/x-patform-sign-field')) e.preventDefault(); }}
    onDrop={(e) => { const kind = e.dataTransfer.getData('application/x-patform-sign-field'); if (!onPageDrop || !kind) return; e.preventDefault(); e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); onPageDrop(n, (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height, kind); }}
    onClick={(e) => { if (!onPageClick || !size) return; if ((e.target as HTMLElement).dataset.field) return; const r = e.currentTarget.getBoundingClientRect(); onPageClick(n, (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height); }}>
    <canvas ref={canvas} style={{ display: 'block' }} />
    {size && overlay?.(n)}
    <span style={{ position: 'absolute', right: 6, bottom: 4, fontSize: 11, color: '#666' }}>Page {n}</span>
  </div>;
}

/** A box on a page at fractions of the page. */
export function PageBox({ x, y, width, height, children, color = '#1f6feb', onClick, onMove, selected, title }: { x: number; y: number; width: number; height: number; children?: ReactNode; color?: string; onClick?: () => void; onMove?: (x: number, y: number) => void; selected?: boolean; title?: string }) {
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  return <button type="button" data-field="1" title={title} onClick={(e) => { e.stopPropagation(); onClick?.(); }}
    onPointerDown={(e) => { if (!onMove) return; const page = e.currentTarget.parentElement?.getBoundingClientRect(); if (!page) return; drag.current = { x: e.clientX, y: e.clientY, left: x, top: y }; e.currentTarget.setPointerCapture(e.pointerId); }}
    onPointerMove={(e) => { if (!drag.current || !onMove) return; const page = e.currentTarget.parentElement?.getBoundingClientRect(); if (!page) return; onMove(Math.max(0, Math.min(1 - width, drag.current.left + (e.clientX - drag.current.x) / page.width)), Math.max(0, Math.min(1 - height, drag.current.top + (e.clientY - drag.current.y) / page.height))); }}
    onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}
    style={{ position: 'absolute', left: `${x * 100}%`, top: `${y * 100}%`, width: `${width * 100}%`, height: `${height * 100}%`, border: `${selected ? 3 : 2}px solid ${color}`, background: `${color}22`,
      color, fontSize: 11, padding: 0, cursor: onMove ? 'move' : onClick ? 'pointer' : 'default', overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 3, touchAction: onMove ? 'none' : undefined, boxShadow: selected ? `0 0 0 3px ${color}33` : undefined }}>
    {children}
  </button>;
}
