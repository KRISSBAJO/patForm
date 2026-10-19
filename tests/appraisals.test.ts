import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPool, type Pool } from '../src/runtime/db.js';
import { Engine } from '../src/runtime/engine.js';
import { setModule } from '../src/runtime/modules.js';
import { setManager } from '../src/runtime/org.js';
import {
  acknowledgeResult, addDevelopmentItem, addPeerReviewer, adjustScore, appealResult, approveGoal, assessmentForm, assignAppealReviewer, assignReviewer,
  calibrationView, completeDevelopmentItem, computeScore, createCycle, createGoal, cycleReport, decideAppeal, decideGoalRevision, decideRecommendation,
  launchCycle, listAppeals, listGoals, listRecommendations, myAssignments, myResults, publishCycle, publishTemplate, saveAssessment, saveTemplate,
  teamGoals, updateGoal, validateTemplate, type TemplateSnapshot,
} from '../src/runtime/appraisals.js';
import type { Principal } from '../src/runtime/policy.js';

// PRD Module 8 and its five acceptance scenarios.
const localDatabase = !!process.env.DATABASE_URL && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(process.env.DATABASE_URL).hostname);
const stamp = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const addDays = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const open = { opens: addDays(-2), closes: addDays(5) };

const SECTIONS = [
  { key: 'obj', title: 'Objectives', kind: 'objectives', weight: 60, criteria: [{ key: 'delivery', title: 'Delivered agreed objectives' }] },
  { key: 'beh', title: 'Behaviours', kind: 'competencies', weight: 40, criteria: [{ key: 'team', title: 'Teamwork', weight: 50 }, { key: 'own', title: 'Ownership', weight: 50 }] },
  { key: 'notes', title: 'Comments', kind: 'narrative', weight: 0, criteria: [] },
];
const full = (d: number, t: number, o: number) => ({ delivery: { score: d }, team: { score: t }, own: { score: o } });

async function workspace(pool: Pool, engine: Engine) {
  const tenantId = await engine.createTenant(`apr-${stamp()}`, { scenario: true });
  const mk = async (name: string, role: 'owner' | 'admin' | 'operator' | 'approver' | 'read_only') => {
    const id = await engine.createActor(tenantId, `${name.toLowerCase().replace(/\s+/g, '.')}-${stamp()}@apr.test`, name, role);
    return { id, name, p: { kind: 'actor', tenantId, actorId: id } as Principal };
  };
  const owner = await mk('Owner', 'owner');
  const hr = await mk('Hana HR', 'admin');
  const manager = await mk('Mo Manager', 'approver');
  const manager2 = await mk('Nia Newboss', 'approver');
  const staff = await mk('Sam Staff', 'read_only');
  const staff2 = await mk('Tia Two', 'read_only');
  const peers = [await mk('Pat Peer', 'operator'), await mk('Quin Peer', 'operator'), await mk('Ria Peer', 'operator')];
  const outsider = await mk('Uma Outside', 'operator');
  await setModule(pool, owner.p, 'appraisals', { enabled: true });
  for (const s of [staff, staff2]) await setManager(pool, owner.p, s.id, { managerId: manager.id, effectiveFrom: '2026-01-01T00:00:00Z' });
  return { tenantId, owner, hr, manager, manager2, staff, staff2, peers, outsider };
}

async function cycleWith(pool: Pool, w: Awaited<ReturnType<typeof workspace>>, opts: { recommendation?: boolean } = {}) {
  const t = await saveTemplate(pool, w.hr.p, { name: `Annual ${stamp()}`, scaleMin: 1, scaleMax: 5, sections: SECTIONS });
  await publishTemplate(pool, w.hr.p, t.id);
  const c = await createCycle(pool, w.hr.p, { name: `FY ${stamp()}`, kind: 'annual', templateId: t.id, stages: { self: open, peer: open, manager: open }, peerMode: 'confidential', minCohort: 3 });
  await launchCycle(pool, w.hr.p, c.id);
  const { rows } = await pool.query<{ id: string; actor_id: string }>('select id, actor_id from review_participant where cycle_id = $1', [c.id]);
  const part = (actorId: string) => rows.find((r) => r.actor_id === actorId)!.id;
  const assignment = async (who: { p: Principal }, stage: string, participantId: string) =>
    (await myAssignments(pool, who.p)).find((a) => a.stage === stage && a.participant_id === participantId)!;
  void opts;
  return { cycleId: c.id, templateId: t.id, part, assignment };
}

