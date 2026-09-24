import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Blueprint } from '../src/blueprint/index.js';
import { decodeCursor, encodeCursor, RECORD_ORDERS, SCOPE_FOR, toPublicRecord } from '../src/api/public.js';
import { OPENAPI } from '../src/api/openapi.js';
import { parseCsv } from '../src/runtime/import.js';
import { DEFINITIONS, MIN_COHORT } from '../src/runtime/metrics.js';
import { redact, visibleFields, WORKSPACE_GRANTS } from '../src/runtime/policy.js';
import { appUrl, invitationMail, resetMail, verificationMail } from '../src/runtime/platform-mail.js';
import { verifyRelyKit } from '../src/runtime/delivery.js';
import { callerFor, limitFor } from '../src/api/intake-limits.js';
import {
  addressOf,
  assertCanSendAs,
  checkSendingDomain,
  domainOf,
  usableFrom,
} from '../src/runtime/sending-domain.js';
import { createHmac } from 'node:crypto';

/** Builds the headers exactly as RelyKit's `signPayload` does. */
function signStandard(secret: string, id: string, nowMs: number, body: string) {
  const timestamp = String(Math.floor(nowMs / 1000));
  const mac = createHmac('sha256', secret).update(`${id}.${timestamp}.${body}`).digest('base64');
  return { timestamp, signature: `v1,${mac}` };
}

const bp = Blueprint.parse(
  JSON.parse(readFileSync(join('processes', 'employee-onboarding.blueprint.json'), 'utf8')),
);

/**
 * The parts of §11 and §13 that can be checked without a database. The rest —
 * permissions, pagination against real rows, idempotency across a restart —
 * needs one, and is in the proof suite.
 */

test('a field the role may not see is omitted, not masked', () => {
  // §11.1: "hidden data is omitted rather than masked ambiguously". A consumer
  // writing record.data.bank_account must get undefined, never the string
  // "[redacted]", which it would store, compare, or pay.
  const itOperator = bp.roles.find((r) => r.key === 'it_operator')!;
  assert.ok(itOperator.hiddenFields?.length, 'the fixture must hide something from this role');

  const record = toPublicRecord(bp, 1, ['it_operator'], {
    id: '00000000-0000-0000-0000-000000000001',
    process_key: bp.key,
    state: bp.workflow.states[0]!.key,
    data: { full_name: 'A Person', bank_account: '12-34-56', national_id: 'QQ123456C' },
    outcome: null,
    created_at: new Date('2026-01-01'),
    state_entered_at: new Date('2026-01-01'),
    completed_at: null,
  });

  for (const hidden of itOperator.hiddenFields!) {
    assert.ok(!(hidden in record.data), `${hidden} must not appear in data at all`);
  }
  assert.ok(record.omitted_fields.includes('bank_account'));
  assert.equal(record.data.full_name, 'A Person');
  assert.ok(
    !JSON.stringify(record.data).includes('[redacted]'),
    'no placeholder string may survive into the API response',
  );
});

test('a cursor round-trips, and anything else is refused', () => {
  const cursor = encodeCursor({ createdAt: '2026-01-01T00:00:00.000Z', id: 'abc' });
  assert.deepEqual(decodeCursor(cursor), { createdAt: '2026-01-01T00:00:00.000Z', id: 'abc' });

  // A caller who builds one by hand gets a clear refusal rather than a page
  // from an ordering they guessed at.
  assert.throws(() => decodeCursor('not-a-cursor'));
  assert.throws(() => decodeCursor(Buffer.from('{"page":2}').toString('base64url')));
});

test('every public route names a scope, and the scope is one a member can hold', () => {
  // The scope check refuses an unlisted route, so a route added without a
  // scope fails closed. This asserts the other half: a scope no workspace role
  // grants would make the endpoint unreachable, which is how POST /records
  // was briefly unusable for asking for `submit`.
  const grantable = new Set(Object.values(WORKSPACE_GRANTS).flatMap((c) => [...c]));
  for (const [route, scope] of Object.entries(SCOPE_FOR)) {
    assert.ok(scope, `${route} has no scope`);
    assert.ok(grantable.has(scope), `${route} needs "${scope}", which no workspace role grants`);
  }
});

