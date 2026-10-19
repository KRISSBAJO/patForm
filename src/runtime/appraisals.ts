/**
 * Goals, appraisals and development (PRD Module 8).
 *
 * The rules that matter most:
 *   - A template cannot be published while its weights are inconsistent; the
 *     error names the section (acceptance 2).
 *   - A cycle copies the published template, and every submitted score keeps
 *     its calculation, so a result is reproducible from stored inputs and is
 *     never recomputed with a newer scale (11.3). Missing scores block
 *     submission; they never become zero (APR-05).
 *   - Each stage has its own window. A manager sees peer responses only after
 *     the peer window closes, and confidential ones only as aggregates from
 *     a large enough group (APR-04, APR-06, acceptance 1).
 *   - Calibration keeps the original score, the adjustment, who made it, the
 *     evidence and the reason, append-only (APR-07, acceptance 3).
 *   - A rating changes nothing else. Promotion and pay recommendations wait
 *     for a separate HR decision, and pay changes only through HR (APR-11,
 *     acceptance 4).
 *   - When a manager changes mid-cycle the old assignment ends: they lose
 *     access, their submitted response stays theirs, and HR assigns a
 *     replacement with a reason (APR-13, acceptance 5).
 * AI does not score, rank or decide anything here (APR-12).
 */
import { inTransaction, type Client, type Pool } from './db.js';
import { InvalidInput } from './errors.js';
import { type Principal } from './policy.js';
import { recordWorkspaceAudit } from './authority.js';
import { enabledModules } from './modules.js';
import { managerOf } from './org.js';

const UUID = /^[0-9a-f-]{36}$/;
const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const num = (v: unknown) => { const n = typeof v === 'number' ? v : Number(String(v ?? '').replace(/[, ]/g, '')); return Number.isFinite(n) ? n : NaN; };
const today = () => new Date().toISOString().slice(0, 10);
const roundTo = (n: number, d: number) => Math.round((n + Number.EPSILON) * 10 ** d) / 10 ** d;
function id(v: unknown, what: string): string { const s = text(v, 36); if (!UUID.test(s)) throw new InvalidInput(`${what} must be an id`); return s; }
function day(v: unknown, what: string, required = false): string | null {
  const s = text(v, 10);
  if (!s) { if (required) throw new InvalidInput(`${what} is required`); return null; }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new InvalidInput(`${what} must be a date`);
  return s;
}

// ------------------------------------------------------------------ access

interface Who { tenantId: string; actorId: string; hr: boolean; admin: boolean; role: string }
async function who(pool: Pool | Client, principal: Principal): Promise<Who> {
  if (principal.kind !== 'actor') throw new InvalidInput('signed-in members only');
  if (!(await enabledModules(pool as Pool, principal.tenantId)).has('appraisals')) {
    throw new InvalidInput('the Appraisals module is switched off for this workspace — an owner can switch it on in Settings');
  }
  const { rows } = await pool.query<{ workspace_role: string; active: boolean }>('select workspace_role, active from actor where id = $1 and tenant_id = $2', [principal.actorId, principal.tenantId]);
  if (!rows[0]?.active || rows[0].workspace_role === 'pre_hire') throw new InvalidInput('appraisals start after your first day');
  const admin = ['owner', 'admin'].includes(rows[0].workspace_role);
  const { rows: t } = await pool.query("select 1 from hr_team_member where tenant_id = $1 and actor_id = $2 and team = 'hr'", [principal.tenantId, principal.actorId]);
  return { tenantId: principal.tenantId, actorId: principal.actorId, hr: admin || !!t[0], admin, role: rows[0].workspace_role };
}
const requireHr = (w: Who) => { if (!w.hr) throw new InvalidInput('only HR can do this'); };
const requireHrAdmin = (w: Who) => { if (!w.hr || !w.admin) throw new InvalidInput('only an owner or admin in HR can do this'); };

// --------------------------------------------------------------- templates

export interface Criterion { key: string; title: string; weight?: number }
export interface Section { key: string; title: string; kind: 'objectives' | 'competencies' | 'narrative'; weight: number; criteria: Criterion[] }
export interface TemplateSnapshot { id?: string; name: string; version: number; scaleMin: number; scaleMax: number; naPolicy: 'block' | 'redistribute'; decimals: number; sections: Section[] }

/**
 * APR-03, acceptance 2. Scored sections' weights must total 100, and the
 * criteria inside each scored section must total 100. Every problem names
 * its section.
 */
export function validateTemplate(sections: unknown): { sections: Section[]; errors: { section: string; message: string }[] } {
  const errors: { section: string; message: string }[] = [];
  if (!Array.isArray(sections) || !sections.length) return { sections: [], errors: [{ section: '(template)', message: 'a template needs at least one section' }] };
  const out: Section[] = sections.map((raw, i) => {
    const s = (raw ?? {}) as Record<string, unknown>;
    const title = text(s.title, 120) || `Section ${i + 1}`;
    const key = text(s.key, 40) || `section_${i + 1}`;
    const kind = (['objectives', 'competencies', 'narrative'].includes(String(s.kind)) ? s.kind : 'competencies') as Section['kind'];
    const weight = kind === 'narrative' ? 0 : num(s.weight ?? 0);
    const criteria = (Array.isArray(s.criteria) ? s.criteria : []).map((c, j) => {
      const o = (c ?? {}) as Record<string, unknown>;
      return { key: text(o.key, 40) || `${key}_${j + 1}`, title: text(o.title, 200) || `Item ${j + 1}`, ...(o.weight !== undefined ? { weight: num(o.weight) } : {}) };
    });
    return { key, title, kind, weight, criteria };
  });
  const keys = new Set<string>();
  for (const s of out) {
    if (keys.has(s.key)) errors.push({ section: s.title, message: `the key ${s.key} is used twice` });
    keys.add(s.key);
    if (s.kind === 'narrative') continue;
    if (!Number.isFinite(s.weight) || s.weight <= 0) errors.push({ section: s.title, message: 'a scored section needs a weight above 0' });
    if (!s.criteria.length) { errors.push({ section: s.title, message: 'a scored section needs at least one item to score' }); continue; }
    const weighted = s.criteria.filter((c) => c.weight !== undefined);
    if (weighted.length && weighted.length !== s.criteria.length) errors.push({ section: s.title, message: 'give every item a weight, or none (equal weights)' });
    if (weighted.length === s.criteria.length) {
      const total = roundTo(s.criteria.reduce((a, c) => a + (c.weight ?? 0), 0), 4);
      if (total !== 100) errors.push({ section: s.title, message: `item weights add up to ${total}, not 100` });
    }
  }
  const scored = out.filter((s) => s.kind !== 'narrative');
  const total = roundTo(scored.reduce((a, s) => a + (Number.isFinite(s.weight) ? s.weight : 0), 0), 4);
  if (scored.length && total !== 100) errors.push({ section: '(all sections)', message: `section weights add up to ${total}, not 100: ${scored.map((s) => `${s.title} ${s.weight}`).join(', ')}` });
  if (!scored.length) errors.push({ section: '(template)', message: 'a template needs at least one scored section' });
  return { sections: out, errors };
}

export interface Response { score?: number | null; na?: boolean; comment?: string }

/**
 * APR-05 and 11.3. Score = sum over scored sections of (section weight x the
 * section's weighted mean of normalised criterion scores). A missing score
 * blocks: it is never zero and never dropped. Not-applicable either blocks or
 * redistributes, as the template says, and the redistribution is recorded.
 */