test('scores are worked out from the template: missing blocks, not-applicable blocks or redistributes, and the working is kept', () => {
  const t: TemplateSnapshot = { name: 'T', version: 1, scaleMin: 1, scaleMax: 5, naPolicy: 'block', decimals: 2, sections: validateTemplate(SECTIONS).sections };
  const ok = computeScore(t, full(5, 3, 4));
  assert.ok(ok.ok);
  // Objectives 60% at 1.0, Behaviours 40% at (0.5 + 0.75) / 2 = 0.625: 0.85 normalised, 4.4 on the scale.
  assert.equal(ok.score, 4.4);
  assert.equal(ok.calculation.version, 'appraisal-score-v1');
  assert.equal(ok.calculation.redistributed, false);

  const missing = computeScore(t, { delivery: { score: 5 }, team: { score: 3 } });
  assert.ok(!missing.ok);
  assert.match(missing.problems.join(), /no score for: Ownership/);

  const naBlocked = computeScore(t, { ...full(5, 3, 4), own: { na: true } });
  assert.ok(!naBlocked.ok);
  assert.match(naBlocked.problems.join(), /not applicable.*Ownership/);

  const redistributed = computeScore({ ...t, naPolicy: 'redistribute' }, { ...full(5, 3, 4), own: { na: true } });
  assert.ok(redistributed.ok);
  // Teamwork carries the whole Behaviours weight: 0.6 x 1 + 0.4 x 0.5 = 0.8, so 4.2.
  assert.equal(redistributed.score, 4.2);
  const beh = redistributed.calculation.sections.find((s) => s.section === 'beh')!;
  assert.deepEqual(beh.criteria.map((c) => c.weight), [100, 0]);

  const offScale = computeScore(t, full(6, 3, 4));
  assert.ok(!offScale.ok);
});

test('acceptance 2: a template with inconsistent weights cannot be published, and the error names the section', { skip: !localDatabase }, async () => {
  const pool = createPool(3); const engine = new Engine(pool);
  try {
    const w = await workspace(pool, engine);
    const bad = structuredClone(SECTIONS);
    bad[1]!.criteria[1]!.weight = 40;
    const t = await saveTemplate(pool, w.hr.p, { name: 'Bad items', sections: bad });
    await assert.rejects(publishTemplate(pool, w.hr.p, t.id), /Behaviours: item weights add up to 90, not 100/);

    const badSections = structuredClone(SECTIONS);
    badSections[0]!.weight = 70;
    const t2 = await saveTemplate(pool, w.hr.p, { name: 'Bad sections', sections: badSections });
    await assert.rejects(publishTemplate(pool, w.hr.p, t2.id), /\(all sections\): section weights add up to 110, not 100: Objectives 70, Behaviours 40/);

    // Fix the draft and it publishes; editing it then makes version 2, leaving version 1 alone.
    await saveTemplate(pool, w.hr.p, { id: t.id, name: 'Bad items', sections: SECTIONS });
    await publishTemplate(pool, w.hr.p, t.id);
    const v2 = await saveTemplate(pool, w.hr.p, { id: t.id, name: 'Bad items', sections: SECTIONS });
    assert.equal(v2.version, 2);
    assert.notEqual(v2.id, t.id);
    await assert.rejects(createCycle(pool, w.hr.p, { name: 'x', kind: 'annual', templateId: v2.id, stages: { manager: open } }), /published template/);
    // Only HR builds templates.
    await assert.rejects(saveTemplate(pool, w.staff.p, { name: 'Mine', sections: SECTIONS }), /only HR/);
  } finally { await pool.end(); }
});

