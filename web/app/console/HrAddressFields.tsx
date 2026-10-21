'use client';

import { COUNTRIES, F } from './sheet';

export type AddressDetail = { line1: string; line2: string; city: string; region: string; postalCode: string; country: string };

const fields = [
  ['line1', 'Street address', 'Street and building number'],
  ['line2', 'Apartment, suite or unit', 'Optional'],
  ['city', 'City or town', ''],
  ['region', 'State, province or region', 'Optional'],
  ['postalCode', 'Postal code', 'Optional where not used'],
] as const;

export function addressToForm(raw: unknown): Record<string, string> {
  const address = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Partial<AddressDetail> : {};
  return Object.fromEntries([...fields.map(([key]) => [`addr_${key}`, address[key] ?? '']), ['addr_country', address.country ?? '']]);
}

export function addressFromForm(form: Record<string, string>): AddressDetail {
  return { line1: form.addr_line1 ?? '', line2: form.addr_line2 ?? '', city: form.addr_city ?? '', region: form.addr_region ?? '', postalCode: form.addr_postalCode ?? '', country: form.addr_country ?? '' };
}

export function HrAddressFields({ form, set }: { form: Record<string, string>; set: (key: string, value: string) => void }) {
  return <>
    {fields.map(([key, label, hint]) => <F key={key} label={label} hint={hint || undefined} wide={key === 'line1' || key === 'line2'}><input autoComplete={key === 'line1' ? 'address-line1' : key === 'line2' ? 'address-line2' : key === 'city' ? 'address-level2' : key === 'region' ? 'address-level1' : 'postal-code'} maxLength={key === 'postalCode' ? 32 : key === 'city' || key === 'region' ? 100 : 160} value={form[`addr_${key}`] ?? ''} onChange={(event) => set(`addr_${key}`, event.target.value)} /></F>)}
    <F label="Country" hint="Required when an address is entered"><select autoComplete="country" value={form.addr_country ?? ''} onChange={(event) => set('addr_country', event.target.value)}><option value="">Choose a country</option>{COUNTRIES.map(([code, name]) => <option key={code} value={code}>{name}</option>)}</select></F>
  </>;
}
