import { Form } from './Form';

export const dynamic = 'force-dynamic';

export default async function FormPage({ params }: { params: Promise<{ process: string }> }) {
  const { process } = await params;
  return <Form processKey={process} />;
}
