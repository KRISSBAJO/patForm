import { InvalidInput } from './errors.js';

/** Postal addresses are stored as fields, while a formatted line remains for older records and exports. */
export type HrAddress = {
  line1: string;
  line2: string;
  city: string;
  region: string;
  postalCode: string;
  country: string;
};

const limits: Record<keyof HrAddress, number> = {
  line1: 160, line2: 160, city: 100, region: 100, postalCode: 32, country: 2,
};

export function parseHrAddress(raw: unknown): HrAddress | null {
  if (raw === null) return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new InvalidInput('address must contain separate address fields');
  const input = raw as Record<string, unknown>;
  const address = {} as HrAddress;
  for (const key of Object.keys(limits) as (keyof HrAddress)[]) {
    const value = input[key];
    if (value !== undefined && typeof value !== 'string') throw new InvalidInput(`${key} must be text`);
    const clean = (value ?? '').toString().trim().replace(/\s+/g, ' ');
    if (clean.length > limits[key]) throw new InvalidInput(`${key} is too long`);
    address[key] = clean;
  }
  if (Object.keys(input).some((key) => !(key in limits))) throw new InvalidInput('address contains an unknown field');
  if (Object.values(address).every((value) => !value)) return null;
  if (!address.line1 || !address.city || !address.country) throw new InvalidInput('address needs line 1, city and country');
  address.country = address.country.toUpperCase();
  if (!/^[A-Z]{2}$/.test(address.country)) throw new InvalidInput('choose a country for the address');
  return address;
}

export function formatHrAddress(address: HrAddress | null): string | null {
  if (!address) return null;
  return [address.line1, address.line2, address.city, address.region, address.postalCode, address.country].filter(Boolean).join(', ');
}
