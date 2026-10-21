'use client';

/**
 * Signing a form: type your name and adopt it in a handwriting style, or draw
 * it with a mouse, a finger or a pen.
 *
 * Typing comes first and is the default. Drawing cannot be done from a
 * keyboard or with most screen readers, so a form that only offered a canvas
 * would lock those people out of signing for money at all.
 *
 * Either way the printed name is part of the value. The server checks the
 * shape (`src/blueprint/signature.ts`); this only collects it.
 */

import { useEffect, useRef, useState } from 'react';
import './signature-field.css';

export const SIGNATURE_STYLES = [
  { key: 'flowing', label: 'Flowing' },
  { key: 'elegant', label: 'Elegant' },
  { key: 'casual', label: 'Casual' },
] as const;

type Style = (typeof SIGNATURE_STYLES)[number]['key'];

export type SignatureValue =
  | { method: 'typed'; name: string; style: Style }
  | { method: 'drawn'; name: string; image: string };

export function isSignature(value: unknown): value is SignatureValue {
  return typeof value === 'object' && value !== null && 'method' in value && 'name' in value;
}

export function SignatureField({
  id,
  value,
  onChange,
  describedBy,
  invalid,
}: {
  id: string;
  value: unknown;
  onChange: (value: unknown) => void;
  describedBy?: string;
  invalid?: boolean;
}) {
  const current = isSignature(value) ? value : null;
  const [method, setMethod] = useState<'typed' | 'drawn'>(current?.method ?? 'typed');
  const [name, setName] = useState(current?.name ?? '');
  const [style, setStyle] = useState<Style>(current?.method === 'typed' ? current.style : 'flowing');
  const [image, setImage] = useState<string | null>(current?.method === 'drawn' ? current.image : null);

  // One place turns what is on screen into the answer, so the answer can
  // never describe a signature the person is no longer looking at.
  const emit = (next: { method?: 'typed' | 'drawn'; name?: string; style?: Style; image?: string | null }) => {
    const m = next.method ?? method;
    const n = next.name ?? name;
    const st = next.style ?? style;
    const im = next.image === undefined ? image : next.image;
    if (!n.trim()) return onChange(undefined);
    if (m === 'typed') return onChange({ method: 'typed', name: n, style: st });
    return onChange(im ? { method: 'drawn', name: n, image: im } : undefined);
  };

  return (
    <div className="sg" data-invalid={invalid ? 'true' : undefined}>
      <div className="sg__modes" role="radiogroup" aria-label="How to sign">
        {(
          [
            ['typed', 'Type it'],
            ['drawn', 'Draw it'],
          ] as const
        ).map(([key, label]) => (
          <label key={key} className="sg__mode" data-on={method === key ? 'true' : undefined}>
            <input
              type="radio"
              name={`${id}-method`}
              checked={method === key}
              onChange={() => {
                setMethod(key);
                emit({ method: key });
              }}
            />
            {label}
          </label>
        ))}
      </div>

      <label className="sg__nameLabel" htmlFor={id}>
        Your full name
      </label>
      <input
        id={id}
        className="fm__input sg__name"
        value={name}
        autoComplete="name"
        aria-describedby={describedBy}
        aria-invalid={invalid ? true : undefined}
        onChange={(e) => {
          setName(e.target.value);
          emit({ name: e.target.value });
        }}
      />

      {method === 'typed' ? (
        <fieldset className="sg__styles">
          <legend className="sg__legend">Choose how it looks</legend>
          {SIGNATURE_STYLES.map((s) => (
            <label key={s.key} className="sg__style" data-on={style === s.key ? 'true' : undefined}>
              <input
                type="radio"
                name={`${id}-style`}
                checked={style === s.key}
                onChange={() => {
                  setStyle(s.key);
                  emit({ style: s.key });
                }}
              />
              <span className={`sg__ink sg__ink--${s.key}`} aria-hidden="true">
                {name.trim() || 'Your name'}
              </span>
              <span className="sg__styleName">{s.label}</span>
            </label>
          ))}
        </fieldset>
      ) : (
        <DrawPad
          image={image}
          onDrawn={(png) => {
            setImage(png);
            emit({ image: png });
          }}
        />
      )}

      <p className="sg__note">Signing puts your name to this request. It is kept with the record and the time you submit.</p>
    </div>
  );
}

