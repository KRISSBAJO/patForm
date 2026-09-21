import { Console } from './Console';

/**
 * Seats are read from the API at render time. With no sign-in yet, "who am I"
 * is a choice rather than a fact — see the note in the sidebar.
 */
const API = process.env.API_URL ?? 'http://localhost:3310';

const SEED_SEATS = [
  { email: 'joy@example.test' },
  { email: 'priya@example.test' },
  { email: 'sam@example.test' },
  { email: 'ini@example.test' },
  { email: 'dana@example.test' },
];

export const dynamic = 'force-dynamic';

export default async function ConsolePage() {
  let seats: { id: string; name: string; role: string; workspace: string }[] = [];

  try {
    const res = await fetch(`${API}/api/seats`, { cache: 'no-store' });
    if (res.ok) seats = await res.json();
  } catch {
    // The API not being up is worth saying plainly rather than rendering an
    // empty console that looks like an empty workspace.
  }

  if (!seats.length) {
    return (
      <main style={{ padding: '64px 32px', maxWidth: 640, margin: '0 auto', fontFamily: 'var(--font-body)' }}>
        <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 32 }}>The console API is not running</h1>
        <p style={{ marginTop: 16, lineHeight: 1.6, color: 'var(--ink-soft)' }}>
          Start it and seed a workspace, then reload:
        </p>
        <pre
          style={{
            marginTop: 16,
            padding: 16,
            borderRadius: 10,
            background: 'var(--paper-2)',
            border: '1px solid var(--line)',
            fontFamily: 'var(--font-mono)',
            fontSize: 13,
            lineHeight: 1.7,
          }}
        >
          npm run db:up{'\n'}npm run seed{'\n'}npm run api
        </pre>
        <p style={{ marginTop: 16, fontSize: 14, color: 'var(--muted)' }}>
          Expected at {API}. Set API_URL and NEXT_PUBLIC_API_URL if it lives somewhere else.
        </p>
      </main>
    );
  }

  return <Console seats={seats} />;
}