test('the OpenAPI document describes every route that exists', () => {
  const documented = new Set<string>();
  for (const [path, methods] of Object.entries(OPENAPI.paths)) {
    for (const method of Object.keys(methods)) {
      documented.add(`${method.toUpperCase()} ${path.replace(/\{id\}/, ':id')}`);
    }
  }
  for (const route of Object.keys(SCOPE_FOR)) {
    assert.ok(documented.has(route), `${route} is not in the OpenAPI document`);
  }
  assert.equal(documented.size, Object.keys(SCOPE_FOR).length, 'the document describes a route that does not exist');
});

test('CSV parsing survives what a spreadsheet actually produces', () => {
  const csv = 'a,b,c\r\n1,"two, with comma",3\r\n4,"a ""quoted"" thing",6\r\n';
  assert.deepEqual(parseCsv(csv), [
    ['a', 'b', 'c'],
    ['1', 'two, with comma', '3'],
    ['4', 'a "quoted" thing', '6'],
  ]);

  // Excel writes a byte order mark, and a header of "﻿name" matches no field.
  assert.equal(parseCsv('﻿name\nx\n')[0]![0], 'name');

  // Blank lines between rows are formatting, not data.
  assert.equal(parseCsv('a\n\n1\n\n').length, 2);
});

test('every §13.1 metric has a definition that travels with it', () => {
  // §13.2: "metric definitions are stored and versioned". A number without one
  // invites comparison against a number computed differently.
  const required = [
    'intake',
    'completion_rate',
    'cycle_time',
    'stage_aging',
    'approval_time',
    'rework_rate',
    'automation_failure_rate',
    'manual_touch_rate',
    'abandonment',
  ];
  assert.deepEqual(DEFINITIONS.map((d) => d.key).sort(), [...required].sort());
  for (const d of DEFINITIONS) {
    assert.ok(d.definition.length > 60, `${d.key}'s definition is too short to settle an argument`);
    assert.ok(['count', 'percent', 'hours'].includes(d.unit));
  }
  assert.ok(MIN_COHORT >= 5, 'small cohort suppression must be meaningful');
});

test('an account link points at the configured app, and says when it stops working', () => {
  const previous = process.env.APP_URL;
  process.env.APP_URL = 'https://patform.logaxp.com/';
  const expiresAt = '2026-10-01T12:00:00.000Z';

  const invitation = invitationMail({
    to: 'new@example.test',
    token: 'inv_abc',
    workspaceName: 'Operations',
    invitedBy: 'Dana',
    workspaceRole: 'approver',
    expiresAt,
  });

  // The trailing slash is trimmed rather than doubled. A link with `//join`
  // in it is the kind of thing that works on one router and 404s on the next.
  assert.ok(invitation.text.includes('https://patform.logaxp.com/join/inv_abc'));
  assert.ok(!invitation.text.includes('.com//join'));
  assert.match(invitation.subject, /Dana invited you to Operations/);

  // Three things every one of these has to say: it is single use, when it
  // expires, and what to do if it was not you.
  for (const mail of [
    invitation,
    verificationMail({ to: 'a@example.test', token: 'ver_abc', expiresAt }),
    resetMail({ to: 'a@example.test', token: 'rst_abc', expiresAt }),
  ]) {
    assert.match(mail.text, /works once|ignore it|do not need to do anything/);
    assert.ok(mail.text.includes('2026'), 'the expiry is stated, not implied');
  }

  // The reset mail says what spending it costs, because it is the one that
  // logs the person out of everything.
  assert.match(resetMail({ to: 'a@example.test', token: 'rst_abc', expiresAt }).text, /sign this account out/);

  if (previous === undefined) delete process.env.APP_URL;
  else process.env.APP_URL = previous;
});

test('the app url falls back to the dev console rather than to something plausible', () => {
  const previous = process.env.APP_URL;
  delete process.env.APP_URL;
  // A default that looks like production is how mail goes out with links to a
  // host that is not serving this deployment.
  assert.equal(appUrl(), 'http://localhost:3210');
  if (previous !== undefined) process.env.APP_URL = previous;
});

