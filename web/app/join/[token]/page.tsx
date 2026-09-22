import { JoinForm } from '../../account/Forms';

export const dynamic = 'force-dynamic';

/**
 * Where an invitation email lands.
 *
 * The token is in the path rather than the query string because query strings
 * are the part of a URL that ends up in referrer headers, proxy logs and
 * analytics — and this one is a credential until it is spent.
 */
export default async function JoinPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <JoinForm token={token} />;
}