test('acceptance 1: confidential peer responses stay hidden before release and are only ever shown as aggregates from enough people', { skip: !localDatabase }, async () => {
  const pool = createPool(3); const engine = new Engine(pool);
  try {
    const w = await workspace(pool, engine);
    const c = await cycleWith(pool, w);
    const sam = c.part(w.staff.id); const tia = c.part(w.staff2.id);
    for (const p of w.peers) await addPeerReviewer(pool, w.staff.p, sam, { reviewerId: p.id });
    for (const p of w.peers.slice(0, 2)) await addPeerReviewer(pool, w.manager.p, tia, { reviewerId: p.id });
    await assert.rejects(addPeerReviewer(pool, w.outsider.p, sam, { reviewerId: w.outsider.id }), /only the person, their manager or HR/);

    let i = 0;
    for (const p of w.peers) {
      const a = await c.assignment(p, 'peer', sam);
      await saveAssessment(pool, p.p, a.id, { responses: full(4, 2 + i, 3), narrative: `Secret words from ${p.name}`, submit: true });
      const b = await c.assignment(p, 'peer', tia);
      if (b) await saveAssessment(pool, p.p, b.id, { responses: full(3, 3, 3), narrative: `About Tia from ${p.name}`, submit: true });
      i++;
    }

    const mSam = await c.assignment(w.manager, 'manager', sam);
    const mTia = await c.assignment(w.manager, 'manager', tia);
    // Before the peer window closes: nothing.
    const before = await assessmentForm(pool, w.manager.p, mSam.id);
    assert.equal((before.peers as { released: boolean }).released, false);
    assert.doesNotMatch(JSON.stringify(before), /Secret words|Pat Peer|Quin Peer|Ria Peer/);
    // The person reviewed cannot open the manager's review, and a peer cannot open another peer's.
    await assert.rejects(assessmentForm(pool, w.staff.p, mSam.id), /no such review for you/);
    const patOnSam = await c.assignment(w.peers[0]!, 'peer', sam);
    await assert.rejects(assessmentForm(pool, w.peers[1]!.p, patOnSam.id), /no such review for you/);

    // Close the peer window.
    await pool.query(`update review_cycle set stages = jsonb_set(stages, '{peer}', $2::jsonb) where id = $1`, [c.cycleId, JSON.stringify({ opens: addDays(-5), closes: addDays(-1) })]);
    const after = await assessmentForm(pool, w.manager.p, mSam.id);
    const peers = after.peers as { released: boolean; mode: string; count: number; averages: Record<string, number> };
    assert.equal(peers.released, true);
    assert.equal(peers.count, 3);
    assert.deepEqual(peers.averages, { 'Delivered agreed objectives': 4, Teamwork: 3, Ownership: 3 });
    // Aggregates only: no comments, no names.
    assert.doesNotMatch(JSON.stringify(after), /Secret words|Pat Peer|Quin Peer|Ria Peer/);
    // Two responses is below the group size of three: suppressed altogether.
    const small = (await assessmentForm(pool, w.manager.p, mTia.id)).peers as { suppressed: boolean; averages?: unknown };
    assert.equal(small.suppressed, true);
    assert.equal(small.averages, undefined);
    // And late peer feedback is refused once the window has closed.
    await assert.rejects(saveAssessment(pool, w.peers[0]!.p, patOnSam.id, { responses: full(1, 1, 1) }), /already submitted|window has closed/);
  } finally { await pool.end(); }
});

test('acceptance 3: calibration keeps the original rating, the adjusted rating, who, the evidence and the explanation', { skip: !localDatabase }, async () => {
  const pool = createPool(3); const engine = new Engine(pool);
  try {
    const w = await workspace(pool, engine);
    const c = await cycleWith(pool, w);
    const sam = c.part(w.staff.id);
    const self = await c.assignment(w.staff, 'self', sam);
    await assert.rejects(saveAssessment(pool, w.staff.p, self.id, { responses: { delivery: { score: 5 } }, submit: true }), /no score for: Teamwork, Ownership/);
    await saveAssessment(pool, w.staff.p, self.id, { responses: full(5, 5, 5), submit: true });
    const m = await c.assignment(w.manager, 'manager', sam);
    const saved = await saveAssessment(pool, w.manager.p, m.id, { responses: full(5, 3, 4), narrative: 'Strong year', submit: true });
    assert.equal(saved.score, 4.4);
    await assert.rejects(saveAssessment(pool, w.manager.p, m.id, { responses: full(1, 1, 1), submit: true }), /already submitted/);

    await assert.rejects(adjustScore(pool, w.hr.p, sam, { score: 4, evidence: '', reason: 'x' }), /evidence/);
    await assert.rejects(adjustScore(pool, w.manager.p, sam, { score: 4, evidence: 'e', reason: 'r' }), /only HR/);
    await adjustScore(pool, w.hr.p, sam, { score: 4, evidence: 'Panel comparison of the sales team', reason: 'In line with peers delivering the same targets' });
    await adjustScore(pool, w.hr.p, sam, { score: 4.2, evidence: 'Second panel', reason: 'Late-year account win' });

    const row = (await calibrationView(pool, w.hr.p, c.cycleId)).find((p) => p.id === sam)!;
    assert.equal(row.current, 4.2);
    assert.equal(Number(row.manager!.score), 4.4);
    assert.deepEqual(row.adjustments.map((a: { original_score: string; adjusted_score: string; actor: string }) => [Number(a.original_score), Number(a.adjusted_score), a.actor]), [[4.4, 4, 'Hana HR'], [4, 4.2, 'Hana HR']]);
    assert.equal(row.adjustments[0].evidence, 'Panel comparison of the sales team');
    assert.equal(row.adjustments[0].reason, 'In line with peers delivering the same targets');
    // The record cannot be rewritten.
    await assert.rejects(pool.query('update calibration_adjustment set adjusted_score = 5 where participant_id = $1', [sam]), /append-only/);
    await assert.rejects(pool.query('delete from calibration_adjustment where participant_id = $1', [sam]), /append-only/);
    // The manager's submitted review is untouched.
    const { rows } = await pool.query('select score, calculation from assessment where assignment_id = $1', [m.id]);
    assert.equal(Number(rows[0].score), 4.4);
    assert.equal(rows[0].calculation.version, 'appraisal-score-v1');
  } finally { await pool.end(); }
});