export function computeScore(t: TemplateSnapshot, responses: Record<string, Response>) {
  const missing: string[] = []; const naBlocked: string[] = []; const bad: string[] = [];
  const detail: { section: string; weight: number; criteria: { key: string; weight: number; score: number | null; normalised: number | null; na: boolean }[]; sectionScore: number | null }[] = [];
  let total = 0; let weightUsed = 0;
  for (const s of t.sections) {
    if (s.kind === 'narrative') continue;
    const base = s.criteria.map((c) => ({ ...c, w: c.weight ?? 100 / s.criteria.length }));
    const rows = base.map((c) => {
      const r = responses[c.key] ?? {};
      if (r.na) { if (t.naPolicy === 'block') naBlocked.push(c.title); return { key: c.key, weight: c.w, score: null, normalised: null, na: true }; }
      const sc = r.score === null || r.score === undefined ? NaN : Number(r.score);
      if (!Number.isFinite(sc)) { missing.push(c.title); return { key: c.key, weight: c.w, score: null, normalised: null, na: false }; }
      if (sc < t.scaleMin || sc > t.scaleMax) { bad.push(`${c.title} (${sc})`); return { key: c.key, weight: c.w, score: sc, normalised: null, na: false }; }
      return { key: c.key, weight: c.w, score: sc, normalised: (sc - t.scaleMin) / (t.scaleMax - t.scaleMin), na: false };
    });
    const counted = rows.filter((r) => !r.na);
    const countedWeight = counted.reduce((a, r) => a + r.weight, 0);
    // Redistribution: the remaining items share the section's weight in
    // proportion to their own weights. A section with nothing left drops out
    // and its weight goes to the other sections, also recorded.
    const sectionScore = countedWeight > 0 && counted.every((r) => r.normalised !== null)
      ? counted.reduce((a, r) => a + (r.normalised as number) * (r.weight / countedWeight), 0) : null;
    detail.push({ section: s.key, weight: s.weight, criteria: rows.map((r) => ({ ...r, weight: roundTo(countedWeight ? (r.na ? 0 : r.weight / countedWeight * 100) : 0, 4) })), sectionScore });
    if (sectionScore !== null) { total += sectionScore * s.weight; weightUsed += s.weight; }
  }
  const problems = [
    ...(missing.length ? [`no score for: ${missing.join(', ')}`] : []),
    ...(naBlocked.length ? [`"not applicable" is not allowed in this template: ${naBlocked.join(', ')}`] : []),
    ...(bad.length ? [`outside the ${t.scaleMin} to ${t.scaleMax} scale: ${bad.join(', ')}`] : []),
  ];
  if (problems.length) return { ok: false as const, problems };
  if (weightUsed === 0) return { ok: false as const, problems: ['every scored item is not applicable; there is nothing to score'] };
  const normalised = total / weightUsed;
  const onScale = roundTo(t.scaleMin + normalised * (t.scaleMax - t.scaleMin), t.decimals);
  return { ok: true as const, score: onScale, calculation: { version: 'appraisal-score-v1', scaleMin: t.scaleMin, scaleMax: t.scaleMax, naPolicy: t.naPolicy, decimals: t.decimals, redistributed: weightUsed !== 100, weightUsed, sections: detail, normalised: roundTo(normalised, 6), score: onScale } };
}

export async function listTemplates(pool: Pool, principal: Principal) {
  const w = await who(pool, principal); requireHr(w);
  const { rows } = await pool.query('select id, name, version, status, scale_min, scale_max, na_policy, decimals, sections, created_at, published_at from review_template where tenant_id = $1 order by name, version desc', [w.tenantId]);
  return rows;
}

/** Drafts are edited in place; changing a published template makes a new draft version. */
export async function saveTemplate(pool: Pool, principal: Principal, body: Record<string, unknown>) {
  const w = await who(pool, principal); requireHr(w);
  const name = text(body.name, 120);
  if (!name) throw new InvalidInput('give the template a name');
  const scaleMin = Math.trunc(num(body.scaleMin ?? 1)); const scaleMax = Math.trunc(num(body.scaleMax ?? 5));
  if (!(scaleMax > scaleMin && scaleMin >= 0 && scaleMax <= 100)) throw new InvalidInput('the scale must run upwards, for example 1 to 5');
  const naPolicy = body.naPolicy === 'redistribute' ? 'redistribute' : 'block';
  const decimals = body.decimals === undefined ? 2 : Math.trunc(num(body.decimals));
  if (!(decimals >= 0 && decimals <= 4)) throw new InvalidInput('decimals must be 0 to 4');
  const { sections } = validateTemplate(body.sections);
  if (!sections.length) throw new InvalidInput('a template needs at least one section');
  if (body.id) {
    const tid = id(body.id, 'id');
    const { rows } = await pool.query<{ status: string; version: number; name: string }>('select status, version, name from review_template where id = $1 and tenant_id = $2', [tid, w.tenantId]);
    if (!rows[0]) throw new InvalidInput('no such template');
    if (rows[0].status === 'draft') {
      await pool.query('update review_template set name = $3, scale_min = $4, scale_max = $5, na_policy = $6, decimals = $7, sections = $8 where id = $1 and tenant_id = $2',
        [tid, w.tenantId, name, scaleMin, scaleMax, naPolicy, decimals, JSON.stringify(sections)]);
      return { id: tid, version: rows[0].version, status: 'draft' };
    }
    const { rows: v } = await pool.query<{ n: number }>('select coalesce(max(version), 0) + 1 as n from review_template where tenant_id = $1 and name = $2', [w.tenantId, rows[0].name]);
    const { rows: made } = await pool.query<{ id: string }>(
      `insert into review_template (tenant_id, name, version, scale_min, scale_max, na_policy, decimals, sections, created_by) values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
      [w.tenantId, rows[0].name, v[0]!.n, scaleMin, scaleMax, naPolicy, decimals, JSON.stringify(sections), w.actorId]);
    return { id: made[0]!.id, version: v[0]!.n, status: 'draft' };
  }
  const { rows } = await pool.query<{ id: string }>(
    `insert into review_template (tenant_id, name, scale_min, scale_max, na_policy, decimals, sections, created_by) values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
    [w.tenantId, name, scaleMin, scaleMax, naPolicy, decimals, JSON.stringify(sections), w.actorId]);
  return { id: rows[0]!.id, version: 1, status: 'draft' };
}

export async function publishTemplate(pool: Pool, principal: Principal, templateId: string) {
  const w = await who(pool, principal); requireHr(w);
  const { rows } = await pool.query<{ status: string; sections: unknown; name: string; version: number }>('select status, sections, name, version from review_template where id = $1 and tenant_id = $2', [templateId, w.tenantId]);
  if (!rows[0]) throw new InvalidInput('no such template');
  if (rows[0].status !== 'draft') throw new InvalidInput('only a draft can be published');
  const { errors } = validateTemplate(rows[0].sections);
  if (errors.length) throw new InvalidInput(`cannot publish: ${errors.map((e) => `${e.section}: ${e.message}`).join('; ')}`);
  await pool.query(`update review_template set status = 'retired' where tenant_id = $1 and name = $2 and status = 'published'`, [w.tenantId, rows[0].name]);
  await pool.query(`update review_template set status = 'published', published_at = now() where id = $1`, [templateId]);
  await recordWorkspaceAudit(pool, { tenantId: w.tenantId, actorId: w.actorId, action: 'appraisal.template_published', targetId: templateId, detail: { name: rows[0].name, version: rows[0].version } });
  return { id: templateId, status: 'published' };
}

// ------------------------------------------------------------------ cycles

const STAGES = ['self', 'peer', 'manager', 'calibration'] as const;
type Windows = Partial<Record<(typeof STAGES)[number], { opens: string; closes: string }>>;
const windowState = (wins: Windows, stage: string): 'not_open' | 'open' | 'closed' | 'none' => {
  const win = (wins as Record<string, { opens: string; closes: string } | undefined>)[stage];
  if (!win) return 'none';
  const t = today();
  return t < win.opens ? 'not_open' : t > win.closes ? 'closed' : 'open';
};

export async function createCycle(pool: Pool, principal: Principal, body: Record<string, unknown>) {
  const w = await who(pool, principal); requireHr(w);
  const name = text(body.name, 120);
  if (!name) throw new InvalidInput('give the cycle a name');
  const kind = text(body.kind, 20);
  if (!['annual', 'quarterly', 'probation', 'project', 'continuous'].includes(kind)) throw new InvalidInput('kind must be annual, quarterly, probation, project or continuous');
  const templateId = id(body.templateId, 'templateId');
  const { rows: t } = await pool.query<{ id: string; name: string; version: number; scale_min: number; scale_max: number; na_policy: 'block' | 'redistribute'; decimals: number; sections: Section[]; status: string }>(
    'select * from review_template where id = $1 and tenant_id = $2', [templateId, w.tenantId]);
  if (!t[0]) throw new InvalidInput('no such template');
  if (t[0].status !== 'published') throw new InvalidInput('a cycle needs a published template');
  const stages: Windows = {};
  const raw = (body.stages ?? {}) as Record<string, { opens?: unknown; closes?: unknown }>;
  for (const s of STAGES) {
    if (!raw[s]) continue;
    const opens = day(raw[s].opens, `${s} opens`, true)!; const closes = day(raw[s].closes, `${s} closes`, true)!;
    if (closes < opens) throw new InvalidInput(`the ${s} window closes before it opens`);
    stages[s] = { opens, closes };
  }
  if (!stages.manager) throw new InvalidInput('a cycle needs a manager review window');
  if (stages.self && stages.self.closes > stages.manager.closes) throw new InvalidInput('self-assessment must close before the manager review closes');
  const snapshot: TemplateSnapshot = { id: t[0].id, name: t[0].name, version: t[0].version, scaleMin: t[0].scale_min, scaleMax: t[0].scale_max, naPolicy: t[0].na_policy, decimals: t[0].decimals, sections: t[0].sections };
  const e = (body.eligibility ?? {}) as Record<string, unknown>;
  const eligibility = {
    employmentTypes: Array.isArray(e.employmentTypes) ? e.employmentTypes.map((x) => text(x, 20)).filter(Boolean) : null,
    startedBefore: day(e.startedBefore, 'startedBefore'),
    unitIds: Array.isArray(e.unitIds) ? e.unitIds.map((x) => id(x, 'unitId')) : null,
  };
  const peerMode = body.peerMode === 'identified' ? 'identified' : 'confidential';
  const minCohort = body.minCohort === undefined ? 3 : Math.trunc(num(body.minCohort));
  if (!(minCohort >= 2 && minCohort <= 20)) throw new InvalidInput('minCohort must be 2 to 20');
  const { rows } = await pool.query<{ id: string }>(
    `insert into review_cycle (tenant_id, name, kind, template, template_id, eligibility, stages, peer_mode, min_cohort, created_by) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
    [w.tenantId, name, kind, JSON.stringify(snapshot), templateId, JSON.stringify(eligibility), JSON.stringify(stages), peerMode, minCohort, w.actorId]);
  return { id: rows[0]!.id, status: 'draft' };
}

/** APR-01: the eligibility snapshot, with the reason for anyone left out. */
export async function launchCycle(pool: Pool, principal: Principal, cycleId: string) {
  const w = await who(pool, principal); requireHrAdmin(w);
  return inTransaction(pool, async (client) => {
    const { rows } = await client.query<{ status: string; eligibility: { employmentTypes: string[] | null; startedBefore: string | null; unitIds: string[] | null }; stages: Windows }>(
      'select status, eligibility, stages from review_cycle where id = $1 and tenant_id = $2 for update', [cycleId, w.tenantId]);
    const c = rows[0];
    if (!c) throw new InvalidInput('no such cycle');
    if (c.status !== 'draft') throw new InvalidInput('this cycle has already been launched');
    const { rows: people } = await client.query<{ id: string; org_unit_id: string | null; employment_type: string | null; start_date: string | null; status: string | null }>(
      `select a.id, a.org_unit_id, e.employment_type, e.start_date::text, e.status
         from actor a left join employee_record e on e.actor_id = a.id
        where a.tenant_id = $1 and a.active and a.workspace_role <> 'pre_hire'`, [w.tenantId]);
    let eligible = 0;
    for (const p of people) {
      let reason: string | null = null;
      const el = c.eligibility;
      if (p.status && p.status !== 'active') reason = `employment status is ${p.status}`;
      else if (el.employmentTypes?.length && !el.employmentTypes.includes(p.employment_type ?? 'employee')) reason = `type ${p.employment_type ?? 'employee'} is not in this cycle`;
      else if (el.startedBefore && (!p.start_date || p.start_date >= el.startedBefore)) reason = `started on or after ${el.startedBefore}`;
      else if (el.unitIds?.length && !el.unitIds.includes(p.org_unit_id ?? '')) reason = 'unit is not in this cycle';
      const mgr = reason ? null : (await managerOf(client, { tenantId: w.tenantId, actorId: p.id, at: new Date() }))?.id ?? null;
      const { rows: part } = await client.query<{ id: string }>(
        `insert into review_participant (tenant_id, cycle_id, actor_id, manager_id, eligible, reason, needs_reviewer, reviewer_note) values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
        [w.tenantId, cycleId, p.id, mgr, !reason, reason, !reason && !mgr, !reason && !mgr ? 'no manager on file' : null]);
      if (reason) continue;
      eligible++;
      if (c.stages.self) await client.query(`insert into reviewer_assignment (participant_id, reviewer_id, stage, assigned_by, reason) values ($1, $2, 'self', $3, 'self-assessment')`, [part[0]!.id, p.id, w.actorId]);
      if (mgr) await client.query(`insert into reviewer_assignment (participant_id, reviewer_id, stage, assigned_by, reason) values ($1, $2, 'manager', $3, 'manager from the directory at launch')`, [part[0]!.id, mgr, w.actorId]);
    }
    await client.query(`update review_cycle set status = 'active', launched_at = now() where id = $1`, [cycleId]);
    await recordWorkspaceAudit(client, { tenantId: w.tenantId, actorId: w.actorId, action: 'appraisal.cycle_launched', targetId: cycleId, detail: { eligible, total: people.length } });
    return { id: cycleId, eligible, excluded: people.length - eligible };
  });
}

