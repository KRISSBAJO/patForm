import { logIfEnabled } from './trace.js';

/**
 * Slack and Teams notifications, §21's P2 channel line and §5.1's
 * "SMS, WhatsApp, push, two-way messaging, voice" neighbour.
 *
 * An operational notification is a different message from an email to a
 * respondent, and treating them as one thing is the mistake this file avoids.
 * An email to a new hire is *the process talking to the person it is about*:
 * it carries their name, their start date, their packet. A Slack message is
 * *the process talking to the people running it*: "something needs you, here
 * is the reference, open it".
 *
 * So the payload is deliberately thin. It carries a reference, a state and a
 * link — never answers. Three reasons, in order of how much they matter:
 *
 *  1. A team channel has a different audience from a record. Everybody in
 *     #people-ops can read it, including whoever joined this morning, and the
 *     field-level permissions that govern the record do not reach into Slack.
 *  2. Chat history is retained by a third party on their schedule, not ours.
 *     §12.1's retention and the erasure workflow cannot reach a message
 *     already posted.
 *  3. It survives being wrong. A notification that says "Priya's expense of
 *     £4,200 needs approval" is a disclosure if it goes to the wrong channel;
 *     one that says "EB9FD715 needs approval" is a nuisance.
 *
 * That is a product decision rather than a limitation, and it is the reason
 * this is not simply `send_email` pointed at a webhook URL.
 */

export type ChatKind = 'slack' | 'teams';

export interface ChatMessage {
  /** What happened, in one line. */
  headline: string;
  reference: string;
  processName: string;
  stateName: string;
  /** Where to go and do something about it. */
  url: string | null;
  /** Short label/value pairs. Never answers — see the note above. */
  facts: { label: string; value: string }[];
}

/**
 * Slack's Block Kit, and Teams' MessageCard.
 *
 * Two shapes rather than one lowest common denominator. A plain-text message
 * works in both and looks like a bot nobody configured; the native shapes take
 * a dozen lines each and make the notification something people actually read
 * at nine in the morning.
 */
export function renderSlack(message: ChatMessage): unknown {
  const fields = message.facts.map((f) => ({ type: 'mrkdwn', text: `*${f.label}*\n${f.value}` }));
  return {
    // Fallback text, for notifications and screen readers — a Block Kit
    // message with no `text` is announced as "this content can't be displayed".
    text: `${message.headline} — ${message.reference}`,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `*${message.headline}*` } },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Reference*\n\`${message.reference}\`` },
          { type: 'mrkdwn', text: `*Stage*\n${message.stateName}` },
          ...fields,
        ].slice(0, 10), // Slack refuses more than ten fields in a section.
      },
      ...(message.url
        ? [
            {
              type: 'actions',
              elements: [
                {
                  type: 'button',
                  text: { type: 'plain_text', text: 'Open the record' },
                  url: message.url,
                  style: 'primary',
                },
              ],
            },
          ]
        : []),
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `${message.processName} · Patform` }],
      },
    ],
  };
}

export function renderTeams(message: ChatMessage): unknown {
  return {
    '@type': 'MessageCard',
    '@context': 'https://schema.org/extensions',
    summary: `${message.headline} — ${message.reference}`,
    themeColor: '14663F',
    title: message.headline,
    sections: [
      {
        facts: [
          { name: 'Reference', value: message.reference },
          { name: 'Stage', value: message.stateName },
          ...message.facts.map((f) => ({ name: f.label, value: f.value })),
        ],
        markdown: true,
      },
    ],
    potentialAction: message.url
      ? [{ '@type': 'OpenUri', name: 'Open the record', targets: [{ os: 'default', uri: message.url }] }]
      : [],
  };
}

export function render(kind: ChatKind, message: ChatMessage): unknown {
  return kind === 'teams' ? renderTeams(message) : renderSlack(message);
}

/**
 * Posts one message.
 *
 * Both platforms take an incoming-webhook URL and answer 200 with a short
 * body. Neither signs the request or offers idempotency, so a retry can
 * duplicate a message — which is why delivery goes through the same
 * `action_run` ledger as everything else and is keyed the same way. The retry
 * is ours to not make.
 */
export async function post(
  url: string,
  kind: ChatKind,
  message: ChatMessage,
  doFetch: typeof fetch = fetch,
): Promise<{ ok: boolean; status: number; detail: string; retryable: boolean }> {
  try {
    const response = await doFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(render(kind, message)),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await response.text()).slice(0, 200);

    return {
      ok: response.ok,
      status: response.status,
      detail: body || String(response.status),
      // Slack answers 410 for a revoked webhook and 404 for one that never
      // existed; both are permanent and retrying buries them under attempts.
      retryable: response.status >= 500 || response.status === 429,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      detail: err instanceof Error ? err.message : String(err),
      retryable: true,
    };
  }
}

/**
 * Builds the message from an envelope.
 *
 * The facts come from the envelope's `data`, which the endpoint already opted
 * into field by field — so a channel shows exactly what somebody chose to put
 * in a channel, and adding a field to a process never widens it.
 */
export function messageFor(envelope: {
  event: string;
  instance_id: string;
  process_key: string;
  data: Record<string, unknown>;
}): ChatMessage {
  const facts = Object.entries(envelope.data)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .slice(0, 6)
    .map(([label, value]) => ({
      label: label.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()),
      value: Array.isArray(value) ? value.join(', ') : String(value),
    }));

  const consoleUrl = process.env.CONSOLE_ORIGIN ?? null;

  return {
    // The event name, made readable. "onboarding.started" is what the
    // blueprint calls it; "Onboarding started" is what a channel should say.
    headline: envelope.event
      .replace(/[._]/g, ' ')
      .replace(/^./, (c) => c.toUpperCase()),
    reference: envelope.instance_id.slice(0, 8).toUpperCase(),
    processName: envelope.process_key.replace(/_/g, ' '),
    stateName: '',
    url: consoleUrl ? `${consoleUrl}/console?record=${envelope.instance_id}` : null,
    facts,
  };
}

export function logPosted(kind: ChatKind, id: string, outcome: { ok: boolean; status: number }): void {
  logIfEnabled(outcome.ok ? 'info' : 'warn', 'chat.posted', { destination: id, kind, status: outcome.status });
}
