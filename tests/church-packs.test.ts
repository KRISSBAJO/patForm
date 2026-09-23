import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Blueprint } from '../src/blueprint/index.js';
import { evaluate } from '../src/blueprint/common.js';
import { CATALOGUE } from '../src/packs/catalogue.js';
import { buildBlueprint } from '../src/packs/generate.js';
import { describeContents } from '../src/runtime/packs.js';

function pack(key: string) {
  const spec = CATALOGUE.find((item) => item.key === key);
  assert.ok(spec, `missing ${key}`);
  return Blueprint.parse(buildBlueprint(spec));
}

test('contact choices stop every automatic submitter email, including after the decision', () => {
  const cases = [
    ['church_connect_card', { contact_choice: 'no_contact' }, { contact_choice: 'email' }],
    ['church_connect_card', { contact_choice: 'phone' }, { contact_choice: 'email' }],
    ['pastoral_care', { safe_contact_method: 'do_not_contact_yet' }, { safe_contact_method: 'email' }],
    ['pastoral_care', { safe_contact_method: 'phone' }, { safe_contact_method: 'email' }],
    ['benevolence_request', { contact_preference: 'phone' }, { contact_preference: 'email' }],
  ] as const;

  for (const [key, quiet, email] of cases) {
    const bp = pack(key);
    const toSubmitter = bp.communications.email.filter((template) =>
      template.to.some((recipient) => 'submitter' in recipient && recipient.submitter),
    );
    assert.ok(toSubmitter.length >= 4, `${key} must cover every outcome`);
    for (const template of toSubmitter) {
      assert.ok(template.skipWhen, `${key}/${template.key} lacks a contact check`);
      assert.equal(evaluate(template.skipWhen, { answers: quiet, now: new Date() }), true);
      assert.equal(evaluate(template.skipWhen, { answers: email, now: new Date() }), false);
    }
  }
});

test('church site report has independent review and excludes pastor family profiling', () => {
  const bp = pack('church_site_report');
  assert.deepEqual(bp.workflow.approvals.map((approval) => approval.approvers), [
    [{ role: 'regional_lead' }], [{ role: 'finance_reviewer' }],
  ]);
  const keys = bp.data.fields.map((field) => field.key);
  for (const forbidden of ['marital_status', 'pastor_date_of_birth', 'children_ages']) {
    assert.ok(!keys.includes(forbidden));
  }
  for (const needed of ['site_name', 'reporting_role', 'period_from', 'period_to', 'average_attendance', 'period_income']) {
    assert.ok(keys.includes(needed), `${needed} absent`);
  }
});

test('Church retention follows the process, not a blanket category minimum', () => {
  assert.equal(pack('church_connect_card').intent.retentionDays, 365);
  assert.equal(pack('prayer_request').intent.retentionDays, 365);
  assert.equal(pack('pastoral_care').intent.retentionDays, 365);
  assert.equal(pack('baptism_request').intent.retentionDays, 1825);
  assert.equal(pack('church_site_report').intent.retentionDays, 2555);
});

test('the connect card collects optional private prayer details without sharing them automatically', () => {
  const bp = pack('church_connect_card');
  const fields = new Map(bp.data.fields.map((field) => [field.key, field]));
  assert.equal(fields.get('contact_phone')?.required, false);
  assert.equal(fields.get('prayer_request')?.required, false);
  assert.equal(fields.get('prayer_request')?.classification, 'restricted');
  assert.equal(fields.get('other_information')?.required, false);
  assert.equal(fields.get('other_information')?.classification, 'restricted');
  const pageFields = bp.experience.pages.flatMap((page) => page.sections.flatMap((section) => section.fields));
  for (const key of ['contact_phone', 'prayer_request', 'other_information']) assert.ok(pageFields.includes(key));
  assert.deepEqual(bp.experience.pages.map((page) => page.title), [
    'About you', 'Your visit', 'Interests and prayer', 'How we may contact you',
  ]);
  const connect = describeContents(pack('church_connect_card'), 'Church');
  const pastoral = describeContents(pack('pastoral_care'), 'Church');
  assert.ok(connect.guarantees?.controls.some((control) => control.includes('restricted field')));
  assert.ok(pastoral.guarantees?.controls.some((control) => control.includes('restricted field')));
});