/**
 * APR-13, acceptance 5. A manager assignment whose reviewer is no longer the
 * participant's manager, or no longer active, ends: access goes with it; the
 * submitted response stays attributed. The participant is flagged for HR.
 */
export async function syncReviewers(client: Client | Pool, tenantId: string): Promise<number> {
  const { rows } = await client.query<{ id: string; participant_id: string; reviewer_id: string; actor_id: string; reviewer_active: boolean }>(
    `select ra.id, ra.participant_id, ra.reviewer_id, p.actor_id, a.active as reviewer_active
       from reviewer_assignment ra join review_participant p on p.id = ra.participant_id join review_cycle c on c.id = p.cycle_id
       join actor a on a.id = ra.reviewer_id
      where c.tenant_id = $1 and c.status = 'active' and ra.active and ra.stage = 'manager' and ra.reason like 'manager from the directory%'`, [tenantId]);
  let ended = 0;
  for (const r of rows) {
    const current = (await managerOf(client, { tenantId, actorId: r.actor_id, at: new Date() }))?.id ?? null;
    if (r.reviewer_active && current === r.reviewer_id) continue;
    await client.query(`update reviewer_assignment set active = false, ended_at = now(), ended_reason = $2 where id = $1`, [r.id, r.reviewer_active ? 'no longer the manager' : 'reviewer deactivated']);
    await client.query(`update review_participant set needs_reviewer = true, reviewer_note = $2 where id = $1`, [r.participant_id, r.reviewer_active ? 'manager changed during the cycle' : 'manager left during the cycle']);
    ended++;
  }
  return ended;
}

/** HR assigns a replacement or additional reviewer, with a recorded reason. */
export async function assignReviewer(pool: Pool, principal: Principal, participantId: string, body: Record<string, unknown>) {
  const w = await who(pool, principal); requireHr(w);
  const reviewerId = id(body.reviewerId, 'reviewerId');
  const stage = text(body.stage, 12) || 'manager';
  if (!['manager', 'additional', 'peer'].includes(stage)) throw new InvalidInput('stage must be manager, additional or peer');
  const reason = text(body.reason, 300);
  if (!reason) throw new InvalidInput('record why this reviewer');
  return inTransaction(pool, async (client) => {
    const { rows } = await client.query<{ actor_id: string; status: string }>(
      `select p.actor_id, c.status from review_participant p join review_cycle c on c.id = p.cycle_id where p.id = $1 and c.tenant_id = $2 for update of p`, [participantId, w.tenantId]);
    if (!rows[0]) throw new InvalidInput('no such participant');
    if (rows[0].status !== 'active') throw new InvalidInput('this cycle is not active');
    if (rows[0].actor_id === reviewerId) throw new InvalidInput('nobody reviews themselves outside the self-assessment');
    const { rows: rv } = await client.query('select 1 from actor where id = $1 and tenant_id = $2 and active', [reviewerId, w.tenantId]);
    if (!rv[0]) throw new InvalidInput('no such reviewer');
    if (stage === 'manager') await client.query(`update reviewer_assignment set active = false, ended_at = now(), ended_reason = 'replaced by HR' where participant_id = $1 and stage = 'manager' and active`, [participantId]);
    await client.query(`insert into reviewer_assignment (participant_id, reviewer_id, stage, assigned_by, reason) values ($1, $2, $3, $4, $5) on conflict do nothing`, [participantId, reviewerId, stage, w.actorId, reason]);
    if (stage === 'manager') await client.query(`update review_participant set needs_reviewer = false, reviewer_note = $2 where id = $1`, [participantId, `reviewer assigned by HR: ${reason}`]);
    await recordWorkspaceAudit(client, { tenantId: w.tenantId, actorId: w.actorId, action: 'appraisal.reviewer_assigned', targetId: participantId, detail: { reviewerId, stage, reason } });
    return { participantId, reviewerId, stage };
  });
}

