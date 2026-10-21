/** Hosted payment providers for Sign Payment Items. Secrets never reach the browser.
 * Webhooks are hints; the provider's authenticated verify endpoint is the
 * authority for whether a particular amount and currency actually settled. */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { InvalidInput } from './errors.js';
import { appUrl } from './platform-mail.js';

export type SignPaymentProvider = 'stripe' | 'paystack';
export type SignCurrency = 'NGN' | 'USD' | 'GBP' | 'EUR';
export const paymentProviderFor = (currency: string): SignPaymentProvider => currency === 'NGN' ? 'paystack' : 'stripe';

function secret(provider: SignPaymentProvider) {
  const key = process.env[provider === 'stripe' ? 'SIGN_STRIPE_SECRET_KEY' : 'SIGN_PAYSTACK_SECRET_KEY'];
  const mode = process.env.SIGN_PAYMENTS_MODE ?? 'test';
  if (!['test', 'live'].includes(mode)) throw new InvalidInput('payment mode is not configured');
  if (!key || !key.startsWith(mode === 'test' ? 'sk_test_' : 'sk_live_')) throw new InvalidInput(`${provider} ${mode} payments are not configured`);
  return key;
}

export function requirePaymentSetup(tenantId: string, currency: string) {
  if (!['NGN', 'USD', 'GBP', 'EUR'].includes(currency)) throw new InvalidInput('choose NGN, USD, GBP or EUR');
  const allowed = (process.env.SIGN_PAYMENT_TENANT_IDS ?? '').split(',').map((id) => id.trim()).filter(Boolean);
  if (!allowed.includes(tenantId)) throw new InvalidInput('Payment Items are not enabled for this workspace');
  const provider = paymentProviderFor(currency);
  secret(provider);
  return provider;
}

export interface PaymentIntentRequest { id: string; amountMinor: number; currency: SignCurrency; email: string; label: string }
export async function startHostedPayment(provider: SignPaymentProvider, input: PaymentIntentRequest): Promise<{ reference: string; url: string }> {
  const key = secret(provider);
  const returnUrl = `${appUrl()}/sign/payment-complete`;
  if (provider === 'stripe') {
    const form = new URLSearchParams({ mode: 'payment', success_url: returnUrl, cancel_url: returnUrl,
      customer_email: input.email, client_reference_id: input.id,
      'line_items[0][quantity]': '1', 'line_items[0][price_data][currency]': input.currency.toLowerCase(),
      'line_items[0][price_data][unit_amount]': String(input.amountMinor),
      'line_items[0][price_data][product_data][name]': input.label.slice(0, 120),
      'metadata[patform_sign_payment_id]': input.id });
    const response = await fetch('https://api.stripe.com/v1/checkout/sessions', { method: 'POST', headers: {
      authorization: `Bearer ${key}`, 'content-type': 'application/x-www-form-urlencoded', 'idempotency-key': `patform-sign-${input.id}` }, body: form, signal: AbortSignal.timeout(10000) });
    const body = await response.json() as { id?: string; url?: string; error?: { message?: string } };
    if (!response.ok || !body.id || !body.url) throw new InvalidInput(`Stripe could not start checkout: ${body.error?.message ?? response.status}`);
    return { reference: body.id, url: body.url };
  }
  const reference = `patformsign${input.id.replaceAll('-', '')}`;
  const response = await fetch('https://api.paystack.co/transaction/initialize', { method: 'POST', headers: {
    authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({
      email: input.email, amount: String(input.amountMinor), currency: input.currency, reference,
      callback_url: returnUrl, metadata: JSON.stringify({ patform_sign_payment_id: input.id }) }), signal: AbortSignal.timeout(10000) });
  const body = await response.json() as { status?: boolean; message?: string; data?: { reference?: string; authorization_url?: string } };
  if (!response.ok || !body.status || body.data?.reference !== reference || !body.data?.authorization_url)
    throw new InvalidInput(`Paystack could not start checkout: ${body.message ?? response.status}`);
  return { reference, url: body.data.authorization_url };
}

export async function verifyHostedPayment(provider: SignPaymentProvider, reference: string) {
  const key = secret(provider);
  if (provider === 'stripe') {
    if (!/^cs_[A-Za-z0-9_]+$/.test(reference)) throw new InvalidInput('invalid Stripe session');
    const response = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(reference)}`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new InvalidInput('Stripe payment verification is unavailable');
    const b = await response.json() as { id: string; payment_status: string; amount_total: number; currency: string; metadata: { patform_sign_payment_id?: string } };
    return { paid: b.payment_status === 'paid', reference: b.id, amountMinor: b.amount_total, currency: b.currency?.toUpperCase(), paymentId: b.metadata?.patform_sign_payment_id };
  }
  if (!/^patformsign[0-9a-f]{32}$/.test(reference)) throw new InvalidInput('invalid Paystack reference');
  const response = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new InvalidInput('Paystack payment verification is unavailable');
  const b = await response.json() as { status: boolean; data?: { status: string; reference: string; amount: number; currency: string; metadata?: { patform_sign_payment_id?: string } | string } };
  const metadata = typeof b.data?.metadata === 'string' ? JSON.parse(b.data.metadata) as { patform_sign_payment_id?: string } : b.data?.metadata;
  return { paid: b.status && b.data?.status === 'success', reference: b.data?.reference, amountMinor: b.data?.amount, currency: b.data?.currency?.toUpperCase(), paymentId: metadata?.patform_sign_payment_id };
}

/** A valid signature only permits us to reconcile; it never marks a payment paid by itself. */
export function verifyPaymentWebhook(provider: SignPaymentProvider, raw: Buffer, header: string): boolean {
  const key = secret(provider);
  if (provider === 'paystack') {
    const expected = createHmac('sha512', key).update(raw).digest('hex');
    return /^[0-9a-f]{128}$/i.test(header) && timingSafeEqual(Buffer.from(expected), Buffer.from(header.toLowerCase()));
  }
  const parts = Object.fromEntries(header.split(',').map((p) => p.trim().split('=', 2)));
  const time = Number(parts.t);
  if (!Number.isSafeInteger(time) || Math.abs(Date.now() / 1000 - time) > 300) return false;
  const expected = createHmac('sha256', process.env.SIGN_STRIPE_WEBHOOK_SECRET ?? '').update(`${time}.${raw.toString('utf8')}`).digest('hex');
  const supplied = header.split(',').map((p) => p.trim()).filter((p) => p.startsWith('v1=')).map((p) => p.slice(3));
  return Boolean(process.env.SIGN_STRIPE_WEBHOOK_SECRET) && supplied.some((v) => /^[0-9a-f]{64}$/i.test(v) && timingSafeEqual(Buffer.from(expected), Buffer.from(v.toLowerCase())));
}
