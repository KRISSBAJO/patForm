import { Consent } from './Consent';

export const dynamic = 'force-dynamic';

/**
 * Where an application sends somebody to approve it.
 *
 * The parameters come from the query string because that is what the OAuth
 * authorization-code flow specifies. Nothing here is trusted: the server
 * matches the redirect URI exactly against what the client registered, so a
 * tampered one is refused rather than followed.
 */
export default async function AuthorizePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const q = await searchParams;
  const one = (k: string) => (Array.isArray(q[k]) ? q[k][0] : q[k]) ?? '';

  return (
    <Consent
      clientId={one('client_id')}
      redirectUri={one('redirect_uri')}
      scopes={one('scope').split(' ').filter(Boolean)}
      state={one('state')}
      codeChallenge={one('code_challenge')}
      codeChallengeMethod={one('code_challenge_method') || 'S256'}
    />
  );
}
