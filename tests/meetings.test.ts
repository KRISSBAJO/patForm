import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPool, type Pool } from '../src/runtime/db.js';
import { Engine } from '../src/runtime/engine.js';
import { setModule } from '../src/runtime/modules.js';
import { memoryObjectStore, setObjectStoreForTests } from '../src/runtime/object-store.js';
import { setSignMailerForTests, envelopeDetail, listEnvelopes } from '../src/runtime/esign.js';
import {
  approveMinutes, callMeeting, castVote, closeMeeting, closeResolution, completeAction, createAction, createMeeting, createResolution, decide, listActions,
  meetingDetail, meetingsOverview, openResolution, quorumMet, recordMinutes, resolutionDetail, resolutionRegister, rsvp, saveBody, sendResolutionForSignature, setBodyMember,
  setMeetingMailerForTests, setPresence, startMeeting, sweepMeetings, updateMeetingSettings, withdrawResolution, registerCsv, minutesDocument, meetingIcs, appointProxy, calendar, updateMeeting, cancelMeeting,
} from '../src/runtime/meetings.js';
import type { Principal } from '../src/runtime/policy.js';

/**
 * Meetings and resolutions: the rules a company secretary would check.
 * Notice, quorum, who may vote, how a result is decided, who approves
 * minutes, and the signed copy coming back to the register.
 */
const localDatabase = !!process.env.DATABASE_URL && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(process.env.DATABASE_URL).hostname);
const stamp = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const inDays = (n: number) => new Date(Date.now() + n * 86400000).toISOString();
type Mail = { kind: string; to: string; subject: string; text: string; attachments?: { filename: string; content: Buffer; contentType: string }[] };

test('decision rules: majority, two-thirds, unanimous, written resolutions and the casting vote', () => {
  const simple = { type: 'simple_majority', chairCasting: true } as const;
  assert.equal(decide(simple, { for: 3, against: 2, abstain: 1, eligible: 6, written: false }).passed, true);
  assert.equal(decide(simple, { for: 2, against: 2, abstain: 0, eligible: 4, written: false }).passed, false, 'a tie fails without a chair vote');
  assert.equal(decide(simple, { for: 2, against: 2, abstain: 0, eligible: 4, written: false, chairVote: 'for' }).passed, true, 'the chair breaks the tie');
  assert.equal(decide({ type: 'simple_majority', chairCasting: false }, { for: 2, against: 2, abstain: 0, eligible: 4, written: false, chairVote: 'for' }).passed, false);
  assert.equal(decide(simple, { for: 3, against: 0, abstain: 0, eligible: 7, written: true }).passed, false, 'written: silence is not consent');
  assert.equal(decide(simple, { for: 4, against: 0, abstain: 0, eligible: 7, written: true }).passed, true);
  const two = { type: 'two_thirds', chairCasting: false } as const;
  assert.equal(decide(two, { for: 4, against: 2, abstain: 3, eligible: 9, written: false }).passed, true, 'two-thirds of votes cast');
  assert.equal(decide(two, { for: 5, against: 3, abstain: 0, eligible: 8, written: false }).passed, false);
  assert.equal(decide({ type: 'unanimous', chairCasting: false }, { for: 5, against: 0, abstain: 0, eligible: 5, written: false }).passed, true);
  assert.equal(decide({ type: 'unanimous', chairCasting: false }, { for: 4, against: 0, abstain: 1, eligible: 5, written: false }).passed, false, 'an abstention breaks unanimity');
  assert.equal(quorumMet({ type: 'fraction', value: 0.5 }, 2, 4), true);
  assert.equal(quorumMet({ type: 'fraction', value: 0.5 }, 1, 4), false);
  assert.equal(quorumMet({ type: 'count', value: 3 }, 3, 10), true);
  assert.ok(registerCsv([{ number: 1, title: 'A "quoted" title, with a comma', status: 'passed' }]).includes('"A ""quoted"" title, with a comma"'));
});