/** A participant (or their manager) asks a colleague for peer feedback. */
export async function addPeerReviewer(pool: Pool, principal: Principal, participantId: string, body: Record<string, unknown>) {
  const w = await who(pool, principal);
  const reviewerId = id(body.reviewerId, 'reviewerId');
  const { rows } = await pool.query<{ actor_id: string; manager_id: string | null }>(
    `select p.actor_id, p.manager_id from review_participant p join review_cycle c on c.id = p.cycle_id where p.id = $1 and c.tenant_id = $2 and c.status = 'active'`, [participantId, w.tenantId]);
  if (!rows[0]) throw new InvalidInput('no such participant in an active cycle');
  if (!(w.hr || rows[0].actor_id === w.actorId || rows[0].manager_id === w.actorId)) throw new InvalidInput('only the person, their manager or HR can ask for peer feedback');
  if (reviewerId === rows[0].actor_id) throw new InvalidInput('peer feedback comes from someone else');
  await pool.query(`insert into reviewer_assignment (participant_id, reviewer_id, stage, assigned_by, reason) values ($1, $2, 'peer', $3, 'peer feedback requested') on conflict do nothing`, [participantId, reviewerId, w.actorId]);
  return { participantId, reviewerId };
}

// ------------------------------------------------------------- assessments

export async function myAssignments(pool: Pool, principal: Principal) {
  const w = await who(pool, principal);
  await syncReviewers(pool, w.tenantId);
  const { rows } = await pool.query<{ id: string; stage: string; participant_id: string; person: string; cycle: string; cycle_id: string; stages: Windows; status: string | null; submitted_at: Date | null }>(
    `select ra.id, ra.stage, ra.participant_id, a.display_name as person, c.name as cycle, c.id as cycle_id, c.stages, s.status, s.submitted_at
       from reviewer_assignment ra join review_participant p on p.id = ra.participant_id join review_cycle c on c.id = p.cycle_id
       join actor a on a.id = p.actor_id left join assessment s on s.assignment_id = ra.id
      where ra.reviewer_id = $1 and ra.active and c.tenant_id = $2 and c.status = 'active' order by c.name, ra.stage, a.display_name`, [w.actorId, w.tenantId]);
  return rows.map((r) => ({ ...r, window: windowState(r.stages, r.stage), stages: undefined }));
}

async function assignmentFor(client: Client | Pool, w: Who, assignmentId: string) {
  if (!UUID.test(assignmentId)) throw new InvalidInput('no such review');
  const { rows } = await client.query<{ id: string; stage: string; reviewer_id: string; active: boolean; participant_id: string; actor_id: string; cycle_id: string; template: TemplateSnapshot; stages: Windows; peer_mode: string; min_cohort: number; cycle_status: string }>(
    `select ra.id, ra.stage, ra.reviewer_id, ra.active, ra.participant_id, p.actor_id, c.id as cycle_id, c.template, c.stages, c.peer_mode, c.min_cohort, c.status as cycle_status
       from reviewer_assignment ra join review_participant p on p.id = ra.participant_id join review_cycle c on c.id = p.cycle_id
      where ra.id = $1 and c.tenant_id = $2`, [assignmentId, w.tenantId]);
  const a = rows[0];
  // An ended assignment is the same as none: access goes with the role.
  if (!a || a.reviewer_id !== w.actorId || !a.active) throw new InvalidInput('no such review for you');
  return a;
}

/** Peer responses as the manager may see them: nothing before release; confidential ones only in aggregate from enough people. */
async function peerView(client: Client | Pool, a: { participant_id: string; stages: Windows; peer_mode: string; min_cohort: number; template: TemplateSnapshot }) {
  const state = windowState(a.stages, 'peer');
  if (state === 'none') return { released: false, note: 'this cycle has no peer feedback' };
  if (state !== 'closed') return { released: false, note: 'peer feedback is released when the peer window closes' };
  const { rows } = await client.query<{ responses: Record<string, Response>; narrative: string | null; reviewer: string }>(
    `select s.responses, s.narrative, r.display_name as reviewer from assessment s join actor r on r.id = s.reviewer_id
      where s.participant_id = $1 and s.stage = 'peer' and s.status = 'submitted'`, [a.participant_id]);
  if (a.peer_mode === 'identified') return { released: true, mode: 'identified', count: rows.length, responses: rows };
  if (rows.length < a.min_cohort) return { released: true, mode: 'confidential', count: rows.length, suppressed: true, note: `fewer than ${a.min_cohort} responses; not shown, to protect who said what` };
  const averages: Record<string, number> = {};
  for (const s of a.template.sections) for (const c of s.criteria) {
    const vals = rows.map((r) => r.responses[c.key]?.score).filter((x): x is number => typeof x === 'number');
    if (vals.length >= a.min_cohort) averages[c.title] = roundTo(vals.reduce((x, y) => x + y, 0) / vals.length, 2);
  }
  // Comments are not shown in confidential mode: wording can identify the writer.
  return { released: true, mode: 'confidential', count: rows.length, averages };
}

export async function assessmentForm(pool: Pool, principal: Principal, assignmentId: string) {
  const w = await who(pool, principal);
  await syncReviewers(pool, w.tenantId);
  const a = await assignmentFor(pool, w, assignmentId);
  const { rows: mine } = await pool.query('select responses, narrative, recommendation, status, score, submitted_at from assessment where assignment_id = $1', [a.id]);
  const out: Record<string, unknown> = { stage: a.stage, window: windowState(a.stages, a.stage), template: a.template, mine: mine[0] ?? null };
  if (a.stage === 'manager' || a.stage === 'additional') {
    const selfState = windowState(a.stages, 'self');
    const { rows: self } = await pool.query(`select responses, narrative, score, submitted_at from assessment where participant_id = $1 and stage = 'self' and status = 'submitted'`, [a.participant_id]);
    // The self-assessment shows once submitted or once its window has closed.
    out.self = self[0] && (selfState === 'closed' || self[0].submitted_at) ? self[0] : null;
    out.peers = await peerView(pool, a);
    const { rows: goals } = await pool.query(`select title, success_criteria, weight, progress, status, evidence from goal where owner_id = $1 and (cycle_id = $2 or cycle_id is null) and status <> 'withdrawn' order by weight desc`, [a.actor_id, a.cycle_id]);
    out.goals = goals;
  }
  return out;
}

export async function saveAssessment(pool: Pool, principal: Principal, assignmentId: string, body: Record<string, unknown>) {
  const w = await who(pool, principal);
  return inTransaction(pool, async (client) => {
    await syncReviewers(client, w.tenantId);
    const a = await assignmentFor(client, w, assignmentId);
    if (a.cycle_status !== 'active') throw new InvalidInput('this cycle is not open for reviews');
    const state = windowState(a.stages, a.stage === 'additional' ? 'manager' : a.stage);
    if (state === 'not_open') throw new InvalidInput(`the ${a.stage} window has not opened yet`);
    if (state === 'closed') throw new InvalidInput(`the ${a.stage} window has closed`);
    const { rows: existing } = await client.query<{ status: string }>('select status from assessment where assignment_id = $1 for update', [a.id]);
    if (existing[0]?.status === 'submitted') throw new InvalidInput('this review is already submitted');
    const responses = (body.responses && typeof body.responses === 'object' ? body.responses : {}) as Record<string, Response>;
    const narrative = text(body.narrative, 8000) || null;
    let recommendation: { kind: string; detail: string } | null = null;
    if (body.recommendation && a.stage === 'manager') {
      const r = body.recommendation as Record<string, unknown>;
      const kind = text(r.kind, 20);
      if (!['promotion', 'pay_increase'].includes(kind)) throw new InvalidInput('a recommendation is a promotion or a pay increase');
      const detail = text(r.detail, 1000);
      if (!detail) throw new InvalidInput('describe the recommendation');
      recommendation = { kind, detail };
    }
    let score: number | null = null; let calculation: unknown = null;
    const submit = body.submit === true;
    if (submit) {
      const result = computeScore(a.template, responses);
      if (!result.ok) throw new InvalidInput(`cannot submit yet: ${result.problems.join('; ')}`);
      score = result.score; calculation = result.calculation;
    }
    await client.query(
      `insert into assessment (participant_id, assignment_id, reviewer_id, stage, responses, narrative, recommendation, calculation, score, status, submitted_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())
       on conflict (assignment_id) do update set responses = excluded.responses, narrative = excluded.narrative, recommendation = excluded.recommendation,
         calculation = excluded.calculation, score = excluded.score, status = excluded.status, submitted_at = excluded.submitted_at, updated_at = now()`,
      [a.participant_id, a.id, w.actorId, a.stage, JSON.stringify(responses), narrative, recommendation ? JSON.stringify(recommendation) : null,
        calculation ? JSON.stringify(calculation) : null, score, submit ? 'submitted' : 'draft', submit ? new Date() : null]);
    return { status: submit ? 'submitted' : 'draft', score };
  });
}

