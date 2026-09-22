import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Blueprint } from '../src/blueprint/index.js';
import { describeContents } from '../src/runtime/packs.js';
import { messageFor, renderSlack, renderTeams } from '../src/runtime/chat.js';
import { sign, verify } from '../src/runtime/webhooks.js';

const bp = Blueprint.parse(
  JSON.parse(readFileSync(join('processes', 'employee-onboarding.blueprint.json'), 'utf8')),
);

test('a pack describes itself from the blueprint, not from a written list', () => {
  const contents = describeContents(bp);

  // Every count is derivable, so a card cannot claim something installing
  // does not give you.
  assert.equal(contents.fields, bp.data.fields.length);
  assert.equal(contents.states, bp.workflow.states.length);
  assert.equal(contents.approvals, bp.workflow.approvals.length);
  assert.equal(contents.emails, bp.communications.email.length);
  assert.equal(contents.scenarios, bp.tests.length);

  // §1.2's distinction: a pack carries policy defaults, which is the part a
  // form template has no way to hold.
  assert.equal(contents.policy.sensitivityCeiling, bp.intent.sensitivityCeiling);
  assert.equal(contents.policy.retentionDays, bp.intent.retentionDays ?? null);
  assert.ok(contents.policy.restrictedFields > 0, 'the reference process holds restricted fields');
  assert.ok(contents.policy.fieldsHiddenFromSomeone > 0, 'and hides some of them from some roles');
});

test('a webhook signature verifies, and will not verify a changed body or a stale one', () => {
  const body = JSON.stringify({ event: 'onboarding.started', instance_id: 'abc' });
  const now = 1_800_000_000;
  const header = sign(body, ['whsec_test'], now);

  assert.equal(verify(header, body, 'whsec_test', now).ok, true);
  assert.equal(verify(header, body, 'whsec_other', now).ok, false);
  assert.equal(verify(header, body + ' ', 'whsec_test', now).ok, false);

  // The timestamp is inside the signed string, so a captured request cannot be
  // replayed later.
  assert.equal(verify(header, body, 'whsec_test', now + 3600).ok, false);
  assert.match(verify(header, body, 'whsec_test', now + 3600).reason ?? '', /tolerance/);
});

test('a rotation signs with both secrets, so either verifies', () => {
  const body = '{"x":1}';
  const now = 1_800_000_000;
  const header = sign(body, ['new_secret', 'old_secret'], now);

  assert.equal((header.match(/v1=/g) ?? []).length, 2);
  assert.equal(verify(header, body, 'old_secret', now).ok, true, 'a consumer not yet redeployed still works');
  assert.equal(verify(header, body, 'new_secret', now).ok, true, 'and one that has, works too');
  assert.equal(verify(header, body, 'unrelated', now).ok, false);
});

test('a chat card carries a reference and only the fields the endpoint opted into', () => {
  const envelope = {
    event: 'onboarding.started',
    instance_id: '6fa0a296-0000-0000-0000-000000000000',
    process_key: 'employee_onboarding',
    data: { job_title: 'Analyst', department: 'operations', start_date: '2026-12-25' },
  };
  const message = messageFor(envelope);

  assert.equal(message.headline, 'Onboarding started');
  assert.equal(message.reference, '6FA0A296');
  // Whatever was not in `data` cannot appear, which is how a team channel
  // stays free of answers the record's permissions govern.
  const rendered = JSON.stringify(renderSlack(message));
  assert.ok(!rendered.includes('bank'), 'no field the endpoint did not opt into');
  assert.ok(!rendered.includes('national'), 'and none it was never sent');

  const slack = renderSlack(message) as { text: string; blocks: { type: string; fields?: unknown[] }[] };
  // Slack announces a Block Kit message with no fallback text as
  // "this content can't be displayed".
  assert.ok(slack.text.length > 0);
  assert.ok(slack.blocks.length > 0);
  const section = slack.blocks.find((b) => b.fields);
  assert.ok(section && section.fields!.length <= 10, 'Slack refuses more than ten fields in a section');

  const teams = renderTeams(message) as { '@type': string; summary: string; sections: unknown[] };
  assert.equal(teams['@type'], 'MessageCard');
  assert.ok(teams.summary.length > 0);
});

test('a chat card truncates rather than sending an unbounded number of fields', () => {
  const data: Record<string, string> = {};
  for (let i = 0; i < 40; i++) data[`field_${i}`] = `value ${i}`;
  const message = messageFor({
    event: 'x.happened',
    instance_id: '00000000-0000-0000-0000-000000000000',
    process_key: 'p',
    data,
  });
  const slack = renderSlack(message) as { blocks: { fields?: unknown[] }[] };
  const section = slack.blocks.find((b) => b.fields);
  assert.ok(section!.fields!.length <= 10, 'Slack would refuse the whole message otherwise');
});