async function board(pool: Pool, engine: Engine, mails: Mail[]) {
  const tenantId = await engine.createTenant(`mtg-${stamp()}`, { scenario: true });
  const mk = async (name: string, role: 'owner' | 'admin' | 'operator' | 'approver' | 'read_only') => {
    const email = `${name.toLowerCase().replace(/\s+/g, '.')}-${stamp()}@mtg.test`;
    const id = await engine.createActor(tenantId, email, name, role);
    await pool.query('update actor set email_verified_at = now() where id = $1', [id]);
    return { id, email, p: { kind: 'actor', tenantId, actorId: id } as Principal };
  };
  const owner = await mk('Olu Owner', 'owner');
  const chair = await mk('Ada Chair', 'approver');
  const sec = await mk('Sam Secretary', 'operator');
  const d1 = await mk('Dayo Director', 'read_only');
  const d2 = await mk('Efe Director', 'read_only');
  const obs = await mk('Ola Observer', 'read_only');
  const outsider = await mk('Out Sider', 'read_only');
  await setModule(pool, owner.p, 'meetings', { enabled: true });
  setMeetingMailerForTests(async (_p, m) => { mails.push(m); });
  const { id: bodyId } = await saveBody(pool, owner.p, { name: 'Board of Directors', kind: 'board', quorum: { type: 'fraction', value: 0.5 }, decision: { type: 'simple_majority', chairCasting: true }, companyName: 'Acme Ltd', signaturesRequired: 2 });
  await setBodyMember(pool, owner.p, bodyId, { actorId: chair.id, role: 'chair' });
  await setBodyMember(pool, owner.p, bodyId, { actorId: sec.id, role: 'secretary', voting: true, signatory: true });
  await setBodyMember(pool, owner.p, bodyId, { actorId: d1.id, role: 'member' });
  await setBodyMember(pool, owner.p, bodyId, { actorId: d2.id, role: 'member' });
  await setBodyMember(pool, owner.p, bodyId, { actorId: obs.id, role: 'observer' });
  return { tenantId, bodyId, owner, chair, sec, d1, d2, obs, outsider };
}