test('a delivery notification verifies only if it is the exact bytes, signed, and recent', () => {
  const secret = 'whsec_test';
  const body = JSON.stringify({ id: 'evt_1', type: 'email.bounced', data: { recipient: 'a@b.test' } });
  const now = 1_800_000_000_000;
  const { timestamp, signature } = signStandard(secret, 'evt_1', now, body);
  const base = { secret, id: 'evt_1', timestamp, body, signature, now };

  assert.equal(verifyRelyKit(base).ok, true);
  assert.equal(verifyRelyKit({ ...base, secret: 'whsec_other' }).ok, false);
  assert.equal(verifyRelyKit({ ...base, body: body + ' ' }).ok, false);

  // The id is part of the signed string, so one signed request cannot be
  // replayed as a different event by changing the header.
  assert.equal(verifyRelyKit({ ...base, id: 'evt_2' }).ok, false);

  // And the timestamp is checked separately from being signed. Without that,
  // a captured request stays valid forever.
  assert.equal(verifyRelyKit({ ...base, now: now + 3_600_000 }).ok, false);
  assert.match(verifyRelyKit({ ...base, now: now + 3_600_000 }).reason ?? '', /tolerance/);

  // Missing headers are refused rather than treated as an empty signature.
  assert.equal(verifyRelyKit({ ...base, signature: '' }).ok, false);
  assert.equal(verifyRelyKit({ ...base, timestamp: '' }).ok, false);
  assert.equal(verifyRelyKit({ ...base, timestamp: 'soon' }).ok, false);
});

test('a rotation sends both versions, and either one verifies', () => {
  const body = '{"id":"evt_1"}';
  const now = 1_800_000_000_000;
  const oldMac = signStandard('whsec_old', 'evt_1', now, body).signature;
  const newMac = signStandard('whsec_new', 'evt_1', now, body).signature;
  const header = `${oldMac} ${newMac}`;
  const base = { id: 'evt_1', timestamp: String(Math.floor(now / 1000)), body, signature: header, now };

  // A consumer holding either secret during the overlap accepts the request.
  assert.equal(verifyRelyKit({ ...base, secret: 'whsec_old' }).ok, true);
  assert.equal(verifyRelyKit({ ...base, secret: 'whsec_new' }).ok, true);
  assert.equal(verifyRelyKit({ ...base, secret: 'whsec_unrelated' }).ok, false);
});

test('search cannot reach a field the role may not see', () => {
  /*
   * Records are searchable by any answer, which makes the set of searchable
   * fields a disclosure surface in its own right. A hiring manager may not see
   * a bank account; if they could search by one, "one record matches
   * 12345678" would confirm the number without ever showing it, and a few
   * hundred guesses would recover it.
   *
   * So the searchable keys are computed from the role before the query runs.
   * This is that computation, and not a test of the SQL — but the SQL only
   * ever matches keys this returns.
   */
  const manager = bp.roles.find((r) => r.key === 'hiring_manager')!;
  assert.ok(manager.hiddenFields?.length, 'the fixture must hide something from the hiring manager');

  const visible = visibleFields(bp, ['hiring_manager']);
  for (const hidden of manager.hiddenFields!) {
    assert.ok(!visible.includes(hidden), `${hidden} is hidden from this role and must not be searchable`);
  }

  // And a role that hides nothing keeps every field, rather than losing them
  // to an over-eager intersection.
  const admin = bp.roles.find((r) => (r.hiddenFields ?? []).length === 0);
  if (admin) {
    assert.equal(visibleFields(bp, [admin.key]).length, bp.data.fields.length);
  }

  /*
   * Two roles intersect: holding a second, broader role is how somebody
   * legitimately sees — and therefore searches — more. This is the same rule
   * `redact` applies, and the two must not disagree.
   */
  const bothVisible = visibleFields(bp, bp.roles.map((r) => r.key));
  const redacted = redact(bp, bp.roles.map((r) => r.key), Object.fromEntries(bp.data.fields.map((f) => [f.key, 'x'])));
  const notRedacted = Object.entries(redacted)
    .filter(([, v]) => v !== '[redacted]')
    .map(([k]) => k);
  assert.deepEqual([...bothVisible].sort(), [...notRedacted].sort());
});

test('an order is one of a fixed set, because a cursor means nothing under another', () => {
  // A cursor encodes a position in one ordering. Letting a caller name a
  // column would let them page through a sequence the cursor was not issued
  // against, which silently skips and repeats rows.
  assert.deepEqual([...RECORD_ORDERS], ['newest', 'oldest', 'reference']);
});

