/**
 * Text messages, for Patform Sign codes.
 *
 * SMS_PROVIDER picks the provider: "termii" (TERMII_API_KEY, TERMII_SENDER_ID,
 * optional TERMII_CHANNEL — "generic" or "dnd"; Nigerian numbers on the
 * do-not-disturb list need "dnd") or "twilio" (TWILIO_ACCOUNT_SID,
 * TWILIO_AUTH_TOKEN and TWILIO_FROM — a number or a messaging service SID).
 * Without one, sending a text fails with a plain reason; nothing is faked.
 * Numbers are E.164: a plus and 8 to 15 digits.
 */
export const PHONE = /^\+[1-9]\d{7,14}$/;
export function normalisePhone(v: string): string { return v.replace(/[\s()-]/g, ''); }
export const maskPhone = (p: string) => `${p.slice(0, 4)}${'•'.repeat(Math.max(0, p.length - 6))}${p.slice(-2)}`;

type Sender = (to: string, body: string) => Promise<void>;
let override: Sender | null = null;
/** Tests read the texts Patform would have sent. */
export function setSmsSenderForTests(fn: Sender | null) { override = fn; }
export function smsConfigured(): boolean {
  if (override) return true;
  const p = process.env.SMS_PROVIDER;
  return (p === 'termii' && !!process.env.TERMII_API_KEY) || (p === 'twilio' && !!process.env.TWILIO_ACCOUNT_SID && !!process.env.TWILIO_AUTH_TOKEN && !!process.env.TWILIO_FROM);
}

export async function sendSms(to: string, body: string, doFetch: typeof fetch = fetch): Promise<void> {
  if (!PHONE.test(to)) throw new Error('not a phone number in international form');
  if (override) return override(to, body);
  const provider = process.env.SMS_PROVIDER;
  if (provider === 'termii') {
    const res = await doFetch('https://api.ng.termii.com/api/sms/send', {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({ api_key: process.env.TERMII_API_KEY, to: to.replace(/^\+/, ''), from: process.env.TERMII_SENDER_ID ?? 'Patform', sms: body, type: 'plain', channel: process.env.TERMII_CHANNEL ?? 'generic' }),
    });
    if (!res.ok) throw new Error(`Termii refused the text (HTTP ${res.status})`);
    return;
  }
  if (provider === 'twilio') {
    const sid = process.env.TWILIO_ACCOUNT_SID!; const from = process.env.TWILIO_FROM!;
    const form = new URLSearchParams({ To: to, Body: body, ...(from.startsWith('MG') ? { MessagingServiceSid: from } : { From: from }) });
    const res = await doFetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
      method: 'POST', signal: AbortSignal.timeout(10_000),
      headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64')}` },
      body: form.toString(),
    });
    if (!res.ok) throw new Error(`Twilio refused the text (HTTP ${res.status})`);
    return;
  }
  throw new Error('text messages are not set up on this server (SMS_PROVIDER)');
}
