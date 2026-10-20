'use client';

import { useEffect, type ReactNode } from 'react';

/*
 * A side sheet for creating and editing: slides in from the right, keeps the
 * page behind it, groups fields into titled sections with a line of help,
 * and ends in a sticky footer with the one primary action. Every module's
 * forms use it, so creating a branch feels like creating a meeting.
 */
export function Sheet({ title, eyebrow, subtitle, onClose, footer, children, wide }: { title: string; eyebrow?: string; subtitle?: string; onClose: () => void; footer?: ReactNode; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow; document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, [onClose]);
  return <div className="mx__sheetWrap" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <aside className={`mx__sheet ${wide ? 'mx__sheet--wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
      <header className="mx__sheetHead">
        <div>{eyebrow && <div className="mx__eyebrow">{eyebrow}</div>}<h3>{title}</h3>{subtitle && <p>{subtitle}</p>}</div>
        <button type="button" className="mx__sheetClose" aria-label="Close" onClick={onClose}>×</button>
      </header>
      <div className="mx__sheetBody">{children}</div>
      {footer && <footer className="mx__sheetFoot">{footer}</footer>}
    </aside>
  </div>;
}

export function SheetSection({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return <section className="mx__sheetSection">
    <div className="mx__sheetSectionHead"><strong>{title}</strong>{hint && <small>{hint}</small>}</div>
    <div className="mx__form">{children}</div>
  </section>;
}

export function F({ label, hint, children, wide }: { label: string; hint?: string; children: ReactNode; wide?: boolean }) {
  return <div className={`mx__field ${wide ? 'mx__field--wide' : ''}`}><label>{label}</label>{children}{hint && <small className="mx__tiny">{hint}</small>}</div>;
}

/** A row of choices that behaves like a radio group. */
export function Choice<T extends string>({ value, onChange, options, wide }: { value: T; onChange: (v: T) => void; options: [T, string][]; wide?: boolean }) {
  return <div className={`mx__segs ${wide ? 'mx__segs--wrap' : ''}`} role="radiogroup">{options.map(([k, v]) => <button key={k} type="button" role="radio" aria-checked={value === k} className={`mx__seg ${value === k ? 'is-on' : ''}`} onClick={() => onChange(k)}>{v}</button>)}</div>;
}

/** Reads a chosen file as base64 for the JSON upload endpoints. */
export function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(new Error('could not read the file'));
    r.readAsDataURL(file);
  });
}

export const COUNTRIES: [string, string][] = [['US', 'United States'], ['GB', 'United Kingdom'], ['NG', 'Nigeria'], ['GH', 'Ghana'], ['KE', 'Kenya'], ['ZA', 'South Africa'], ['EG', 'Egypt'], ['AE', 'United Arab Emirates'], ['SA', 'Saudi Arabia'], ['IN', 'India'], ['SG', 'Singapore'], ['AU', 'Australia'], ['CA', 'Canada'], ['DE', 'Germany'], ['FR', 'France'], ['NL', 'Netherlands'], ['IE', 'Ireland'], ['ES', 'Spain'], ['IT', 'Italy'], ['PT', 'Portugal'], ['BR', 'Brazil'], ['MX', 'Mexico'], ['JP', 'Japan'], ['CN', 'China'], ['RW', 'Rwanda'], ['TZ', 'Tanzania'], ['UG', 'Uganda'], ['ET', 'Ethiopia'], ['MA', 'Morocco'], ['SN', 'Senegal'], ['CI', "Côte d'Ivoire"], ['CM', 'Cameroon']];
export const CURRENCIES: [string, string][] = [['USD', 'US dollar'], ['GBP', 'Pound sterling'], ['EUR', 'Euro'], ['NGN', 'Nigerian naira'], ['GHS', 'Ghanaian cedi'], ['KES', 'Kenyan shilling'], ['ZAR', 'South African rand'], ['EGP', 'Egyptian pound'], ['AED', 'UAE dirham'], ['SAR', 'Saudi riyal'], ['INR', 'Indian rupee'], ['SGD', 'Singapore dollar'], ['AUD', 'Australian dollar'], ['CAD', 'Canadian dollar'], ['BRL', 'Brazilian real'], ['MXN', 'Mexican peso'], ['JPY', 'Japanese yen'], ['CNY', 'Chinese yuan'], ['RWF', 'Rwandan franc'], ['TZS', 'Tanzanian shilling'], ['UGX', 'Ugandan shilling'], ['ETB', 'Ethiopian birr'], ['MAD', 'Moroccan dirham'], ['XOF', 'West African CFA franc'], ['XAF', 'Central African CFA franc'], ['CHF', 'Swiss franc']];
export const TIMEZONES = ['UTC', 'Africa/Lagos', 'Africa/Accra', 'Africa/Nairobi', 'Africa/Johannesburg', 'Africa/Cairo', 'Africa/Casablanca', 'Africa/Kigali', 'Africa/Dar_es_Salaam', 'Africa/Addis_Ababa', 'Europe/London', 'Europe/Dublin', 'Europe/Paris', 'Europe/Berlin', 'Europe/Madrid', 'Europe/Lisbon', 'Asia/Dubai', 'Asia/Riyadh', 'Asia/Kolkata', 'Asia/Singapore', 'Asia/Tokyo', 'Asia/Shanghai', 'Australia/Sydney', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Toronto', 'America/Sao_Paulo', 'America/Mexico_City'];
export const WEEKDAYS: [number, string][] = [[1, 'Mon'], [2, 'Tue'], [3, 'Wed'], [4, 'Thu'], [5, 'Fri'], [6, 'Sat'], [7, 'Sun']];
export const money = (v: string | number | null | undefined, c: string) => { const n = Number(v ?? 0); try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: c, maximumFractionDigits: 2 }).format(n); } catch { return `${c} ${n.toLocaleString()}`; } };
