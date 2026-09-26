import { Builder } from '../Builder';

export const dynamic = 'force-dynamic';

/** Every process in the workspace, searchable and in pages. */
export default function ProcessesPage() {
  return <Builder view="processes" />;
}