/**
 * Draw directly on the canvas. A remote, delayed script must not be required
 * for the signer to put ink on the page, especially on a phone.
 */
function DrawPad({ image, onDrawn }: { image: string | null; onDrawn: (png: string | null) => void }) {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const drawing = useRef(false);
  const lastPoint = useRef<{ x: number; y: number } | null>(null);
  const inkData = useRef<string | null>(image);
  const [empty, setEmpty] = useState(!image);

  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const restore = (data: string) => {
      const saved = new Image();
      saved.onload = () => {
        const ctx = el.getContext('2d');
        if (ctx) ctx.drawImage(saved, 0, 0, el.clientWidth, el.clientHeight);
      };
      saved.src = data;
    };
    const resize = () => {
      const kept = inkData.current;
      const ratio = Math.max(window.devicePixelRatio || 1, 1);
      const width = Math.max(1, Math.round(el.clientWidth * ratio));
      const height = Math.max(1, Math.round(el.clientHeight * ratio));
      if (el.width === width && el.height === height) return;
      el.width = width;
      el.height = height;
      el.getContext('2d')?.setTransform(ratio, 0, 0, ratio, 0, 0);
      if (kept) restore(kept);
    };
    resize();
    if (image) restore(image);
    const observer = new ResizeObserver(resize);
    observer.observe(el);
    window.addEventListener('resize', resize);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', resize);
    };
    // The image is read once, on mount; after that the canvas is the source.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const point = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };
  const finish = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    drawing.current = false;
    lastPoint.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setEmpty(false);
    const png = event.currentTarget.toDataURL('image/png');
    inkData.current = png;
    onDrawn(png);
  };

  return (
    <div className="sg__draw">
      <div className="sg__padWrap">
        <canvas
          ref={canvas}
          className="sg__pad"
          aria-label="Draw your signature here"
          role="img"
          onPointerDown={(event) => {
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            drawing.current = true;
            const start = point(event);
            lastPoint.current = start;
            const ctx = event.currentTarget.getContext('2d');
            if (!ctx) return;
            ctx.fillStyle = '#131a17';
            ctx.beginPath();
            ctx.arc(start.x, start.y, 1.4, 0, Math.PI * 2);
            ctx.fill();
          }}
          onPointerMove={(event) => {
            if (!drawing.current || !lastPoint.current) return;
            event.preventDefault();
            const next = point(event);
            const ctx = event.currentTarget.getContext('2d');
            if (!ctx) return;
            ctx.strokeStyle = '#131a17';
            ctx.lineWidth = 2.5;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            ctx.beginPath();
            ctx.moveTo(lastPoint.current.x, lastPoint.current.y);
            ctx.lineTo(next.x, next.y);
            ctx.stroke();
            lastPoint.current = next;
          }}
          onPointerUp={finish}
          onPointerCancel={finish}
        />
        <span className="sg__line" aria-hidden="true" />
        {empty && (
          <span className="sg__hint" aria-hidden="true">
            Sign here
          </span>
        )}
      </div>
      <button
        type="button"
        className="sg__clear"
        onClick={() => {
          const el = canvas.current;
          if (el) el.getContext('2d')?.clearRect(0, 0, el.clientWidth, el.clientHeight);
          inkData.current = null;
          setEmpty(true);
          onDrawn(null);
        }}
      >
        Clear
      </button>
    </div>
  );
}

/** A signature on a record: the image or the adopted style, and the printed name. */
export function SignatureView({ value }: { value: SignatureValue }) {
  return (
    <span className="sg__view">
      {value.method === 'drawn' ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img className="sg__viewImg" src={value.image} alt={`Signature of ${value.name}`} />
      ) : (
        <span className={`sg__ink sg__ink--${value.style} sg__viewInk`}>{value.name}</span>
      )}
      <span className="sg__viewName">
        {value.name} · {value.method === 'typed' ? 'typed and adopted' : 'drawn'}
      </span>
    </span>
  );
}