// ----------------------------------------------------- calibration, publish

async function managerScore(client: Client | Pool, participantId: string): Promise<number | null> {
  const { rows } = await client.query<{ score: string }>(`select score from assessment where participant_id = $1 and stage = 'manager' and status = 'submitted' order by submitted_at desc limit 1`, [participantId]);
  return rows[0] ? Number(rows[0].score) : null;
}
async function currentScore(client: Client | Pool, participantId: string): Promise<number | null> {
  const { rows } = await client.query<{ adjusted_score: string }>('select adjusted_score from calibration_adjustment where participant_id = $1 order by id desc limit 1', [participantId]);
  return rows[0] ? Number(rows[0].adjusted_score) : await managerScore(client, participantId);
}

export async function listCycles(pool: Pool, principal: Principal) {
  const w = await who(pool, principal); requireHr(w);
  await syncReviewers(pool, w.tenantId);
  const { rows } = await pool.query(
    `select c.id, c.name, c.kind, c.status, c.stages, c.peer_mode, c.min_cohort, c.created_at, c.launched_at, c.published_at, c.template->>'name' as template_name, c.template->>'version' as template_version,
            (select count(*)::int from review_participant p where p.cycle_id = c.id and p.eligible) as participants,
            (select count(*)::int from review_participant p where p.cycle_id = c.id and p.needs_reviewer) as needs_reviewer
       from review_cycle c where c.tenant_id = $1 order by c.created_at desc`, [w.tenantId]);
  return rows;
}

/** APR-07: the comparison view for HR, with every score and who reviewed. */
export async function calibrationView(pool: Pool, principal: Principal, cycleId: string) {
  const w = await who(pool, principal); requireHr(w);
  await syncReviewers(pool, w.tenantId);
  const { rows } = await pool.query<{ id: string; name: string; actor_id: string; needs_reviewer: boolean; reviewer_note: string | null; unit: string | null }>(
    `select p.id, a.display_name as name, p.actor_id, p.needs_reviewer, p.reviewer_note, u.name as unit
       from review_participant p join actor a on a.id = p.actor_id left join org_unit u on u.id = a.org_unit_id
      where p.cycle_id = $1 and p.eligible order by a.display_name`, [cycleId]);
  const out = [];
  for (const p of rows) {
    const { rows: s } = await pool.query<{ stage: string; score: string | null; status: string; reviewer: string; active: boolean }>(
      `select s.stage, s.score, s.status, r.display_name as reviewer, ra.active from assessment s join actor r on r.id = s.reviewer_id join reviewer_assignment ra on ra.id = s.assignment_id
        where s.participant_id = $1`, [p.id]);
    const { rows: adj } = await pool.query(`select original_score, adjusted_score, evidence, reason, occurred_at, (select display_name from actor where id = actor_id) as actor from calibration_adjustment where participant_id = $1 order by id`, [p.id]);
    const { rows: rec } = await pool.query(`select recommendation from assessment where participant_id = $1 and stage = 'manager' and status = 'submitted' and recommendation is not null limit 1`, [p.id]);
    out.push({ ...p, self: s.find((x) => x.stage === 'self') ?? null, manager: s.find((x) => x.stage === 'manager' && x.status === 'submitted') ?? s.find((x) => x.stage === 'manager') ?? null,
      peers: s.filter((x) => x.stage === 'peer' && x.status === 'submitted').length, current: await currentScore(pool, p.id), adjustments: adj, recommendation: rec[0]?.recommendation ?? null });
  }
  return out;
}

/** Acceptance 3: the original stays; each adjustment is a new, permanent row. */
export async function adjustScore(pool: Pool, principal: Principal, participantId: string, body: Record<string, unknown>) {
  const w = await who(pool, principal); requireHr(w);
  const score = num(body.score);
  const evidence = text(body.evidence, 2000); const reason = text(body.reason, 2000);
  if (!evidence) throw new InvalidInput('give the evidence for the adjustment');
  if (!reason) throw new InvalidInput('explain the adjustment');
  return inTransaction(pool, async (client) => {
    const { rows } = await client.query<{ status: string; template: TemplateSnapshot }>(
      `select c.status, c.template from review_participant p join review_cycle c on c.id = p.cycle_id where p.id = $1 and c.tenant_id = $2 for update of p`, [participantId, w.tenantId]);
    if (!rows[0]) throw new InvalidInput('no such participant');
    if (rows[0].status !== 'active') throw new InvalidInput('calibration happens before publication');
    const t = rows[0].template;
    if (!(score >= t.scaleMin && score <= t.scaleMax)) throw new InvalidInput(`the score must be on the ${t.scaleMin} to ${t.scaleMax} scale`);
    const original = await currentScore(client, participantId);
    if (original === null) throw new InvalidInput('there is no submitted manager review to calibrate');
    await client.query(`insert into calibration_adjustment (participant_id, original_score, adjusted_score, evidence, reason, actor_id) values ($1, $2, $3, $4, $5, $6)`,
      [participantId, original, roundTo(score, t.decimals), evidence, reason, w.actorId]);
    await recordWorkspaceAudit(client, { tenantId: w.tenantId, actorId: w.actorId, action: 'appraisal.calibrated', targetId: participantId, detail: { original, adjusted: score } });
    return { participantId, original, adjusted: roundTo(score, t.decimals) };
  });
}

/** APR-08, APR-11. Publishing records results and opens recommendations as proposals; nothing else changes. */
export async function publishCycle(pool: Pool, principal: Principal, cycleId: string, body: Record<string, unknown> = {}) {
  const w = await who(pool, principal); requireHrAdmin(w);
  return inTransaction(pool, async (client) => {
    const { rows } = await client.query<{ status: string }>('select status from review_cycle where id = $1 and tenant_id = $2 for update', [cycleId, w.tenantId]);
    if (!rows[0]) throw new InvalidInput('no such cycle');
    if (rows[0].status !== 'active') throw new InvalidInput('only an active cycle can be published');
    const { rows: parts } = await client.query<{ id: string; name: string }>(`select p.id, a.display_name as name from review_participant p join actor a on a.id = p.actor_id where p.cycle_id = $1 and p.eligible`, [cycleId]);
    const missing: string[] = []; let published = 0;
    for (const p of parts) {
      const mscore = await managerScore(client, p.id);
      if (mscore === null) { missing.push(p.name); continue; }
      const { rows: m } = await client.query<{ narrative: string | null; recommendation: { kind: string; detail: string } | null }>(`select narrative, recommendation from assessment where participant_id = $1 and stage = 'manager' and status = 'submitted' order by submitted_at desc limit 1`, [p.id]);
      await client.query(`insert into review_result (participant_id, manager_score, calibrated_score, summary) values ($1, $2, $3, $4) on conflict (participant_id) do nothing`,
        [p.id, mscore, await currentScore(client, p.id), m[0]?.narrative ?? null]);
      if (m[0]?.recommendation) await client.query(`insert into review_recommendation (tenant_id, participant_id, kind, detail) values ($1, $2, $3, $4)`, [w.tenantId, p.id, m[0].recommendation.kind, m[0].recommendation.detail]);
      published++;
    }
    if (missing.length && body.allowIncomplete !== true) throw new InvalidInput(`${missing.length} people have no submitted manager review: ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? '…' : ''}. Finish them, or publish without them`);
    await client.query(`update review_cycle set status = 'published', published_at = now() where id = $1`, [cycleId]);
    await recordWorkspaceAudit(client, { tenantId: w.tenantId, actorId: w.actorId, action: 'appraisal.cycle_published', targetId: cycleId, detail: { published, withoutReview: missing.length } });
    return { published, withoutReview: missing };
  });
}

