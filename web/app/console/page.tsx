import { Console } from './Console';

export const dynamic = 'force-dynamic';

/**
 * The console is a client component: it signs in, holds a session cookie, and
 * every call it makes goes through the same-origin proxy so that cookie is
 * actually sent. Nothing about who you are is decided here.
 */
export default function ConsolePage() {
  return <Console />;
}
