/**
 * Company registers, for Patform Sign's company signing: is the company
 * real and active, and is each signatory a current officer of it?
 *
 * United Kingdom: Companies House's public API, free, with an API key in
 * COMPANIES_HOUSE_API_KEY. Nigeria: the Corporate Affairs Commission has no
 * public lookup; director checks come through paid identity providers, so
 * NG is a slot (`registerProviders.NG`) to be filled with the provider the
 * customer chooses. A country with no provider gives `available: false`
 * rather than a guess.
 *
 * A match is evidence, not a verdict: an officer listed at the register is
 * strong support; one who is not may still sign under a board resolution or
 * a power of attorney, which is why the sender records the authority.
 */
export interface Officer { name: string; role: string; appointedOn: string | null }
export interface RegisterResult {
  available: boolean; reason?: string;
  country: string; number: string; companyName?: string; status?: string; officers?: Officer[]; checkedAt: string; source?: string;
}
export type RegisterLookup = (number: string, doFetch: typeof fetch) => Promise<RegisterResult>;

export const registerProviders: Record<string, RegisterLookup | undefined> = {
  GB: async (number, doFetch) => {
    const key = process.env.COMPANIES_HOUSE_API_KEY;
    const checkedAt = new Date().toISOString();
    if (!key) return { available: false, reason: 'Companies House is not set up on this server (COMPANIES_HOUSE_API_KEY)', country: 'GB', number, checkedAt };
    const n = number.toUpperCase().padStart(8, '0');
    const headers = { authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}` };
    const base = 'https://api.company-information.service.gov.uk';
    const c = await doFetch(`${base}/company/${encodeURIComponent(n)}`, { headers, signal: AbortSignal.timeout(10_000) });
    if (c.status === 404) return { available: true, country: 'GB', number: n, checkedAt, status: 'not found', officers: [], source: 'Companies House' };
    if (c.status === 401) return { available: false, reason: 'Companies House refused the API key', country: 'GB', number: n, checkedAt };
    if (!c.ok) throw new Error(`Companies House answered HTTP ${c.status}`);
    const company = await c.json() as { company_name: string; company_status: string };
    const officers: Officer[] = [];
    for (let start = 0; ; start += 100) {
      const o = await doFetch(`${base}/company/${encodeURIComponent(n)}/officers?items_per_page=100&start_index=${start}`, { headers, signal: AbortSignal.timeout(10_000) });
      if (!o.ok) return { available: false, reason: `Companies House officer lookup failed (HTTP ${o.status})`, country: 'GB', number: n, checkedAt };
      const page = await o.json() as { items?: { name: string; officer_role: string; appointed_on?: string; resigned_on?: string }[]; total_results?: number };
      const items = page.items ?? [];
      officers.push(...items.filter((x) => !x.resigned_on).map((x) => ({ name: x.name, role: x.officer_role.replace(/-/g, ' '), appointedOn: x.appointed_on ?? null })));
      if (items.length < 100 || (page.total_results !== undefined && start + items.length >= page.total_results)) break;
    }
    return { available: true, country: 'GB', number: n, companyName: company.company_name, status: company.company_status, officers, checkedAt, source: 'Companies House' };
  },
  NG: async (number) => ({ available: false, reason: 'no register provider is set up for Nigeria (CAC checks come through a paid identity provider)', country: 'NG', number, checkedAt: new Date().toISOString() }),
};
/** Tests swap a provider in. */
export function setRegisterProviderForTests(country: string, fn: RegisterLookup | undefined) { registerProviders[country] = fn; }

export async function lookupCompany(country: string, number: string, doFetch: typeof fetch = fetch): Promise<RegisterResult> {
  const cc = country.toUpperCase();
  const fn = registerProviders[cc];
  if (!fn) return { available: false, reason: `no register provider for ${cc}`, country: cc, number, checkedAt: new Date().toISOString() };
  return fn(number.trim(), doFetch);
}

/** Lower-case words, with titles dropped; a single letter is kept, as an initial. */
const tokens = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z\s,]/g, ' ').split(/[\s,]+/).filter((t) => t.length > 0 && !['mr', 'mrs', 'ms', 'dr', 'sir', 'the'].includes(t));

/**
 * Registers write "SURNAME, Forename Middle". A signatory matches an officer
 * when the surnames agree and the first forenames agree (or one is the
 * other's initial). Middle names are not required, since people leave them
 * out when signing.
 */
export function matchOfficer(signerName: string, officers: Officer[]): Officer | null {
  const s = tokens(signerName);
  if (s.length < 2) return null;
  const sFirst = s[0]!; const sLast = s[s.length - 1]!;
  for (const o of officers) {
    const comma = o.name.indexOf(',');
    const surnames = tokens(comma >= 0 ? o.name.slice(0, comma) : o.name.split(/\s+/).slice(-1).join(' '));
    const forenames = tokens(comma >= 0 ? o.name.slice(comma + 1) : o.name.split(/\s+/).slice(0, -1).join(' '));
    const surnameOk = surnames.includes(sLast);
    const firstOk = forenames.some((f) => f === sFirst || f[0] === sFirst[0] && (f.length === 1 || sFirst.length === 1));
    if (surnameOk && firstOk) return o;
  }
  return null;
}