// ---------------------------------------------------- employee: result, appeal

export async function myResults(pool: Pool, principal: Principal) {
  const w = await who(pool, principal);
  const { rows } = await pool.query(
    `select p.id as participant_id, c.name as cycle, c.template->>'scaleMin' as scale_min, c.template->>'scaleMax' as scale_max,
            r.manager_score, r.calibrated_score, r.summary, r.published_at, r.acknowledged_at, r.acknowledgement, r.appeal_status,
            (select outcome from review_appeal x where x.participant_id = p.id order by created_at desc limit 1) as appeal_outcome
       from review_result r join review_participant p on p.id = r.participant_id join review_cycle c on c.id = p.cycle_id
      where p.actor_id = $1 and c.tenant_id = $2 order by r.published_at desc`, [w.actorId, w.tenantId]);
  return rows;
}

/** APR-08: acknowledgement records receipt, not agreement. */
export async function acknowledgeResult(pool: Pool, principal: Principal, participantId: string) {
  const w = await who(pool, principal);
  const statement = 'I confirm I have received my review. This does not mean I agree with it.';
  const { rowCount } = await pool.query(
    `update review_result r set acknowledged_at = now(), acknowledgement = $3 from review_participant p
      where r.participant_id = p.id and p.id = $1 and p.actor_id = $2 and r.acknowledged_at is null`, [participantId, w.actorId, statement]);
  if (!rowCount) throw new InvalidInput('nothing to acknowledge');
  return { statement };
}

export async function appealResult(pool: Pool, principal: Principal, participantId: string, body: Record<string, unknown>) {
  const w = await who(pool, principal);
  const reason = text(body.reason, 4000);
  if (!reason) throw new InvalidInput('say what you are appealing and why');
  return inTransaction(pool, async (client) => {
    const { rows } = await client.query<{ published_at: Date; appeal_status: string }>(
      `select r.published_at, r.appeal_status from review_result r join review_participant p on p.id = r.participant_id where p.id = $1 and p.actor_id = $2 for update of r`, [participantId, w.actorId]);
    if (!rows[0]) throw new InvalidInput('no published review of yours');
    if (rows[0].appeal_status === 'open') throw new InvalidInput('your appeal is already open');
    if (Date.now() - rows[0].published_at.getTime() > 30 * 86400000) throw new InvalidInput('appeals close 30 days after publication');
    const due = new Date(Date.now() + 21 * 86400000).toISOString().slice(0, 10);
    await client.query(`insert into review_appeal (participant_id, reason, due_date) values ($1, $2, $3)`, [participantId, reason, due]);
    await client.query(`update review_result set appeal_status = 'open' where participant_id = $1`, [participantId]);
    return { status: 'open', due };
  });
}

/** APR-09: the reviewer must have had no part in the review. */
export async function assignAppealReviewer(pool: Pool, principal: Principal, appealId: string, body: Record<string, unknown>) {
  const w = await who(pool, principal); requireHrAdmin(w);
  const reviewerId = id(body.reviewerId, 'reviewerId');
  return inTransaction(pool, async (client) => {
    const { rows } = await client.query<{ participant_id: string; actor_id: string; manager_id: string | null; status: string }>(
      `select x.participant_id, p.actor_id, p.manager_id, x.status from review_appeal x join review_participant p on p.id = x.participant_id join review_cycle c on c.id = p.cycle_id
        where x.id = $1 and c.tenant_id = $2 for update of x`, [appealId, w.tenantId]);
    const a = rows[0];
    if (!a) throw new InvalidInput('no such appeal');
    if (a.status !== 'open') throw new InvalidInput('this appeal is decided');
    const conflicts: string[] = [];
    if (reviewerId === a.actor_id) conflicts.push('it is their own review');
    if (reviewerId === a.manager_id || reviewerId === (await managerOf(client, { tenantId: w.tenantId, actorId: a.actor_id, at: new Date() }))?.id) conflicts.push('they are or were the manager');
    const { rows: rev } = await client.query('select 1 from assessment where participant_id = $1 and reviewer_id = $2', [a.participant_id, reviewerId]);
    if (rev[0]) conflicts.push('they reviewed this person in the cycle');
    const { rows: cal } = await client.query('select 1 from calibration_adjustment where participant_id = $1 and actor_id = $2', [a.participant_id, reviewerId]);
    if (cal[0]) conflicts.push('they calibrated this score');
    if (conflicts.length) throw new InvalidInput(`conflict of interest: ${conflicts.join('; ')}`);
    await client.query('update review_appeal set reviewer_id = $2 where id = $1', [appealId, reviewerId]);
    return { appealId, reviewerId };
  });
}

export async function listAppeals(pool: Pool, principal: Principal) {
  const w = await who(pool, principal);
  const { rows } = await pool.query(
    `select x.id, x.reason, x.status, x.due_date, x.outcome, x.new_score, x.created_at, a.display_name as employee, c.name as cycle, r.display_name as reviewer, x.reviewer_id,
            rr.calibrated_score
       from review_appeal x join review_participant p on p.id = x.participant_id join actor a on a.id = p.actor_id join review_cycle c on c.id = p.cycle_id
       left join actor r on r.id = x.reviewer_id left join review_result rr on rr.participant_id = p.id
      where c.tenant_id = $1 and ($2 or x.reviewer_id = $3) order by x.status <> 'open', x.due_date`, [w.tenantId, w.hr, w.actorId]);
  return rows;
}

export async function decideAppeal(pool: Pool, principal: Principal, appealId: string, body: Record<string, unknown>) {
  const w = await who(pool, principal);
  const outcome = body.outcome === 'changed' ? 'changed' : body.outcome === 'upheld' ? 'upheld' : null;
  if (!outcome) throw new InvalidInput('outcome must be upheld or changed');
  const note = text(body.note, 4000);
  if (!note) throw new InvalidInput('record the outcome and why');
  return inTransaction(pool, async (client) => {
    const { rows } = await client.query<{ participant_id: string; reviewer_id: string | null; status: string; template: TemplateSnapshot }>(
      `select x.participant_id, x.reviewer_id, x.status, c.template from review_appeal x join review_participant p on p.id = x.participant_id join review_cycle c on c.id = p.cycle_id
        where x.id = $1 and c.tenant_id = $2 for update of x`, [appealId, w.tenantId]);
    const a = rows[0];
    if (!a) throw new InvalidInput('no such appeal');
    if (a.status !== 'open') throw new InvalidInput('this appeal is decided');
    if (a.reviewer_id !== w.actorId) throw new InvalidInput('only the independent reviewer assigned to this appeal can decide it');
    let newScore: number | null = null;
    if (outcome === 'changed') {
      newScore = num(body.newScore);
      if (!(newScore >= a.template.scaleMin && newScore <= a.template.scaleMax)) throw new InvalidInput(`the new score must be on the ${a.template.scaleMin} to ${a.template.scaleMax} scale`);
      const { rows: cur } = await client.query<{ calibrated_score: string }>('select calibrated_score from review_result where participant_id = $1', [a.participant_id]);
      await client.query(`insert into calibration_adjustment (participant_id, original_score, adjusted_score, evidence, reason, actor_id) values ($1, $2, $3, 'Appeal', $4, $5)`,
        [a.participant_id, cur[0]?.calibrated_score ?? null, newScore, note, w.actorId]);
      await client.query('update review_result set calibrated_score = $2 where participant_id = $1', [a.participant_id, newScore]);
    }
    await client.query(`update review_appeal set status = $2, outcome = $3, new_score = $4, decided_at = now() where id = $1`, [appealId, outcome, note, newScore]);
    await client.query(`update review_result set appeal_status = $2 where participant_id = $1`, [a.participant_id, outcome]);
    return { appealId, outcome, newScore };
  });
}

// --------------------------------------------------------- recommendations

export async function listRecommendations(pool: Pool, principal: Principal) {
  const w = await who(pool, principal); requireHr(w);
  const { rows } = await pool.query(
    `select r.id, r.kind, r.detail, r.status, r.decision_note, r.created_at, a.display_name as employee, c.name as cycle
       from review_recommendation r join review_participant p on p.id = r.participant_id join actor a on a.id = p.actor_id join review_cycle c on c.id = p.cycle_id
      where r.tenant_id = $1 order by r.status <> 'proposed', r.created_at desc`, [w.tenantId]);
  return rows;
}

