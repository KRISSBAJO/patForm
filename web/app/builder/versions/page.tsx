import { ProcessPage } from '../ProcessPage';

export const dynamic = 'force-dynamic';

/** Every published version of a process, and what changed in each. */
export default function VersionsPage() {
  return <ProcessPage kind="versions" />;
}
