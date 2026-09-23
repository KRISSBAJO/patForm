import { ProcessPage } from '../ProcessPage';

export const dynamic = 'force-dynamic';

/** A process's scenarios, run against the real engine. Any version, or the draft. */
export default function TestsPage() {
  return <ProcessPage kind="tests" />;
}