test('acceptance 4: a published promotion or pay recommendation changes nothing until HR acts separately; receipt and appeal', { skip: !localDatabase }, async () => {
  const pool = createPool(3); const engine = new Engine(pool);
  try {
    const w = await workspace(pool, engine);
    const c = await cycleWith(pool, w);
    const sam = c.part(w.staff.id);
    const m = await c.assignment(w.manager, 'manager', sam);
    await saveAssessment(pool, w.manager.p, m.id, { responses: full(5, 5, 5), narrative: 'Ready for the next level', recommendation: { kind: 'promotion', detail: 'Senior officer from January' }, submit: true });
    await adjustScore(pool, w.hr.p, sam, { score: 4.5, evidence: 'Panel', reason: 'Calibrated against peers' });
    const payBefore = await pool.query('select count(*)::int as n from employee_compensation where tenant_id = $1', [w.tenantId]);
    const roleBefore = await pool.query('select org_unit_id, workspace_role from actor where id = $1', [w.staff.id]);

    await assert.rejects(publishCycle(pool, w.hr.p, c.cycleId), /no submitted manager review/);
    const pub = await publishCycle(pool, w.hr.p, c.cycleId, { allowIncomplete: true });
    assert.equal(pub.published, 1);

    const recs = await listRecommendations(pool, w.hr.p);
    assert.equal(recs.length, 1);
    assert.equal(recs[0].status, 'proposed');
    const decided = await decideRecommendation(pool, w.hr.p, recs[0].id, { decision: 'approve', note: 'Agreed at the people panel' });
    assert.match(decided.next!, /nothing has changed yet/);
    const payAfter = await pool.query('select count(*)::int as n from employee_compensation where tenant_id = $1', [w.tenantId]);
    const roleAfter = await pool.query('select org_unit_id, workspace_role from actor where id = $1', [w.staff.id]);
    assert.equal(payAfter.rows[0].n, payBefore.rows[0].n);
    assert.deepEqual(roleAfter.rows[0], roleBefore.rows[0]);
    await assert.rejects(decideRecommendation(pool, w.manager.p, recs[0].id, { decision: 'approve', note: 'x' }), /owner or admin in HR/);

    // The employee sees the calibrated result, records receipt (not agreement), and can appeal.
    const [mine] = await myResults(pool, w.staff.p);
    assert.equal(Number(mine.calibrated_score), 4.5);
    assert.equal(Number(mine.manager_score), 5);
    const ack = await acknowledgeResult(pool, w.staff.p, sam);
    assert.match(ack.statement, /does not mean I agree/);
    await appealResult(pool, w.staff.p, sam, { reason: 'Calibration ignored my Q4 results' });
    const [appeal] = await listAppeals(pool, w.hr.p);
    // The reviewer must be independent of the review.
    await assert.rejects(assignAppealReviewer(pool, w.hr.p, appeal.id, { reviewerId: w.manager.id }), /they are or were the manager/);
    await assert.rejects(assignAppealReviewer(pool, w.hr.p, appeal.id, { reviewerId: w.hr.id }), /they calibrated this score/);
    await assert.rejects(assignAppealReviewer(pool, w.hr.p, appeal.id, { reviewerId: w.staff.id }), /their own review/);
    await assignAppealReviewer(pool, w.hr.p, appeal.id, { reviewerId: w.outsider.id });
    await assert.rejects(decideAppeal(pool, w.hr.p, appeal.id, { outcome: 'upheld', note: 'x' }), /only the independent reviewer/);
    await decideAppeal(pool, w.outsider.p, appeal.id, { outcome: 'changed', newScore: 4.8, note: 'Q4 results were missed in calibration' });
    const [after] = await myResults(pool, w.staff.p);
    assert.equal(Number(after.calibrated_score), 4.8);
    assert.equal(after.appeal_status, 'changed');
  } finally { await pool.end(); }
});

