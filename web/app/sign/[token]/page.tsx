import { SignPage } from './SignPage';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Sign a document', robots: { index: false, follow: false }, referrer: 'no-referrer' };

export default async function Page({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <SignPage token={token} />;
}
