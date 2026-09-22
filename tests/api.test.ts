import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Blueprint } from '../src/blueprint/index.js';
import { decodeCursor, encodeCursor, SCOPE_FOR, toPublicRecord } from '../src/api/public.js';
import { OPENAPI } from '../src/api/openapi.js';
import { parseCsv } from '../src/runtime/import.js';
import { DEFINITIONS, MIN_COHORT } from '../src/runtime/metrics.js';
import { WORKSPACE_GRANTS } from '../src/runtime/policy.js';
import { appUrl, invitationMail, resetMail, verificationMail } from '../src/runtime/platform-mail.js';

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