test('acceptance 5: a reviewer who changes role mid-cycle loses access; their submitted review stays theirs; HR assigns a replacement with a reason', { skip: !localDatabase }, async () => {
  const pool = createPool(3); const engine = new Engine(pool);
  try {
    const w = await workspace(pool, engine);
    const c = await cycleWith(pool, w);
    const sam = c.part(w.staff.id); const tia = c.part(w.staff2.id);
    const mSam = await c.assignment(w.manager, 'manager', sam);
    const mTia = await c.assignment(w.manager, 'manager', tia);
    await saveAssessment(pool, w.manager.p, mSam.id, { responses: full(4, 4, 4), narrative: 'Solid', submit: true });
    await saveAssessment(pool, w.manager.p, mTia.id, { responses: full(3, 3, 3) });

    // Both move to a new manager.
    for (const s of [w.staff, w.staff2]) await setManager(pool, w.owner.p, s.id, { managerId: w.manager2.id, effectiveFrom: new Date(Date.now() - 1000).toISOString() });

    assert.equal((await myAssignments(pool, w.manager.p)).filter((a) => a.stage === 'manager').length, 0);
    await assert.rejects(assessmentForm(pool, w.manager.p, mSam.id), /no such review for you/);
    await assert.rejects(saveAssessment(pool, w.manager.p, mTia.id, { responses: full(5, 5, 5), submit: true }), /no such review for you/);

    const view = await calibrationView(pool, w.hr.p, c.cycleId);
    const rowSam = view.find((p) => p.id === sam)!;
    assert.equal(rowSam.needs_reviewer, true);
    assert.match(rowSam.reviewer_note!, /manager changed/);
    assert.equal(rowSam.manager!.reviewer, 'Mo Manager');
    assert.equal(Number(rowSam.manager!.score), 4);
    assert.equal(rowSam.manager!.active, false);
    const { rows } = await pool.query('select reviewer_id, status from assessment where assignment_id = $1', [mSam.id]);
    assert.deepEqual(rows[0], { reviewer_id: w.manager.id, status: 'submitted' });

    await assert.rejects(assignReviewer(pool, w.hr.p, tia, { reviewerId: w.manager2.id, stage: 'manager', reason: '' }), /record why/);
    await assert.rejects(assignReviewer(pool, w.hr.p, tia, { reviewerId: w.staff2.id, stage: 'manager', reason: 'x' }), /nobody reviews themselves/);
    await assignReviewer(pool, w.hr.p, tia, { reviewerId: w.manager2.id, stage: 'manager', reason: 'New line manager from 1 November' });
    const fresh = await c.assignment(w.manager2, 'manager', tia);
    assert.ok(fresh);
    const form = await assessmentForm(pool, w.manager2.p, fresh.id);
    assert.equal(form.mine, null);
    // The old manager's draft does not carry over to the new reviewer.
    await saveAssessment(pool, w.manager2.p, fresh.id, { responses: full(4, 3, 3), submit: true });
    const rowTia = (await calibrationView(pool, w.hr.p, c.cycleId)).find((p) => p.id === tia)!;
    assert.equal(rowTia.needs_reviewer, false);
    assert.equal(rowTia.manager!.reviewer, 'Nia Newboss');
  } finally { await pool.end(); }
});

