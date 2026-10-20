import type { Metadata } from 'next';
import '../console/console.css';
import './go.css';
import { Go } from './Go';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Patform — on your phone' };

/** The phone screen. See Go.tsx. */
export default function GoPage() {
  return <Go />;
}
