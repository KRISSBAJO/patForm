import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

/**
 * The old address of the consent screen, kept so a link already given out
 * still arrives. The screen itself is at /oauth/authorize.
 *
 * The page that lived here drew a consent screen for any request, and its
 * Refuse button sent the browser to whatever redirect address the link
 * carried — unchecked, so a link under this site's name could bounce anybody
 * anywhere. The replacement asks the server first and only redirects to an
 * address the application registered exactly.
 */
export default async function OldAuthorize({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(await searchParams)) {
    for (const one of Array.isArray(v) ? v : v === undefined ? [] : [v]) q.append(k, one);
  }
  redirect(`/oauth/authorize?${q}`);
}