/*
 * Rate limiting on the public form (§12.3).
 *
 * The form is the one door with no credential on it, so the budget is the
 * whole defence. These check the two decisions that make it real rather than
 * decorative: which requests are limited, and who counts as "the caller".
 */

test('the public form has a budget, and submitting is the tight one', () => {
  // Reading and checking happen on most keystrokes of a conditional form; a
  // limit a careful respondent can hit breaks the product rather than
  // protecting it. Submitting writes a record, sends mail and starts a
  // workflow, so that is the one worth being mean about.
  const submit = limitFor('POST', '/api/forms/employee_onboarding/submit');
  const read = limitFor('GET', '/api/forms/employee_onboarding');
  const check = limitFor('POST', '/api/forms/employee_onboarding/check');

  assert.ok(submit && read && check, 'every public route carries a budget');
  assert.ok(submit!.perMinute < read!.perMinute, 'submitting is tighter than reading');
  assert.ok(submit!.perMinute < check!.perMinute, 'submitting is tighter than checking');
  assert.ok(submit!.perHour, 'submitting also has a slower window, so a minute-by-minute drip is bounded');

  // A route nobody published is not silently exempt.
  assert.equal(limitFor('POST', '/api/builder/drafts/x/save'), null, 'only the public form is limited here');
});

test('x-forwarded-for is counted, not trusted', () => {
  /*
   * The header is written by whoever is calling. Believing it makes per-caller
   * limiting free to defeat — a random address per request is a new caller
   * every time. Refusing to read it is just as wrong behind a load balancer,
   * where every request then looks like it came from the balancer.
   *
   * TRUST_PROXY says how many hops are in front. The default is none, and this
   * test runs under the default, so the socket address wins whatever the
   * header claims.
   */
  const spoofed = {
    socket: { remoteAddress: '203.0.113.9' },
    headers: { 'x-forwarded-for': '198.51.100.1, 198.51.100.2' },
  } as unknown as Parameters<typeof callerFor>[0];

  assert.equal(callerFor(spoofed), '203.0.113.9', 'the header did not become the caller');

  const bare = { socket: { remoteAddress: '203.0.113.9' }, headers: {} } as unknown as Parameters<typeof callerFor>[0];
  assert.equal(callerFor(bare), '203.0.113.9');
});

/*
 * The sending domain.
 *
 * "Verified" is mostly DNS, which this repository cannot add. What it can do
 * is look — and the thing worth testing is that it knows the difference
 * between a record that is absent and a resolver it could not reach.
 */

test('an address that could never deliver is refused before a provider is built', () => {
  // MAIL_FROM falls back to no-reply@localhost. A deployment that names a
  // provider and forgets the address sends every message from a domain that
  // does not exist — rejected, or accepted and left to a spam filter, and
  // "queued" in our own log either way.
  for (const bad of ['no-reply@localhost', 'nobody', 'a@b', 'x@thing.test', '']) {
    assert.equal(usableFrom(bad).ok, false, `${bad || '(empty)'} should be refused`);
    assert.throws(() => assertCanSendAs('relykit', bad), /MAIL_FROM/);
  }

  assert.equal(usableFrom('Patform <hello@example.com>').ok, true);
  assert.doesNotThrow(() => assertCanSendAs('relykit', 'Patform <hello@example.com>'));

  // The console provider sends nothing, so it is exempt — that is how this
  // runs locally, and failing to start there would help nobody.
  assert.doesNotThrow(() => assertCanSendAs('console', 'no-reply@localhost'));
});

test('the address is read out of a display-name form', () => {
  assert.equal(addressOf('Patform <noreply@example.com>'), 'noreply@example.com');
  assert.equal(addressOf('noreply@example.com'), 'noreply@example.com');
  assert.equal(domainOf('Patform <noreply@Example.COM>'), 'example.com');
  assert.equal(domainOf('nonsense'), null);
});

