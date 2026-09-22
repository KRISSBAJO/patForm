import { Gallery } from './Gallery';

export const dynamic = 'force-dynamic';

/**
 * The catalogue, as a page.
 *
 * It was a dialog, which stopped working the moment there were more than a
 * handful of packs: a modal cannot be linked to, cannot be filtered without
 * feeling cramped, and closes if you look away.
 */
export default function NewProcessPage() {
  return <Gallery />;
}
