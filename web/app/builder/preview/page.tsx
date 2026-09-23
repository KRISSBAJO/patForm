import { ProcessPage } from '../ProcessPage';

export const dynamic = 'force-dynamic';

/** The form, full width, as a respondent sees it. Any version, or the draft. */
export default function PreviewPage() {
  return <ProcessPage kind="preview" />;
}