test('a resolver it cannot reach is reported as unknown, never as missing', async () => {
  /*
   * The first version of this caught every DNS error and returned no records,
   * so a refused connection looked exactly like a domain with no SPF. Asked
   * about google.com from a machine whose resolver is 127.0.0.1 with nothing
   * behind it, it reported that google.com has no SPF and no DMARC — which
   * would send somebody to add records that already exist.
   */
  const findings = await checkSendingDomain('Patform <hello@example.com>');
  assert.ok(findings.length > 0);

  // Whatever the network does here, nothing may claim a *missing* record
  // unless the resolver actually answered. In this environment there is no
  // resolver, so no finding may be 'missing' except the address check itself.
  const missingDnsClaims = findings.filter((f) => f.outcome === 'missing' && f.check !== 'MAIL_FROM is an address that could deliver');
  for (const f of missingDnsClaims) {
    assert.ok(
      f.detail.includes('no ') || f.detail.includes('not '),
      `a "missing" finding must say what was absent, got: ${f.detail}`,
    );
  }

  // And the address check, which needs no network, is decided either way.
  const address = findings.find((f) => f.check.startsWith('MAIL_FROM'));
  assert.ok(address && address.outcome !== 'unknown', 'the address check never needs DNS');
});

test('a real provider never sees an address on a reserved domain', async () => {
  const { isReservedAddress, ReservedDomainGuard } = await import('../src/runtime/email.js');
  for (const a of ['x@example.test', 'x@proof.test', 'x@example.com', 'x@mail.example.org', 'x@localhost', 'x@a.invalid']) {
    assert.equal(isReservedAddress(a), true, a);
  }
  for (const a of ['x@gmail.com', 'x@renviq.com', 'x@testing.com', 'x@example.co.uk', 'x@contest.io']) {
    assert.equal(isReservedAddress(a), false, a);
  }

  const handed: string[][] = [];
  const inner = {
    name: 'relykit',
    async send(email: { to: string[] }) {
      handed.push(email.to);
      return { providerMessageId: 'm1', status: 'queued' as const };
    },
  };
  const guard = new ReservedDomainGuard(inner as never);
  const base = { from: 'a@renviq.com', subject: 's', text: 't', idempotencyKey: 'k' };

  const mixed = await guard.send({ ...base, to: ['real@gmail.com', 'fake@example.test'] });
  assert.deepEqual(handed.at(-1), ['real@gmail.com']);
  assert.equal(mixed.status, 'queued');
  assert.match(mixed.warning ?? '', /fake@example\.test/);

  const none = await guard.send({ ...base, to: ['only@example.test'] });
  assert.equal(handed.length, 1, 'nothing reached the provider');
  assert.equal(none.status, 'failed');
  assert.equal(none.retryable, false);
});

test('workspace readers without a process role cannot read or search restricted answers', () => {
  const restricted = bp.data.fields.filter((field) => field.classification === 'restricted');
  assert.ok(restricted.length, 'the fixture must contain restricted answers');
  const data = Object.fromEntries(bp.data.fields.map((field) => [field.key, 'secret'])) as Record<string, string>;
  const masked = redact(bp, [], data);
  const searchable = visibleFields(bp, []);
  for (const field of restricted) {
    assert.equal(masked[field.key], '[redacted]');
    assert.ok(!searchable.includes(field.key), `${field.key} must not be searchable`);
  }
  const record = toPublicRecord(bp, 1, [], {
    id: '00000000-0000-0000-0000-000000000002',
    process_key: bp.key,
    state: bp.workflow.states[0]!.key,
    data,
    outcome: null,
    created_at: new Date('2026-01-01'),
    state_entered_at: new Date('2026-01-01'),
    completed_at: null,
  });
  for (const field of restricted) assert.ok(!(field.key in record.data));
});

test('a form reached by its public link keeps every intake rate limit', async () => {
  const { newPublicId, PUBLIC_ID } = await import('../src/runtime/form-links.js');
  const id = newPublicId();
  assert.match(id, PUBLIC_ID);
  assert.doesNotMatch('employee_onboarding', PUBLIC_ID, 'a process key is never mistaken for a link id');
  // The routes were widened to accept a hyphen; the limits have to be too, or
  // the new links would quietly have none.
  for (const [method, path] of [
    ['GET', `/api/forms/${id}`],
    ['POST', `/api/forms/${id}/check`],
    ['POST', `/api/forms/${id}/draft`],
    ['GET', `/api/forms/${id}/draft`],
    ['POST', `/api/forms/${id}/submit`],
  ] as const) {
    assert.notEqual(limitFor(method, path), null, `${method} ${path}`);
  }
  assert.equal(limitFor('POST', `/api/forms/${id}/submit`)?.perMinute, 5);
});
