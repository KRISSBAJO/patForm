/**
 * A signature, as a record holds it.
 *
 * Two ways to sign, the same two every e-signature service offers: type your
 * name and adopt it in a handwriting style, or draw it. Either way the name is
 * printed as well — a squiggle alone does not say who, and a typed name alone
 * is exactly what the tick-box `signature_ack` already was.
 *
 * What it is not: a qualified electronic signature. It is evidence that this
 * person, signed in or holding this form's link, put their name to this
 * record at the moment the record's history says it was submitted. For
 * internal approvals of money that is what a wet signature on a form was, and
 * the record's history is a better witness than the paper ever had.
 *
 * A drawn signature is a PNG data URL and nothing else. It is shown with an
 * `<img>`, never parsed or injected as markup, and capped in size — a
 * signature is a few kilobytes, and a field that takes anything larger is an
 * upload with no checks.
 */

export const SIGNATURE_STYLES = ['flowing', 'elegant', 'casual'] as const;
export type SignatureStyle = (typeof SIGNATURE_STYLES)[number];

export type SignatureValue =
  | { method: 'typed'; name: string; style: SignatureStyle }
  | { method: 'drawn'; name: string; image: string };

/** About 150 KB of PNG. A careful signature on a large canvas is well under half of this. */
export const MAX_SIGNATURE_IMAGE = 200_000;
const PNG = /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/;

export function isSignature(value: unknown): value is SignatureValue {
  return typeof value === 'object' && value !== null && 'method' in value && 'name' in value;
}

/** Null when it is a valid signature; otherwise what is wrong, in words. */
export function signatureProblem(value: unknown): string | null {
  if (!isSignature(value)) return 'Sign here: type your name or draw your signature.';
  const name = typeof value.name === 'string' ? value.name.trim() : '';
  if (name.length < 2) return 'Write your full name as well as signing.';
  if (name.length > 120) return 'That name is longer than a name.';
  if (value.method === 'typed') {
    if (!SIGNATURE_STYLES.includes(value.style)) return 'Choose one of the signature styles.';
    return null;
  }
  if (value.method === 'drawn') {
    if (typeof value.image !== 'string' || !PNG.test(value.image)) return 'Draw your signature in the box.';
    if (value.image.length > MAX_SIGNATURE_IMAGE) return 'That signature is too large to keep. Clear it and sign again.';
    return null;
  }
  return 'Sign here: type your name or draw your signature.';
}

/** A signature in words, for exports, bulk previews and anywhere a picture cannot go. */
export function signatureWords(value: SignatureValue): string {
  return `Signed by ${value.name.trim()} (${value.method === 'typed' ? 'typed' : 'drawn'})`;
}
