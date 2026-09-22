import { Builder } from './Builder';

export const dynamic = 'force-dynamic';

/**
 * The builder is a client component for the same reason the console is: it
 * holds a session cookie and every call it makes goes through the same-origin
 * proxy so that cookie is actually sent.
 */
export default function BuilderPage() {
  return <Builder />;
}
