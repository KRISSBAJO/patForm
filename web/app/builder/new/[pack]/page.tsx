import { PackPage } from './PackPage';

export const dynamic = 'force-dynamic';

/**
 * One pack, at its own address.
 *
 * It was a dialog over the catalogue, which meant it could not be linked to,
 * could not be compared with another tab open, and closed on a stray click
 * halfway through reading what a process actually enforces.
 */
export default async function Page({ params }: { params: Promise<{ pack: string }> }) {
  const { pack } = await params;
  return <PackPage packId={pack} />;
}
