import { Signup } from '../account/Signup';

export const dynamic = 'force-dynamic';

/**
 * The front door. Linked from the landing page's nav and its closing call to
 * action, which until now both pointed at an anchor further down the same
 * page.
 */
export default function SignupPage() {
  return <Signup />;
}
