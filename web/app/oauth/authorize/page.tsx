import type { Metadata } from 'next';
import { Consent } from './Consent';
import './consent.css';

export const metadata: Metadata = { title: 'Allow access — Patform' };
export const dynamic = 'force-dynamic';

export default function AuthorizePage() {
  return <Consent />;
}