/** APR-11, acceptance 4: approving opens the change; pay itself changes only when HR records it. */
export async function decideRecommendation(pool: Pool, principal: Principal, recId: string, body: Record<string, unknown>) {
  const w = await who(pool, principal); requireHrAdmin(w);
  const status = body.decision === 'approve' ? 'approved' : body.decision === 'decline' ? 'declined' : null;
  if (!status) throw new InvalidInput('decide approve or decline');
  const note = text(body.note, 1000);
  if (!note) throw new InvalidInput('record the decision');
  const { rowCount } = await pool.query(`update review_recommendation set status = $3, decided_by = $4, decided_at = now(), decision_note = $5 where id = $1 and tenant_id = $2 and status = 'proposed'`,
    [recId, w.tenantId, status, w.actorId, note]);
  if (!rowCount) throw new InvalidInput('no such open recommendation');
  await recordWorkspaceAudit(pool, { tenantId: w.tenantId, actorId: w.actorId, action: `appraisal.recommendation_${status}`, targetId: recId, detail: { note } });
  return { id: recId, status, next: status === 'approved' ? 'Record the pay change or start the transfer on the HR page; nothing has changed yet.' : null };
}

// ------------------------------------------------------------------- goals

async function canManage(client: Client | Pool, w: Who, ownerId: string): Promise<boolean> {
  if (w.hr) return true;
  return (await managerOf(client, { tenantId: w.tenantId, actorId: ownerId, at: new Date() }))?.id === w.actorId;
}

export async function listGoals(pool: Pool, principal: Principal, opts: { ownerId?: string } = {}) {
  const w = await who(pool, principal);
  const ownerId = opts.ownerId ?? w.actorId;
  if (ownerId !== w.actorId && !(await canManage(pool, w, ownerId))) throw new InvalidInput('you can see your own goals and your reports\'');
  const { rows } = await pool.query(
    `select g.id, g.title, g.description, g.success_criteria, g.weight, g.target_date::text, g.status, g.progress, g.evidence, g.cycle_id, g.aligned_to, a.title as aligned_title,
            (select count(*)::int from goal_revision r where r.goal_id = g.id and r.status = 'pending') as pending_changes
       from goal g left join goal a on a.id = g.aligned_to where g.tenant_id = $1 and g.owner_id = $2 order by g.status = 'withdrawn', g.target_date nulls last`, [w.tenantId, ownerId]);
  return rows;
}

/** Goals of the people who report to me, with changes waiting for my approval. */
export async function teamGoals(pool: Pool, principal: Principal) {
  const w = await who(pool, principal);
  const { rows } = await pool.query(
    `select g.id, g.title, g.success_criteria, g.weight, g.status, g.progress, a.display_name as owner,
            (select json_agg(json_build_object('id', r.id, 'proposed', r.proposed, 'previous', r.previous, 'reason', r.reason)) from goal_revision r where r.goal_id = g.id and r.status = 'pending') as pending
       from goal g join actor a on a.id = g.owner_id
      where g.tenant_id = $1 and g.status <> 'withdrawn'
        and exists (select 1 from reporting_line l where l.actor_id = g.owner_id and l.manager_id = $2 and l.kind = 'primary' and l.effective_from <= now() and (l.effective_to is null or l.effective_to > now()))
      order by a.display_name, g.title`, [w.tenantId, w.actorId]);
  return rows;
}

export async function createGoal(pool: Pool, principal: Principal, body: Record<string, unknown>) {
  const w = await who(pool, principal);
  const ownerId = body.ownerId ? id(body.ownerId, 'ownerId') : w.actorId;
  if (ownerId !== w.actorId && !(await canManage(pool, w, ownerId))) throw new InvalidInput('you can set goals for yourself and your reports');
  const title = text(body.title, 200); const criteria = text(body.successCriteria, 2000);
  if (!title) throw new InvalidInput('give the goal a title');
  if (!criteria) throw new InvalidInput('say how success will be measured');
  const weight = body.weight === undefined || body.weight === '' ? 0 : num(body.weight);
  if (!(weight >= 0 && weight <= 100)) throw new InvalidInput('weight must be 0 to 100');
  const aligned = body.alignedTo ? id(body.alignedTo, 'alignedTo') : null;
  if (aligned) { const { rows } = await pool.query('select 1 from goal where id = $1 and tenant_id = $2', [aligned, w.tenantId]); if (!rows[0]) throw new InvalidInput('no such goal to align to'); }
  const cycleId = body.cycleId ? id(body.cycleId, 'cycleId') : null;
  const { rows } = await pool.query<{ id: string }>(
    `insert into goal (tenant_id, owner_id, cycle_id, aligned_to, title, description, success_criteria, weight, target_date) values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
    [w.tenantId, ownerId, cycleId, aligned, title, text(body.description, 2000) || null, criteria, weight, day(body.targetDate, 'targetDate')]);
  return { id: rows[0]!.id, status: 'draft' };
}

export async function approveGoal(pool: Pool, principal: Principal, goalId: string) {
  const w = await who(pool, principal);
  const { rows } = await pool.query<{ owner_id: string; status: string }>('select owner_id, status from goal where id = $1 and tenant_id = $2', [goalId, w.tenantId]);
  if (!rows[0]) throw new InvalidInput('no such goal');
  if (rows[0].owner_id === w.actorId) throw new InvalidInput('your manager approves your goals');
  if (!(await canManage(pool, w, rows[0].owner_id))) throw new InvalidInput("only the person's manager or HR can approve their goals");
  if (rows[0].status !== 'draft') throw new InvalidInput('only a draft goal needs approval');
  await pool.query(`update goal set status = 'approved', approved_by = $2, updated_at = now() where id = $1`, [goalId, w.actorId]);
  return { id: goalId, status: 'approved' };
}

/**
 * APR-02. Progress and evidence are the owner's to update. On an approved
 * goal, a change to what it means (title, measure, weight, date) is a
 * revision that waits for the manager, with the history kept.
 */
export async function updateGoal(pool: Pool, principal: Principal, goalId: string, body: Record<string, unknown>) {
  const w = await who(pool, principal);
  return inTransaction(pool, async (client) => {
    const { rows } = await client.query<{ owner_id: string; status: string; title: string; success_criteria: string; weight: string; target_date: string | null }>(
      'select owner_id, status, title, success_criteria, weight, target_date::text from goal where id = $1 and tenant_id = $2 for update', [goalId, w.tenantId]);
    const g = rows[0];
    if (!g) throw new InvalidInput('no such goal');
    const own = g.owner_id === w.actorId;
    if (!own && !(await canManage(client, w, g.owner_id))) throw new InvalidInput('not your goal');
    if (body.progress !== undefined || body.evidence !== undefined) {
      const p = body.progress === undefined ? null : Math.trunc(num(body.progress));
      if (p !== null && !(p >= 0 && p <= 100)) throw new InvalidInput('progress must be 0 to 100');
      await client.query('update goal set progress = coalesce($2, progress), evidence = coalesce($3, evidence), updated_at = now() where id = $1', [goalId, p, text(body.evidence, 4000) || null]);
    }
    if (body.status !== undefined) {
      const s = text(body.status, 20);
      if (!['achieved', 'missed', 'withdrawn'].includes(s)) throw new InvalidInput('status must be achieved, missed or withdrawn');
      if (!(await canManage(client, w, g.owner_id))) throw new InvalidInput("the manager closes a goal");
      await client.query('update goal set status = $2, updated_at = now() where id = $1', [goalId, s]);
    }
    const material: Record<string, unknown> = {};
    if (body.title !== undefined) material.title = text(body.title, 200);
    if (body.successCriteria !== undefined) material.success_criteria = text(body.successCriteria, 2000);
    if (body.weight !== undefined) { const n = num(body.weight); if (!(n >= 0 && n <= 100)) throw new InvalidInput('weight must be 0 to 100'); material.weight = n; }
    if (body.targetDate !== undefined) material.target_date = day(body.targetDate, 'targetDate');
    if (!Object.keys(material).length) return { id: goalId, revision: null };
    if (g.status === 'draft') {
      const sets = Object.keys(material).map((k, i) => `${k} = $${i + 2}`);
      await client.query(`update goal set ${sets.join(', ')}, updated_at = now() where id = $1`, [goalId, ...Object.values(material)]);
      return { id: goalId, revision: null };
    }
    const reason = text(body.reason, 1000);
    if (!reason) throw new InvalidInput('say why the goal is changing; your manager approves the change');
    const previous = { title: g.title, success_criteria: g.success_criteria, weight: Number(g.weight), target_date: g.target_date };
    const { rows: rev } = await client.query<{ id: string }>(`insert into goal_revision (goal_id, proposed, previous, reason, proposed_by) values ($1, $2, $3, $4, $5) returning id`,
      [goalId, JSON.stringify(material), JSON.stringify(previous), reason, w.actorId]);
    return { id: goalId, revision: rev[0]!.id };
  });
}

export async function decideGoalRevision(pool: Pool, principal: Principal, revisionId: string, body: Record<string, unknown>) {
  const w = await who(pool, principal);
  const approve = body.decision === 'approve';
  return inTransaction(pool, async (client) => {
    const { rows } = await client.query<{ goal_id: string; proposed: Record<string, unknown>; status: string; owner_id: string; proposed_by: string }>(
      `select r.goal_id, r.proposed, r.status, g.owner_id, r.proposed_by from goal_revision r join goal g on g.id = r.goal_id where r.id = $1 and g.tenant_id = $2 for update of r`, [revisionId, w.tenantId]);
    const r = rows[0];
    if (!r) throw new InvalidInput('no such change');
    if (r.status !== 'pending') throw new InvalidInput('already decided');
    if (r.proposed_by === w.actorId) throw new InvalidInput('someone other than the person who proposed the change decides it');
    if (!(await canManage(client, w, r.owner_id))) throw new InvalidInput("only the person's manager or HR decides");
    if (approve) {
      const keys = Object.keys(r.proposed).filter((k) => ['title', 'success_criteria', 'weight', 'target_date'].includes(k));
      if (keys.length) await client.query(`update goal set ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() where id = $1`, [r.goal_id, ...keys.map((k) => r.proposed[k])]);
    }
    await client.query(`update goal_revision set status = $2, decided_by = $3, decided_at = now() where id = $1`, [revisionId, approve ? 'approved' : 'rejected', w.actorId]);
    return { id: revisionId, status: approve ? 'approved' : 'rejected' };
  });
}

// ------------------------------------------------------------- development

export async function listDevelopment(pool: Pool, principal: Principal, opts: { employeeId?: string } = {}) {
  const w = await who(pool, principal);
  const employeeId = opts.employeeId ?? w.actorId;
  if (employeeId !== w.actorId && !(await canManage(pool, w, employeeId))) throw new InvalidInput('you can see your own plan and your reports\'');
  const { rows } = await pool.query(
    `select d.id, d.kind, d.title, d.due_date::text, d.status, d.evidence, d.created_at, d.completed_at, o.display_name as owner
       from development_item d left join actor o on o.id = d.owner_id where d.tenant_id = $1 and d.employee_id = $2 order by d.status <> 'open', d.due_date nulls last`, [w.tenantId, employeeId]);
  return rows;
}

export async function addDevelopmentItem(pool: Pool, principal: Principal, body: Record<string, unknown>) {
  const w = await who(pool, principal);
  const employeeId = body.employeeId ? id(body.employeeId, 'employeeId') : w.actorId;
  if (employeeId !== w.actorId && !(await canManage(pool, w, employeeId))) throw new InvalidInput('you can add to your own plan and your reports\'');
  const kind = text(body.kind, 20) || 'action';
  if (!['action', 'training', 'checkin'].includes(kind)) throw new InvalidInput('kind must be action, training or checkin');
  const title = text(body.title, 300);
  if (!title) throw new InvalidInput('describe the item');
  const ownerId = body.ownerId ? id(body.ownerId, 'ownerId') : employeeId;
  const { rows } = await pool.query<{ id: string }>(
    `insert into development_item (tenant_id, employee_id, participant_id, kind, title, owner_id, due_date, created_by) values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
    [w.tenantId, employeeId, body.participantId ? id(body.participantId, 'participantId') : null, kind, title, ownerId, day(body.dueDate, 'dueDate'), w.actorId]);
  return { id: rows[0]!.id };
}