test('goals need manager approval, changes keep their history, and development items close with evidence', { skip: !localDatabase }, async () => {
  const pool = createPool(3); const engine = new Engine(pool);
  try {
    const w = await workspace(pool, engine);
    const g = await createGoal(pool, w.staff.p, { title: 'Grow Abuja accounts', successCriteria: '10 new accounts', weight: 40, targetDate: addDays(90) });
    await assert.rejects(approveGoal(pool, w.staff.p, g.id), /your manager approves/);
    await assert.rejects(approveGoal(pool, w.outsider.p, g.id), /manager or HR/);
    assert.equal((await teamGoals(pool, w.manager.p)).length, 1);
    await approveGoal(pool, w.manager.p, g.id);
    await updateGoal(pool, w.staff.p, g.id, { progress: 30, evidence: '3 signed' });
    await assert.rejects(updateGoal(pool, w.staff.p, g.id, { successCriteria: '6 new accounts' }), /say why/);
    const r = await updateGoal(pool, w.staff.p, g.id, { successCriteria: '6 new accounts', reason: 'Territory split in half' });
    assert.ok(r.revision);
    let [goal] = await listGoals(pool, w.staff.p);
    assert.equal(goal.success_criteria, '10 new accounts');
    assert.equal(goal.pending_changes, 1);
    await assert.rejects(decideGoalRevision(pool, w.staff.p, String(r.revision), { decision: 'approve' }), /someone other than/);
    await decideGoalRevision(pool, w.manager.p, String(r.revision), { decision: 'approve' });
    [goal] = await listGoals(pool, w.staff.p);
    assert.equal(goal.success_criteria, '6 new accounts');
    assert.equal(goal.progress, 30);
    const { rows } = await pool.query('select previous, proposed, status from goal_revision where goal_id = $1', [g.id]);
    assert.equal(rows[0].previous.success_criteria, '10 new accounts');
    assert.equal(rows[0].status, 'approved');
    await assert.rejects(listGoals(pool, w.outsider.p, { ownerId: w.staff.id }), /your own goals/);

    const d = await addDevelopmentItem(pool, w.manager.p, { employeeId: w.staff.id, kind: 'training', title: 'Negotiation course', dueDate: addDays(60) });
    await assert.rejects(completeDevelopmentItem(pool, w.staff.p, d.id, {}), /what shows it is done/);
    await completeDevelopmentItem(pool, w.staff.p, d.id, { evidence: 'Certificate 2026-11' });
    await assert.rejects(addDevelopmentItem(pool, w.outsider.p, { employeeId: w.staff.id, title: 'x' }), /your own plan/);
  } finally { await pool.end(); }
});

test('eligibility is a snapshot with reasons, the module gate holds, and reports hide small groups', { skip: !localDatabase }, async () => {
  const pool = createPool(3); const engine = new Engine(pool);
  try {
    const w = await workspace(pool, engine);
    await pool.query(`insert into employee_record (tenant_id, actor_id, email, name, status, start_date) values ($1, $2, 'tia@apr.test', 'Tia Two', 'active', $3)`, [w.tenantId, w.staff2.id, addDays(-10)]);
    const t = await saveTemplate(pool, w.hr.p, { name: 'Probation', sections: SECTIONS });
    await publishTemplate(pool, w.hr.p, t.id);
    await assert.rejects(createCycle(pool, w.hr.p, { name: 'x', kind: 'annual', templateId: t.id, stages: { self: { opens: addDays(-1), closes: addDays(9) }, manager: open } }), /self-assessment must close before/);
    const c = await createCycle(pool, w.hr.p, { name: 'Mid-year', kind: 'quarterly', templateId: t.id, stages: { manager: open }, eligibility: { startedBefore: addDays(-30) } });
    await assert.rejects(launchCycle(pool, w.manager.p, c.id), /owner or admin in HR/);
    const launched = await launchCycle(pool, w.hr.p, c.id);
    assert.ok(launched.excluded >= 1);
    const { rows } = await pool.query('select eligible, reason from review_participant where cycle_id = $1 and actor_id = $2', [c.id, w.staff2.id]);
    assert.deepEqual(rows[0], { eligible: false, reason: `started on or after ${addDays(-30)}` });
    await assert.rejects(launchCycle(pool, w.hr.p, c.id), /already been launched/);

    const report = await cycleReport(pool, w.hr.p, c.id);
    assert.ok(report.distribution.every((b) => b.count === null || b.count >= 3));

    await setModule(pool, w.owner.p, 'appraisals', { enabled: false });
    await assert.rejects(myAssignments(pool, w.staff.p), /switched off/);
  } finally { await pool.end(); }
});
