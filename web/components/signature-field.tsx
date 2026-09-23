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
 * The drawing surface, from signature_pad.
 *
 * Loaded when somebody chooses to draw, not with the form: most people will
 * type, and the public form should not carry a library for the few who draw.
 */
function DrawPad({ image, onDrawn }: { image: string | null; onDrawn: (png: string | null) => void }) {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const pad = useRef<{ clear(): void; isEmpty(): boolean; toDataURL(type?: string): string; off(): void; fromDataURL(u: string, o?: object): Promise<void> } | null>(null);
  const [empty, setEmpty] = useState(!image);
  const done = useRef(onDrawn);
  done.current = onDrawn;

  useEffect(() => {
    let cancelled = false;
    let resize: (() => void) | null = null;
    void import('signature_pad').then(({ default: SignaturePad }) => {
      const el = canvas.current;
      if (cancelled || !el) return;
      const p = new SignaturePad(el, { penColor: '#131a17', minWidth: 0.8, maxWidth: 2.6 });
      // Sized for the screen's real pixels, or the line is blurred on a phone.
      resize = () => {
        const kept = p.isEmpty() ? null : p.toDataURL('image/png');
        const ratio = Math.max(window.devicePixelRatio || 1, 1);
        el.width = el.offsetWidth * ratio;
        el.height = el.offsetHeight * ratio;
        el.getContext('2d')?.scale(ratio, ratio);
        p.clear();
        if (kept) void p.fromDataURL(kept, { ratio });
      };
      resize();
      if (image) void p.fromDataURL(image);
      p.addEventListener('endStroke', () => {
        setEmpty(false);
        done.current(p.toDataURL('image/png'));
      });
      pad.current = p;
      window.addEventListener('resize', resize);
    });
    return () => {
      cancelled = true;
      if (resize) window.removeEventListener('resize', resize);
      pad.current?.off();
    };
    // The image is read once, on mount; after that the pad is the source.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="sg__draw">
      <div className="sg__padWrap">
        <canvas ref={canvas} className="sg__pad" aria-label="Draw your signature here" role="img" />
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
          pad.current?.clear();
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