export async function completeDevelopmentItem(pool: Pool, principal: Principal, itemId: string, body: Record<string, unknown>) {
  const w = await who(pool, principal);
  const { rows } = await pool.query<{ employee_id: string; owner_id: string | null; status: string }>('select employee_id, owner_id, status from development_item where id = $1 and tenant_id = $2', [itemId, w.tenantId]);
  const d = rows[0];
  if (!d) throw new InvalidInput('no such item');
  if (!(d.employee_id === w.actorId || d.owner_id === w.actorId || (await canManage(pool, w, d.employee_id)))) throw new InvalidInput('not your item');
  if (d.status !== 'open') throw new InvalidInput('already closed');
  const status = body.dropped === true ? 'dropped' : 'done';
  const evidence = text(body.evidence, 2000);
  if (status === 'done' && !evidence) throw new InvalidInput('say what shows it is done');
  await pool.query('update development_item set status = $2, evidence = $3, completed_at = now() where id = $1', [itemId, status, evidence || null]);
  return { id: itemId, status };
}

// ----------------------------------------------------------------- reports

/** APR-14, with buckets below the minimum group size suppressed. */
export async function cycleReport(pool: Pool, principal: Principal, cycleId: string) {
  const w = await who(pool, principal); requireHr(w);
  const { rows: c } = await pool.query<{ stages: Windows; min_cohort: number; template: TemplateSnapshot }>('select stages, min_cohort, template from review_cycle where id = $1 and tenant_id = $2', [cycleId, w.tenantId]);
  if (!c[0]) throw new InvalidInput('no such cycle');
  const { rows: stages } = await pool.query<{ stage: string; assigned: number; submitted: number }>(
    `select ra.stage, count(*)::int as assigned, count(s.*) filter (where s.status = 'submitted')::int as submitted
       from reviewer_assignment ra join review_participant p on p.id = ra.participant_id left join assessment s on s.assignment_id = ra.id
      where p.cycle_id = $1 and (ra.active or s.status = 'submitted') group by ra.stage`, [cycleId]);
  const completion = stages.map((s) => ({ ...s, overdue: windowState(c[0]!.stages, s.stage === 'additional' ? 'manager' : s.stage) === 'closed' ? s.assigned - s.submitted : 0 }));
  const { rows: scores } = await pool.query<{ score: string | null }>(
    `select coalesce(r.calibrated_score, (select score from assessment s where s.participant_id = p.id and s.stage = 'manager' and s.status = 'submitted' limit 1)) as score
       from review_participant p left join review_result r on r.participant_id = p.id where p.cycle_id = $1 and p.eligible`, [cycleId]);
  const buckets = new Map<number, number>();
  for (const s of scores) if (s.score !== null) { const b = Math.round(Number(s.score)); buckets.set(b, (buckets.get(b) ?? 0) + 1); }
  const distribution = [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([rating, count]) => count < c[0]!.min_cohort ? { rating, count: null, note: `fewer than ${c[0]!.min_cohort}` } : { rating, count });
  const { rows: appeals } = await pool.query<{ status: string; n: number }>(`select x.status, count(*)::int as n from review_appeal x join review_participant p on p.id = x.participant_id where p.cycle_id = $1 group by x.status`, [cycleId]);
  const { rows: dev } = await pool.query<{ status: string; n: number }>(`select d.status, count(*)::int as n from development_item d join review_participant p on p.id = d.participant_id where p.cycle_id = $1 group by d.status`, [cycleId]);
  return { completion, distribution, appeals, development: dev };
}

export async function appraisalSummary(pool: Pool, principal: Principal) {
  const w = await who(pool, principal);
  const assignments = await myAssignments(pool, principal);
  const { rows } = await pool.query<{ results: number; goals: number; dev: number }>(
    `select (select count(*)::int from review_result r join review_participant p on p.id = r.participant_id where p.actor_id = $1 and r.acknowledged_at is null) as results,
            (select count(*)::int from goal where owner_id = $1 and status in ('draft', 'approved')) as goals,
            (select count(*)::int from development_item where employee_id = $1 and status = 'open') as dev`, [w.actorId]);
  return { hr: w.hr, admin: w.admin, reviewsToDo: assignments.filter((a) => a.window === 'open' && a.status !== 'submitted').length, ...rows[0] };
}
