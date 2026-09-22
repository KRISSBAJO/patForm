import { VerifyPanel } from '../../account/Forms';

export const dynamic = 'force-dynamic';

export default async function VerifyPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <VerifyPanel token={token} />;
}