test('a board meeting: notice, RSVP, quorum, a vote with a casting vote, minutes approved by someone else, actions', { skip: !localDatabase }, async () => {
  const pool = createPool(3); const engine = new Engine(pool); const mails: Mail[] = [];
  try {
    const b = await board(pool, engine, mails);
    await updateMeetingSettings(pool, b.owner.p, { noticeDays: 7 });
    const { id: meetingId } = await createMeeting(pool, b.sec.p, { bodyId: b.bodyId, title: 'Q4 board', startsAt: inDays(2), agenda: [
      { title: 'Apologies and quorum', purpose: 'information' }, { title: 'Approve the 2027 budget', purpose: 'resolution' }, { title: 'Any other business' },
    ] });
    await assert.rejects(createMeeting(pool, b.outsider.p, { bodyId: b.bodyId, title: 'x', startsAt: inDays(9) }), /chair, the secretary or an admin/);
    // Notice: two days is short of seven, so a reason is needed.
    await assert.rejects(callMeeting(pool, b.sec.p, meetingId, {}), /7 days' notice/);
    const called = await callMeeting(pool, b.sec.p, meetingId, { shortNoticeReason: 'Budget deadline from the bank' });
    assert.equal(called.notified, 5);
    assert.equal(mails.filter((m) => m.kind === 'meeting_notice').length, 5);
    assert.ok(mails[0]!.text.includes('2. Approve the 2027 budget (resolution)'));
    await assert.rejects(rsvp(pool, b.outsider.p, meetingId, { rsvp: 'yes' }), /not a member/);
    await rsvp(pool, b.d1.p, meetingId, { rsvp: 'yes' });
    await rsvp(pool, b.d2.p, meetingId, { rsvp: 'no', apologies: 'Travelling' });

    // Quorum: 4 voting members (chair, sec, d1, d2); half is 2.
    await assert.rejects(startMeeting(pool, b.chair.p, meetingId, {}), /no quorum: 0 of 4/);
    await setPresence(pool, b.sec.p, meetingId, { actorId: b.chair.id, present: true });
    const q = await setPresence(pool, b.sec.p, meetingId, { actorId: b.d1.id, present: true });
    assert.equal(q.quorum, true);
    await setPresence(pool, b.sec.p, meetingId, { actorId: b.obs.id, present: true });
    const started = await startMeeting(pool, b.chair.p, meetingId, {});
    assert.equal(started.present, 2);

    // A resolution on the agenda item. The observer cannot vote; an absent director cannot vote.
    const detail = await meetingDetail(pool, b.d1.p, meetingId);
    const budgetItem = detail.agenda.find((i: { title: string }) => i.title.startsWith('Approve'))!;
    const { id: resId } = await createResolution(pool, b.chair.p, { meetingId, itemId: budgetItem.id, title: 'Adopt the 2027 budget', text: 'the budget for 2027 as presented is adopted.' });
    await assert.rejects(castVote(pool, b.chair.p, resId, { vote: 'for' }), /not open/);
    const opened = await openResolution(pool, b.chair.p, resId, {});
    assert.equal(opened.eligible, 2);
    await assert.rejects(castVote(pool, b.obs.p, resId, { vote: 'for' }), /do not have a vote/);
    await assert.rejects(castVote(pool, b.d2.p, resId, { vote: 'for' }), /marked present/);
    await castVote(pool, b.chair.p, resId, { vote: 'for' });
    await castVote(pool, b.d1.p, resId, { vote: 'against' });
    // A running vote shows a member only their own vote.
    const mid = await resolutionDetail(pool, b.d1.p, resId);
    assert.equal(mid.tally, null); assert.equal(mid.votes.length, 1);
    const result = await closeResolution(pool, b.chair.p, resId);
    assert.equal(result.status, 'passed', 'tie broken by the chair');
    assert.match(result.why, /casting vote/);

    // The secretary may record a present member's vote; a second resolution fails on a tie when the chair abstains.
    const { id: res2 } = await createResolution(pool, b.sec.p, { meetingId, title: 'Open a Nairobi office', text: 'an office is opened in Nairobi.' });
    await openResolution(pool, b.sec.p, res2, {});
    await castVote(pool, b.sec.p, res2, { vote: 'for', actorId: b.d1.id });
    await castVote(pool, b.chair.p, res2, { vote: 'against' });
    const r2 = await closeResolution(pool, b.sec.p, res2);
    assert.equal(r2.status, 'failed');
    const r2d = await resolutionDetail(pool, b.d1.p, res2);
    assert.equal((r2d.votes as { actor_id: string; recorded_by: string | null }[]).find((v) => v.actor_id === b.d1.id)!.recorded_by, 'Sam Secretary');

    // Actions and minutes.
    const { id: actionId } = await createAction(pool, b.sec.p, { meetingId, itemId: budgetItem.id, title: 'Send the budget to the bank', ownerId: b.d1.id, dueOn: inDays(3).slice(0, 10) });
    assert.ok(mails.some((m) => m.kind === 'action_assigned' && m.to === b.d1.email));
    for (const i of detail.agenda as { id: string }[]) await recordMinutes(pool, b.sec.p, meetingId, { itemId: i.id, minutes: 'Discussed.', outcome: 'Noted' });
    await closeMeeting(pool, b.sec.p, meetingId);
    await assert.rejects(approveMinutes(pool, b.sec.p, meetingId), /cannot approve them/);
    await assert.rejects(approveMinutes(pool, b.d1.p, meetingId), /chair, the secretary or an admin/);
    const approved = await approveMinutes(pool, b.chair.p, meetingId);
    assert.ok(approved.sha256);
    const pdf = await minutesDocument(pool, b.d2.p, meetingId);
    assert.equal(pdf.body.subarray(0, 4).toString(), '%PDF');
    assert.equal(mails.filter((m) => m.kind === 'meeting_minutes').length, 5);
    await assert.rejects(recordMinutes(pool, b.sec.p, meetingId, { itemId: budgetItem.id, minutes: 'changed' }), /before they are approved/);

    // The owner closes the action; an outsider cannot.
    await assert.rejects(completeAction(pool, b.outsider.p, actionId, {}), /only the owner/);
    await completeAction(pool, b.d1.p, actionId, { note: 'Sent on Monday' });
    assert.equal((await listActions(pool, b.d1.p, { scope: 'mine' }))[0]!.status, 'done');

    const reg = await resolutionRegister(pool, b.d2.p, b.bodyId);
    assert.deepEqual(reg.map((r: { number: number; status: string }) => [r.number, r.status]), [[1, 'passed'], [2, 'failed']]);
    const ov = await meetingsOverview(pool, b.chair.p);
    assert.equal(ov.toSign.length, 1);
  } finally { setMeetingMailerForTests(null); await pool.end(); }
});

test('a written resolution: everyone eligible is asked, silence is not a yes, the deadline settles it', { skip: !localDatabase }, async () => {
  const pool = createPool(3); const engine = new Engine(pool); const mails: Mail[] = [];
  try {
    const b = await board(pool, engine, mails);
    const { id: resId } = await createResolution(pool, b.sec.p, { bodyId: b.bodyId, title: 'Appoint auditors', text: 'XYZ LLP are appointed auditors.' });
    const opened = await openResolution(pool, b.sec.p, resId, { deadlineAt: inDays(1) });
    assert.equal(opened.eligible, 4);
    assert.equal(mails.filter((m) => m.kind === 'resolution_vote').length, 4);
    await assert.rejects(castVote(pool, b.sec.p, resId, { vote: 'for', actorId: b.d1.id }), /personally/);
    await castVote(pool, b.chair.p, resId, { vote: 'for' });
    await castVote(pool, b.d1.p, resId, { vote: 'for' });
    // Two of four is not a majority of those eligible. The deadline passes and the sweep settles it.
    await pool.query(`update mtg_resolution set deadline_at = now() - interval '1 minute' where id = $1`, [resId]);
    const swept = await sweepMeetings(pool);
    assert.equal(swept.closed, 1);
    const d = await resolutionDetail(pool, b.d2.p, resId);
    assert.equal(d.resolution.status, 'failed');
    assert.match(String(d.resolution.result_note), /majority of 4 eligible not reached/);
    await assert.rejects(withdrawResolution(pool, b.sec.p, resId, { reason: 'late' }), /cannot be withdrawn/);
  } finally { setMeetingMailerForTests(null); await pool.end(); }
});

test('a passed resolution is signed through Patform Sign as the company, and the signed copy returns to the register', { skip: !localDatabase }, async () => {
  const pool = createPool(3); const engine = new Engine(pool); const mails: Mail[] = [];
  const mem = memoryObjectStore(); setObjectStoreForTests(mem.store);
  const signMails: Mail[] = []; setSignMailerForTests(async (_p, m) => { signMails.push(m); });
  try {
    const b = await board(pool, engine, mails);
    const { id: resId } = await createResolution(pool, b.sec.p, { bodyId: b.bodyId, title: 'Change the registered office', text: 'the registered office moves to 1 Marina, Lagos.' });
    await openResolution(pool, b.sec.p, resId, { deadlineAt: inDays(1) });
    for (const who of [b.chair, b.sec, b.d1]) await castVote(pool, who.p, resId, { vote: 'for' });
    const closed = await closeResolution(pool, b.sec.p, resId);
    assert.equal(closed.status, 'passed');
    await assert.rejects(sendResolutionForSignature(pool, b.chair.p, resId), /Contracts module/);
    await setModule(pool, b.owner.p, 'contracts', { enabled: true });
    const sent = await sendResolutionForSignature(pool, b.chair.p, resId);
    assert.equal(sent.signers, 2, 'the chair and the secretary are signatories');
    assert.equal(sent.required, 2);
    assert.ok(sent.envelopeId);
    const env = await envelopeDetail(pool, b.chair.p, sent.envelopeId!);
    assert.equal(env.parties.length, 1);
    assert.equal(env.parties[0]!.name, 'Acme Ltd');
    assert.equal(signMails.filter((m) => m.kind === 'signature_request').length, 2);
    assert.equal((await resolutionDetail(pool, b.d1.p, resId)).resolution.status, 'signing');
    // Pretend everyone signed: the sweep brings the signed copy back.
    const fileId = (await pool.query<{ signing_file_id: string }>('select signing_file_id from mtg_resolution where id = $1', [resId])).rows[0]!.signing_file_id;
    await pool.query(`update sign_envelope set status = 'completed', completed_at = now(), final_file_id = $2, final_sha256 = (select sha256 from gov_file where id = $2) where id = $1`, [sent.envelopeId, fileId]);
    const swept = await sweepMeetings(pool);
    assert.equal(swept.signed, 1);
    const reg = await resolutionRegister(pool, b.d2.p, b.bodyId);
    assert.equal(reg[0]!.status, 'signed');
    assert.ok(reg[0]!.signed_sha256);
    assert.equal((await listEnvelopes(pool, b.chair.p)).length, 1);
  } finally { setMeetingMailerForTests(null); setSignMailerForTests(null); setObjectStoreForTests(undefined); await pool.end(); }
});

test('the invitation is a valid calendar entry that updates and cancels the same event', () => {
  const ics = meetingIcs({ id: 'abc', title: 'Q4 board; with a comma, too', body: 'Board', startsAt: new Date('2026-11-02T09:00:00Z'), endsAt: new Date('2026-11-02T11:00:00Z'), location: 'Boardroom', link: 'https://meet.example/x', agenda: ['Apologies', 'Budget'], sequence: 2, organiser: { name: 'Sam', email: 'sam@x.test' }, attendee: { name: 'Ada', email: 'ada@x.test' } });
  assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\n'));
  assert.ok(ics.includes('METHOD:REQUEST'));
  assert.ok(ics.includes('UID:abc@patform'));
  assert.ok(ics.includes('DTSTART:20261102T090000Z'));
  assert.ok(ics.includes('SEQUENCE:2'));
  assert.ok(ics.includes('SUMMARY:Q4 board\\; with a comma\\, too'));
  assert.ok(ics.includes('ATTENDEE;CN=Ada;ROLE=REQ-PARTICIPANT;RSVP=TRUE:mailto:ada@x.test'));
  assert.ok(ics.split('\r\n').every((l) => Buffer.byteLength(l) <= 75), 'lines are folded');
  const cancelled = meetingIcs({ id: 'abc', title: 'Q4', body: 'Board', startsAt: new Date(), endsAt: null, location: null, link: null, agenda: [], sequence: 3, cancelled: true });
  assert.ok(cancelled.includes('METHOD:CANCEL') && cancelled.includes('STATUS:CANCELLED'));
});

test('notices carry the invitation; moving a called meeting re-sends it with a higher sequence; cancelling sends a cancellation', { skip: !localDatabase }, async () => {
  const pool = createPool(3); const engine = new Engine(pool); const mails: Mail[] = [];
  try {
    const b = await board(pool, engine, mails);
    const { id: meetingId } = await createMeeting(pool, b.sec.p, { bodyId: b.bodyId, title: 'Strategy day', startsAt: inDays(10), agenda: [{ title: 'Strategy' }] });
    await callMeeting(pool, b.sec.p, meetingId, {});
    const notice = mails.find((m) => m.kind === 'meeting_notice')!;
    assert.equal(notice.attachments?.[0]?.filename, 'invite.ics');
    const text = notice.attachments![0]!.content.toString();
    assert.ok(text.includes(`UID:${meetingId}@patform`) && text.includes('SEQUENCE:0'));
    mails.length = 0;
    await updateMeeting(pool, b.sec.p, meetingId, { startsAt: inDays(11) });
    const moved = mails.filter((m) => m.subject.startsWith('Changed:'));
    assert.equal(moved.length, 5);
    assert.ok(moved[0]!.attachments![0]!.content.toString().includes('SEQUENCE:1'));
    mails.length = 0;
    await updateMeeting(pool, b.sec.p, meetingId, { title: 'Strategy day (renamed)' });
    assert.equal(mails.length, 0, 'a title change does not re-invite');
    await cancelMeeting(pool, b.sec.p, meetingId, { reason: 'Postponed' });
    const cancel = mails.find((m) => m.subject.startsWith('Cancelled:'))!;
    assert.equal(cancel.attachments?.[0]?.filename, 'cancelled.ics');
    assert.ok(cancel.attachments![0]!.content.toString().includes('METHOD:CANCEL'));
    const cal = await calendar(pool, b.d1.p, {});
    assert.ok(cal.meetings.some((m) => m.id === meetingId && m.status === 'cancelled'));
  } finally { setMeetingMailerForTests(null); await pool.end(); }
});

test('proxies: only where the body allows, held by a present voting member, counted in the vote but not the quorum', { skip: !localDatabase }, async () => {
  const pool = createPool(3); const engine = new Engine(pool); const mails: Mail[] = [];
  try {
    const b = await board(pool, engine, mails);
    const { id: meetingId } = await createMeeting(pool, b.sec.p, { bodyId: b.bodyId, title: 'AGM', startsAt: inDays(10), agenda: [{ title: 'Dividend', purpose: 'resolution' }] });
    await callMeeting(pool, b.sec.p, meetingId, {});
    await assert.rejects(appointProxy(pool, b.d2.p, meetingId, { holderId: b.d1.id }), /does not allow proxies/);
    await saveBody(pool, b.owner.p, { id: b.bodyId, name: 'Board of Directors', kind: 'general', quorum: { type: 'fraction', value: 0.5 }, decision: { type: 'simple_majority', chairCasting: true }, proxiesAllowed: true, maxProxies: 1 });
    await assert.rejects(appointProxy(pool, b.obs.p, meetingId, { holderId: b.d1.id }), /only a voting member/);
    await assert.rejects(appointProxy(pool, b.d2.p, meetingId, { holderId: b.obs.id }), /must be a voting member/);
    await appointProxy(pool, b.d2.p, meetingId, { holderId: b.d1.id });
    await assert.rejects(appointProxy(pool, b.sec.p, meetingId, { holderId: b.d1.id }), /already holds 1/);
    await setPresence(pool, b.sec.p, meetingId, { actorId: b.chair.id, present: true });
    await assert.rejects(startMeeting(pool, b.chair.p, meetingId, {}), /no quorum/);
    await setPresence(pool, b.sec.p, meetingId, { actorId: b.d1.id, present: true });
    await startMeeting(pool, b.chair.p, meetingId, {});
    const d = await meetingDetail(pool, b.d1.p, meetingId);
    assert.equal(d.quorum.present, 2); assert.equal(d.quorum.represented, 1);
    assert.equal(d.me.holding.length, 1);
    const item = d.agenda[0] as { id: string };
    const { id: resId } = await createResolution(pool, b.chair.p, { meetingId, itemId: item.id, title: 'Pay a dividend', text: 'a dividend of 10 kobo per share is paid.' });
    const opened = await openResolution(pool, b.chair.p, resId, {});
    assert.equal(opened.eligible, 3, 'two present plus one represented');
    const rd = await resolutionDetail(pool, b.d1.p, resId);
    assert.deepEqual(rd.me.proxy_for.map((p: { name: string }) => p.name), ['Efe Director']);
    await castVote(pool, b.d1.p, resId, { vote: 'for' });
    await castVote(pool, b.d1.p, resId, { vote: 'for', actorId: b.d2.id });
    await assert.rejects(castVote(pool, b.sec.p, resId, { vote: 'for', actorId: b.d2.id }), /only members marked present/);
    await castVote(pool, b.chair.p, resId, { vote: 'against' });
    const result = await closeResolution(pool, b.chair.p, resId);
    assert.equal(result.status, 'passed');
    assert.equal(result.for, 2);
    const after = await resolutionDetail(pool, b.d1.p, resId);
    assert.equal((after.votes as { actor_id: string; by_proxy: boolean }[]).find((v) => v.actor_id === b.d2.id)!.by_proxy, true);
    await setPresence(pool, b.sec.p, meetingId, { actorId: b.d2.id, present: true });
    const d2 = await meetingDetail(pool, b.d1.p, meetingId);
    assert.equal(d2.quorum.represented, 0);
    await appointProxy(pool, b.d2.p, meetingId, { revoke: true });
    await assert.rejects(appointProxy(pool, b.d2.p, meetingId, { revoke: true }), /not given a proxy/);
  } finally { setMeetingMailerForTests(null); await pool.end(); }
});

