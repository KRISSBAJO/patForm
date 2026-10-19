'use client';

import { useCallback, useEffect, useState } from 'react';
import { Icon } from './Icon';
import { postJson } from './stepup';

/*
 * Contracts, compliance and audit (PRD Module 10). Everyone: what needs
 * attention, my tasks, policies to read, my findings, my contracts. Legal,
 * Compliance, Security and Finance: contract reviews, policies, controls,
 * exceptions and audits. Owners and Legal: legal holds. Auditors: their
 * engagement, read-only, with export only when granted.
 */

type Tab = 'overview' | 'tasks' | 'read' | 'findings' | 'contracts' | 'policies' | 'controls' | 'exceptions' | 'audits' | 'holds' | 'setup' | 'engagement';
type Me = { admin: boolean; owner: boolean; teams: string[]; holds: boolean };
type Dash = { auditor?: boolean; engagements?: Engagement[]; tasks?: { due: number; overdue: number; escalated: number }; remediation?: { id: string; number: number; title: string; severity: string; target_date: string; engagement: string }[]; expiring?: { id: string; number: number; title: string; end_date: string; notice_deadline: string | null; status: string }[]; policies?: { policy: string; version: number; due_on: string; acknowledged: number; audience: number }[]; exceptions?: number; controls?: { overdue: number; ineffective: number }; holds?: { active: number; released: number } | null; myAcknowledgements?: number; disclaimer?: string; me?: Me };
type Task = { id: string; kind: string; title: string; due_on: string; notice_deadline: string | null; status: string; escalated_at: string | null; evidence: string | null; note: string | null; owner: string; contract: string | null; evidence_required: boolean };
type Contract = { id: string; number: number; title: string; counterparty: string; status: string; current_version: number; value: string | null; currency: string | null; start_date: string | null; end_date: string | null; notice_days: number | null; notice_calendar: string; auto_renews: boolean; owner: string; vendor: string | null };
type ContractDetail = { contract: Contract & { owner_id: string; personal_data: boolean }; versions: { version: number; document_ref: string | null; changes: string | null; material: boolean; created_at: string; by: string | null }[]; reviews: { version: number; discipline: string; decision: string; note: string | null; decided_at: string; invalidated_at: string | null; invalidated_reason: string | null; reviewer: string }[]; envelopes: { id: string; version: number; provider: string; envelope_ref: string; status: string; signed_artifact_ref: string | null }[]; tasks: { id: string; kind: string; title: string; due_on: string; status: string; owner: string }[]; obligations: { id: string; title: string; kind: string; every_months: number | null; next_due: string | null; active: boolean; owner: string }[]; review: { required: string[]; decisions: { discipline: string; decision: string; reviewer?: string; note?: string | null }[]; approved: boolean }; noticeDeadline: string | null };
type Policy = { id: string; title: string; owner: string; versions: { id: string; version: number; status: string; summary: string; document_ref: string | null; effective_from: string | null; approved_by: string | null }[] | null; campaigns: { id: string; version: number; due_on: string; acknowledged: number; audienceSize: number }[] };
type Ack = { campaign_id: string; due_on: string; title: string; version: number; summary: string; document_ref: string | null; status: string; acknowledged_at: string | null; statement: string | null };
type Control = { id: string; ref: string; title: string; framework: string | null; evidence_type: string; frequency_days: number; next_test_due: string; status: string; owner: string; overdue: boolean; tests: { result: string; evidence_ref: string; tested_at: string; by: string }[] | null };
type Exception = { id: string; kind: string; subject: string; reason: string; status: string; expires_on: string; decision_note: string | null; requested_by: string; target: string | null };
type Engagement = { id: string; title: string; status: string; period_from: string; period_to: string; lead?: string; open_findings?: number; open_requests?: number; auditors?: { actor_id: string; name: string; expires_at: string; can_export: boolean }[] | null; expires_at?: string; can_export?: boolean };
type EngagementView = { engagement: { id: string; title: string; scope: { processKeys: string[]; controlIds: string[]; contractIds: string[] }; period_from: string; period_to: string; status: string; sampling_notes: string | null }; readOnly: boolean; canExport: boolean;
  requests: { id: string; title: string; detail: string | null; due_on: string | null; status: string; evidence: { ref: string; note: string | null; at: string }[]; decision_note: string | null; owner: string; owner_id: string }[];
  findings: { id: string; number: number; title: string; detail: string; severity: string; status: string; management_response: string | null; target_date: string | null; reopened: number; owner: string; owner_id: string; validated_by: string | null; history: { kind: string; body: string; evidence_ref: string | null; at: string; by: string | null }[] | null }[];
  controls: { id: string; ref: string; title: string; status: string; tests: { result: string; evidence_ref: string; tested_at: string }[] | null }[]; contracts: { id: string; number: number; title: string; status: string; current_version: number }[]; records: { id: string; process_key: string; state: string; created_at: string; completed_at: string | null }[] };
type Holds = { holds: { id: string; title: string; reason: string; scope: { processKeys: string[]; instanceIds: string[] }; status: string; created_at: string; release_reason: string | null; clear_note: string | null; created_by: string | null; released_by: string | null; cleared_by: string | null; blocked: number }[]; blocks: { id: number; process_key: string; held_records: number; run_by: string; occurred_at: string; hold: string }[]; schedules: { process_key: string; enabled: boolean; last_run_at: string | null }[] };
type Member = { id: string; display_name: string; active: boolean; workspace_role?: string };

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path, { credentials: 'same-origin' });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.reason ?? body.error ?? `HTTP ${res.status}`);
  return body as T;
}
function useFeed<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    if (!path) return;
    try { setData(await get<T>(path)); setError(null); } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  }, [path]);
  useEffect(() => { void reload(); }, [reload]);
  return { data, error, reload };
}
const day = (v: string | null | undefined) => (v ? new Date(v.length === 10 ? `${v}T00:00:00` : v).toLocaleDateString() : '');
const list = { listStyle: 'none', margin: 0, padding: 0 } as const;
const words = (s: string) => s.replace(/_/g, ' ');
function Field({ id, label, children }: { id: string; label: string; children: React.ReactNode }) {
  return <div><label className="cs__label" htmlFor={id}>{label}</label>{children}</div>;
}
const empty = (t: string) => <li className="ig__row"><div className="ig__rowMain"><p>{t}</p></div></li>;

export function ComplianceView() {
  const dash = useFeed<Dash>('/api/gov/dashboard');
  const d = dash.data;
  const auditor = d?.auditor === true;
  const me = d?.me;
  const team = (...t: string[]) => !!me && (me.admin || t.some((x) => me.teams.includes(x)));
  const [tab, setTab] = useState<Tab>('overview');
  const tasks = useFeed<Task[]>(d && !auditor ? `/api/gov/tasks${team('compliance', 'legal') ? '?scope=all' : ''}` : null);
  const acks = useFeed<Ack[]>(d && !auditor ? '/api/gov/acknowledgements/mine' : null);
  const findings = useFeed<{ id: string; number: number; title: string; detail: string; severity: string; status: string; target_date: string | null; management_response: string | null; engagement: string }[]>(d && !auditor ? '/api/gov/findings/mine' : null);
  const contracts = useFeed<Contract[]>(d && !auditor ? '/api/gov/contracts' : null);
  const policies = useFeed<Policy[]>(d && !auditor ? '/api/gov/policies' : null);
  const controls = useFeed<{ disclaimer: string; controls: Control[] }>(d && !auditor ? '/api/gov/controls' : null);
  const exceptions = useFeed<Exception[]>(d && !auditor ? '/api/gov/exceptions' : null);
  const engagements = useFeed<Engagement[]>(d ? '/api/gov/engagements' : null);
  const holds = useFeed<Holds>(me?.holds ? '/api/gov/holds' : null);
  const settings = useFeed<{ settings: { alwaysReview: string[]; financeAbove: number | null; securityForPersonalData: boolean; materialInvalidates: string[]; renewalLeadDays: number }; teams: { team: string; actor_id: string; display_name: string }[] }>(me?.admin ? '/api/gov/settings' : null);
  const members = useFeed<Member[]>(d && !auditor ? '/api/members' : null);
  const [openContract, setOpenContract] = useState<ContractDetail | null>(null);
  const [openEngagement, setOpenEngagement] = useState<EngagementView | null>(null);
  const [openRecord, setOpenRecord] = useState<{ record: { id: string; process_key: string; state: string; answers: Record<string, unknown> }; events: { type: string; occurred_at: string }[] } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [asking, setAsking] = useState<{ id: string; label: string; run: (answer: string) => Promise<string> } | null>(null);
  const [answer, setAnswer] = useState('');
  const f = (k: string) => form[k] ?? '';
  const setF = (k: string, v: string) => setForm((x) => ({ ...x, [k]: v }));

  const reloadAll = async () => { await Promise.all([dash.reload(), tasks.reload(), acks.reload(), findings.reload(), contracts.reload(), policies.reload(), controls.reload(), exceptions.reload(), engagements.reload(), holds.reload(), settings.reload()]); };
  const showContract = async (cid: string) => { try { setOpenContract(await get<ContractDetail>(`/api/gov/contracts/${cid}`)); } catch (err) { setNote(err instanceof Error ? err.message : String(err)); } };
  const showEngagement = async (eid: string) => { try { setOpenRecord(null); setOpenEngagement(await get<EngagementView>(`/api/gov/engagements/${eid}`)); } catch (err) { setNote(err instanceof Error ? err.message : String(err)); } };
  const act = async (key: string, work: () => Promise<string>) => {
    setBusy(key); setNote(null);
    try {
      const message = await work(); await reloadAll();
      if (openContract) await showContract(openContract.contract.id);
      if (openEngagement) await showEngagement(openEngagement.engagement.id);
      setNote(message);
    } catch (err) { setNote(err instanceof Error ? err.message : String(err)); } finally { setBusy(null); }
  };

  if (dash.error) return <div className="ig__workspace"><p className="ig__error" role="alert">{dash.error}</p></div>;
  if (!d) return <div className="ig__workspace"><p className="ig__rowMain">Loading…</p></div>;
  const people = (members.data ?? []).filter((m) => m.active);
  const pick = (idv: string, label: string, key: string, required = true) => <Field id={idv} label={label}><select id={idv} className="cs__input" required={required} value={f(key)} onChange={(e) => setF(key, e.target.value)}><option value="">Choose…</option>{people.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}</select></Field>;

  const tabs: { id: Tab; name: string; count: number | null; icon: 'table' | 'export' | 'trail' | 'account' | 'done' }[] = auditor
    ? [{ id: 'engagement', name: 'My engagements', count: (engagements.data ?? []).length, icon: 'table' }]
    : [
      { id: 'overview', name: 'Overview', count: null, icon: 'table' },
      { id: 'tasks', name: 'Tasks', count: (d.tasks?.due ?? 0) + (d.tasks?.overdue ?? 0), icon: 'done' },
      { id: 'read', name: 'Policies to read', count: d.myAcknowledgements ?? 0, icon: 'export' },
      { id: 'findings', name: 'My findings', count: (findings.data ?? []).length, icon: 'trail' },
      { id: 'contracts', name: 'Contracts', count: (contracts.data ?? []).filter((c) => c.status === 'in_review').length, icon: 'export' },
      ...(team('compliance') ? [{ id: 'policies' as const, name: 'Policies', count: null, icon: 'trail' as const }] : []),
      { id: 'controls', name: 'Controls', count: d.controls?.overdue ?? 0, icon: 'done' },
      { id: 'exceptions', name: 'Exceptions', count: d.exceptions ?? 0, icon: 'trail' },
      { id: 'audits', name: 'Audits', count: (engagements.data ?? []).filter((e) => e.status !== 'closed').length, icon: 'table' },
      ...(me?.holds ? [{ id: 'holds' as const, name: 'Legal holds', count: (d.holds?.active ?? 0) + (d.holds?.released ?? 0), icon: 'account' as const }] : []),
      ...(me?.admin ? [{ id: 'setup' as const, name: 'Setup', count: null, icon: 'trail' as const }] : []),
    ];
  const current = tabs.some((t) => t.id === tab) ? tab : tabs[0]!.id;

  const engagementPanel = openEngagement && <div className="ig__form" style={{ gridTemplateColumns: '1fr' }}>
    <div className="ig__formTitle"><strong>{openEngagement.engagement.title}</strong><p>{words(openEngagement.engagement.status)} · {day(openEngagement.engagement.period_from)} to {day(openEngagement.engagement.period_to)} · scope: {[...openEngagement.engagement.scope.processKeys.map((k) => `process ${k}`), `${openEngagement.engagement.scope.controlIds.length} control(s)`, `${openEngagement.engagement.scope.contractIds.length} contract(s)`].join(', ')}{openEngagement.readOnly ? ' · read-only; everything you open is logged' : ''}</p></div>
    {openEngagement.engagement.sampling_notes && <p><strong>Sampling:</strong> {openEngagement.engagement.sampling_notes}</p>}
    <div className="pp2__roleEdit">
      {openEngagement.canExport && <button type="button" className="cs__btn" onClick={() => void act('pack', async () => {
        const pack = await postJson<{ id: string; sha256: string; manifest: unknown; items: unknown[] }>(`/api/gov/engagements/${openEngagement.engagement.id}/pack`, {});
        const blob = new Blob([JSON.stringify(pack, null, 2)], { type: 'application/json' });
        const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `evidence-pack-${pack.id}.json`; a.click(); URL.revokeObjectURL(a.href);
        return `Evidence pack built (${pack.items.length} items, SHA-256 ${pack.sha256.slice(0, 16)}…).`; })}>Build evidence pack</button>}
      {!openEngagement.readOnly && team('compliance') && <>
        <button type="button" className="cs__btn" onClick={() => setAsking({ id: 'st', label: 'Status: planning, fieldwork, reporting or closed', run: async (s) => { await postJson(`/api/gov/engagements/${openEngagement.engagement.id}`, { status: s.trim() }); return 'Status changed.'; } })}>Change status</button>
        <button type="button" className="cs__btn" onClick={() => setAsking({ id: 'sn', label: 'Sampling notes', run: async (s) => { await postJson(`/api/gov/engagements/${openEngagement.engagement.id}`, { samplingNotes: s }); return 'Saved.'; } })}>Sampling notes</button>
        <button type="button" className="cs__btn" onClick={() => setAsking({ id: 'au', label: 'Auditor: member email or name | days of access (max 180) | export yes/no', run: async (s) => { const [who, days, exp] = s.split('|').map((x) => x.trim()); const m = people.find((p) => p.display_name.toLowerCase() === who!.toLowerCase()); if (!m) throw new Error('no member with that name; invite them with the Auditor role first'); await postJson(`/api/gov/engagements/${openEngagement.engagement.id}/auditors`, { actorId: m.id, expiresAt: new Date(Date.now() + Number(days || 30) * 86400000).toISOString(), canExport: (exp ?? '').toLowerCase().startsWith('y') }); return 'Auditor access granted.'; } })}>Give auditor access</button>
        <button type="button" className="cs__btn" onClick={() => void act('log', async () => { const log = await get<{ action: string; target_kind: string; occurred_at: string; auditor: string }[]>(`/api/gov/engagements/${openEngagement.engagement.id}/access-log`); return log.length ? log.slice(0, 15).map((l) => `${new Date(l.occurred_at).toLocaleString()} ${l.auditor} ${l.action} ${l.target_kind}`).join(' · ') : 'No auditor activity yet.'; })}>Auditor activity</button>
      </>}
      <button type="button" className="cs__btn" onClick={() => { setOpenEngagement(null); setOpenRecord(null); }}>Close</button>
    </div>
    {!openEngagement.readOnly && <form className="pp2__roleEdit" onSubmit={(e) => { e.preventDefault(); void act('req', async () => { await postJson(`/api/gov/engagements/${openEngagement.engagement.id}/requests`, { title: f('rqT'), ownerId: f('rqO'), dueOn: f('rqD') || undefined }); setForm({}); return 'Evidence requested.'; }); }}>
      <Field id="rq-t" label="Ask for evidence"><input id="rq-t" className="cs__input" required value={f('rqT')} onChange={(e) => setF('rqT', e.target.value)} /></Field>
      {pick('rq-o', 'From', 'rqO')}
      <Field id="rq-d" label="By"><input id="rq-d" type="date" className="cs__input" value={f('rqD')} onChange={(e) => setF('rqD', e.target.value)} /></Field>
      <button type="submit" className="cs__btn">Request</button>
    </form>}
    <strong>Evidence requests</strong>
    <ul style={list}>{openEngagement.requests.map((r) => <li key={r.id} className="ig__row"><div className="ig__rowMain"><strong>{r.title}</strong><span className={`ig__status ${r.status === 'accepted' ? '' : 'ig__status--off'}`}>{r.status}</span>
      <p>{r.owner}{r.due_on ? ` · by ${day(r.due_on)}` : ''}{r.evidence.length ? ` · ${r.evidence.map((x) => x.ref).join(', ')}` : ''}{r.decision_note ? ` · ${r.decision_note}` : ''}</p></div>
      {!openEngagement.readOnly && r.status === 'submitted' && <div className="pp2__roleEdit"><button type="button" className="cs__btn" onClick={() => void act(r.id, async () => { await postJson(`/api/gov/requests/${r.id}/decide`, { decision: 'accept' }); return 'Accepted.'; })}>Accept</button><button type="button" className="cs__btn" onClick={() => setAsking({ id: r.id, label: 'What is missing?', run: async (n) => { await postJson(`/api/gov/requests/${r.id}/decide`, { decision: 'reject', note: n }); return 'Sent back.'; } })}>Reject</button></div>}
    </li>)}{!openEngagement.requests.length && empty('No evidence requested.')}</ul>
    {!openEngagement.readOnly && <form className="pp2__roleEdit" onSubmit={(e) => { e.preventDefault(); void act('fd', async () => { await postJson(`/api/gov/engagements/${openEngagement.engagement.id}/findings`, { title: f('fdT'), detail: f('fdD'), severity: f('fdS') || 'medium', ownerId: f('fdO'), targetDate: f('fdDt') || undefined }); setForm({}); return 'Finding raised.'; }); }}>
      <Field id="fd-t" label="New finding"><input id="fd-t" className="cs__input" required value={f('fdT')} onChange={(e) => setF('fdT', e.target.value)} /></Field>
      <Field id="fd-d" label="Detail"><input id="fd-d" className="cs__input" required value={f('fdD')} onChange={(e) => setF('fdD', e.target.value)} /></Field>
      <Field id="fd-s" label="Severity"><select id="fd-s" className="cs__input" value={f('fdS') || 'medium'} onChange={(e) => setF('fdS', e.target.value)}>{['low', 'medium', 'high', 'critical'].map((s) => <option key={s} value={s}>{s}</option>)}</select></Field>
      {pick('fd-o', 'Owner', 'fdO')}
      <button type="submit" className="cs__btn">Raise</button>
    </form>}
    <strong>Findings</strong>
    <ul style={list}>{openEngagement.findings.map((x) => <li key={x.id} className="ig__row" style={{ flexWrap: 'wrap' }}><div className="ig__rowMain"><strong>#{x.number} {x.title}</strong><span className={`ig__status ${x.status === 'closed' ? '' : 'ig__status--off'}`}>{x.severity} · {words(x.status)}{x.reopened ? ` · reopened ${x.reopened}×` : ''}</span>
      <p>{x.detail} · owner {x.owner}{x.target_date ? ` · target ${day(x.target_date)}` : ''}{x.validated_by ? ` · validated by ${x.validated_by}` : ''}</p>
      {x.management_response && <p>Response: {x.management_response}</p>}
      {(x.history ?? []).length > 0 && <p><small>{(x.history ?? []).map((h) => `${day(h.at)} ${h.kind}${h.by ? ` (${h.by})` : ''}: ${h.body}${h.evidence_ref ? ` [${h.evidence_ref}]` : ''}`).join(' · ')}</small></p>}</div>
      {!openEngagement.readOnly && x.status === 'awaiting_validation' && <div className="pp2__roleEdit">
        <button type="button" className="cs__btn cs__btn--primary" onClick={() => void act(x.id, async () => { await postJson(`/api/gov/findings/${x.id}`, { action: 'validate' }); return 'Validated and closed.'; })}>Validate</button>
        <button type="button" className="cs__btn" onClick={() => setAsking({ id: x.id, label: 'Why is the evidence not enough?', run: async (b) => { await postJson(`/api/gov/findings/${x.id}`, { action: 'reopen', body: b }); return 'Sent back for more work.'; } })}>Not enough</button>
      </div>}
    </li>)}{!openEngagement.findings.length && empty('No findings.')}</ul>
    {openEngagement.controls.length > 0 && <p><strong>Controls:</strong> {openEngagement.controls.map((c) => `${c.ref} ${c.title} (${words(c.status)}; ${(c.tests ?? []).length} test(s) in period)`).join(' · ')}</p>}
    {openEngagement.contracts.length > 0 && <p><strong>Contracts:</strong> {openEngagement.contracts.map((c) => `#${c.number} ${c.title} v${c.current_version} (${words(c.status)})`).join(' · ')}</p>}
    {openEngagement.records.length > 0 && <><strong>Records in scope ({openEngagement.records.length})</strong>
      <table className="ex__table"><thead><tr><th scope="col">Process</th><th scope="col">State</th><th scope="col">Started</th><th scope="col"><span className="ex__sr">Open</span></th></tr></thead>
        <tbody>{openEngagement.records.slice(0, 100).map((r) => <tr key={r.id}><td>{r.process_key}</td><td>{words(r.state)}</td><td>{day(r.created_at)}</td>
          <td><button type="button" className="cs__btn" onClick={() => void (async () => { try { setOpenRecord(await get(`/api/gov/engagements/${openEngagement.engagement.id}/records/${r.id}`)); } catch (err) { setNote(err instanceof Error ? err.message : String(err)); } })()}>View</button></td></tr>)}</tbody></table></>}
    {openRecord && <div className="ig__notice"><strong>{openRecord.record.process_key} · {words(openRecord.record.state)}</strong>
      <p><small>{Object.entries(openRecord.record.answers ?? {}).slice(0, 30).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join(' · ')}</small></p>
      <p><small>History: {openRecord.events.map((e) => `${new Date(e.occurred_at).toLocaleString()} ${e.type}`).join(' · ')}</small></p>
      <button type="button" className="cs__btn" onClick={() => setOpenRecord(null)}>Close record</button></div>}
  </div>;

  const contractPanel = openContract && (() => {
    const c = openContract.contract;
    return <div className="ig__form" style={{ gridTemplateColumns: '1fr' }}>
      <div className="ig__formTitle"><strong>#{c.number} {c.title} · v{c.current_version}</strong><p>{words(c.status)} · {c.counterparty}{c.value ? ` · ${c.currency} ${Number(c.value).toLocaleString()}` : ''}{c.end_date ? ` · ends ${day(c.end_date)}` : ''}{openContract.noticeDeadline ? ` · notice by ${day(openContract.noticeDeadline)} (${c.notice_days} ${c.notice_calendar === 'business' ? 'working' : 'calendar'} days)` : ''}{c.auto_renews ? ' · renews automatically' : ''}</p></div>
      <p><strong>Reviews for v{c.current_version}:</strong> {openContract.review.decisions.map((x) => `${x.discipline}: ${x.decision === 'waiting' ? 'waiting' : `${words(x.decision)} by ${x.reviewer}`}`).join(' · ')}</p>
      <div className="pp2__roleEdit">
        {c.status === 'draft' && <button type="button" className="cs__btn cs__btn--primary" onClick={() => void act('sub', async () => { const r = await postJson<{ required: string[] }>(`/api/gov/contracts/${c.id}/submit`, {}); return `Sent for review: ${r.required.join(', ')}.`; })}>Send for review</button>}
        {c.status === 'in_review' && openContract.review.decisions.filter((x) => x.decision !== 'approved').map((x) => <span key={x.discipline} className="pp2__roleEdit">
          <button type="button" className="cs__btn" onClick={() => void act(x.discipline, async () => { await postJson(`/api/gov/contracts/${c.id}/review`, { discipline: x.discipline, decision: 'approve' }); return `${x.discipline} approval recorded.`; })}>Approve as {x.discipline}</button>
          <button type="button" className="cs__btn" onClick={() => setAsking({ id: x.discipline, label: `What must change (${x.discipline})?`, run: async (n) => { await postJson(`/api/gov/contracts/${c.id}/review`, { discipline: x.discipline, decision: 'changes', note: n }); return 'Changes requested.'; } })}>Ask for changes</button></span>)}
        {!['signed', 'expired', 'terminated'].includes(c.status) && <button type="button" className="cs__btn" onClick={() => setAsking({ id: 'rev', label: 'What changed? Add " | material" if it is material; " | end YYYY-MM-DD" or " | value N" to change terms', run: async (s) => { const [changes, ...rest] = s.split('|').map((x) => x.trim()); const body: Record<string, unknown> = { changes }; for (const r of rest) { if (r === 'material') body.material = true; else if (r.startsWith('end ')) body.endDate = r.slice(4); else if (r.startsWith('value ')) body.value = r.slice(6); else if (r.startsWith('notice ')) body.noticeDays = r.slice(7); } const x = await postJson<{ version: number; material: boolean; cancelled: string[] }>(`/api/gov/contracts/${c.id}/revise`, body); return `Version ${x.version} saved${x.material ? `; material, so these approvals were cancelled: ${x.cancelled.join(', ') || 'none yet'}` : '; not material, approvals carried over'}.`; } })}>New version</button>}
        {c.status === 'approved' && <button type="button" className="cs__btn" onClick={() => setAsking({ id: 'sig', label: 'Signature provider | envelope reference', run: async (s) => { const [provider, envelopeRef] = s.split('|').map((x) => x.trim()); await postJson(`/api/gov/contracts/${c.id}/signature`, { provider, envelopeRef }); return 'Out for signature.'; } })}>Record sent for signature</button>}
        <button type="button" className="cs__btn" onClick={() => setAsking({ id: 'obl', label: 'Obligation: title | recurring every N months, one_off, or event | first due YYYY-MM-DD', run: async (s) => { const [title, kindRaw, first] = s.split('|').map((x) => x.trim()); const m = /every (\d+)/.exec(kindRaw ?? ''); await postJson('/api/gov/obligations', { contractId: c.id, title, kind: m ? 'recurring' : kindRaw === 'event' ? 'event' : 'one_off', everyMonths: m ? Number(m[1]) : undefined, firstDue: first, ownerId: c.owner_id }); return 'Obligation added.'; } })}>Add obligation</button>
        <button type="button" className="cs__btn" onClick={() => setOpenContract(null)}>Close</button>
      </div>
      {openContract.envelopes.map((e) => <p key={e.id}>Signature: {e.provider} {e.envelope_ref} for v{e.version} — {e.status}{e.signed_artifact_ref ? ` · signed copy ${e.signed_artifact_ref}` : ''}
        {['sent', 'delivered'].includes(e.status) && <> <button type="button" className="cs__btn" onClick={() => setAsking({ id: e.id, label: 'Signed document reference', run: async (r) => { await postJson(`/api/gov/envelopes/${e.id}`, { status: 'completed', signedArtifactRef: r }); return 'Signed.'; } })}>Signed</button> <button type="button" className="cs__btn" onClick={() => void act(e.id, async () => { await postJson(`/api/gov/envelopes/${e.id}`, { status: 'declined' }); return 'Declined; the contract is back to approved.'; })}>Declined</button></>}</p>)}
      <p><small><strong>Versions:</strong> {openContract.versions.map((v) => `v${v.version} ${day(v.created_at)}${v.by ? ` by ${v.by}` : ''}${v.material ? ' (material)' : ''}: ${v.changes ?? ''}${v.document_ref ? ` [${v.document_ref}]` : ''}`).join(' · ')}</small></p>
      <p><small><strong>Review history:</strong> {openContract.reviews.map((r) => `v${r.version} ${r.discipline} ${words(r.decision)} by ${r.reviewer}${r.invalidated_at ? ` — cancelled: ${r.invalidated_reason}` : ''}`).join(' · ') || 'none'}</small></p>
      {(openContract.obligations.length > 0 || openContract.tasks.length > 0) && <p><small><strong>Obligations:</strong> {openContract.obligations.map((o) => `${o.title} (${o.kind}${o.every_months ? ` every ${o.every_months} months` : ''}${o.next_due ? `, next ${day(o.next_due)}` : ''})`).join(' · ')} {openContract.tasks.map((t) => `· ${t.title} ${day(t.due_on)} ${t.status}`).join(' ')}</small></p>}
    </div>;
  })();

  return <div className="ig__workspace">
    <header className="ig__hero">
      <span className="ig__eyebrow">CONTRACTS &amp; COMPLIANCE</span>
      <h2>{auditor ? 'Your audit engagements' : 'Contracts, policies, controls and audits'}</h2>
      <p>{auditor ? 'Read-only, for the dates you were given. Everything you open is logged.' : 'Approvals belong to a contract version; a material change sends it back for review. Renewal tasks are dated from the notice deadline. Recording controls here is not a certification.'}</p>
    </header>
    <div className="ig__surface">
      <div className="ig__tabs" role="tablist" aria-label="Compliance areas">
        {tabs.map((item, index) => <button key={item.id} id={`gov-tab-${item.id}`} type="button" role="tab" aria-controls={`gov-panel-${item.id}`} aria-selected={current === item.id} tabIndex={current === item.id ? 0 : -1} className="ig__tab" onClick={() => { setTab(item.id); setNote(null); setForm({}); setAsking(null); setOpenContract(null); setOpenEngagement(null); setOpenRecord(null); }} onKeyDown={(event) => { const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index - 1 + tabs.length) % tabs.length : -1; if (next < 0) return; event.preventDefault(); const idn = tabs[next]!.id; setTab(idn); document.getElementById(`gov-tab-${idn}`)?.focus(); }}>
          <Icon name={item.icon} /><span>{item.name}</span>{item.count !== null && <span className="ig__tabCount">{item.count}</span>}
        </button>)}
      </div>
      <section id={`gov-panel-${current}`} role="tabpanel" aria-labelledby={`gov-tab-${current}`} className="ig__panel">
        {note && <p className="ig__notice" role="status">{note}</p>}
        {asking && <form className="ig__form" onSubmit={(e) => { e.preventDefault(); const a = answer.trim(); if (!a) return; const job = asking; setAsking(null); setAnswer(''); void act(job.id, () => job.run(a)); }}>
          <Field id="gov-ask" label={asking.label}><input id="gov-ask" className="cs__input" required autoFocus value={answer} onChange={(e) => setAnswer(e.target.value)} /></Field>
          <div className="pp2__roleEdit" style={{ alignSelf: 'end' }}><button type="submit" className="cs__btn cs__btn--primary">Save</button><button type="button" className="cs__btn" onClick={() => { setAsking(null); setAnswer(''); }}>Cancel</button></div>
        </form>}

        {current === 'engagement' && (openEngagement ? engagementPanel : <ul style={list}>{(engagements.data ?? []).map((e) => <li key={e.id} className="ig__row"><div className="ig__rowMain"><strong>{e.title}</strong><span className="ig__status">{words(e.status)}</span><p>{day(e.period_from)} to {day(e.period_to)} · access until {day(e.expires_at)}{e.can_export ? ' · export allowed' : ''}</p></div><button type="button" className="cs__btn cs__btn--primary" onClick={() => void showEngagement(e.id)}>Open</button></li>)}{engagements.data && !engagements.data.length && empty('You have no engagement open right now.')}</ul>)}

        {current === 'overview' && <>
          <section className="pp2__overview" aria-label="At a glance" style={{ margin: '0 0 18px' }}>
            <div><span>Tasks</span><strong>{d.tasks?.overdue ?? 0} overdue</strong><small>{d.tasks?.due ?? 0} coming up · {d.tasks?.escalated ?? 0} escalated</small></div>
            <div><span>Remediation overdue</span><strong>{d.remediation?.length ?? 0}</strong><small>{d.exceptions ?? 0} exceptions waiting</small></div>
            <div><span>Controls</span><strong>{d.controls?.overdue ?? 0} overdue</strong><small>{d.controls?.ineffective ?? 0} ineffective</small></div>
          </section>
          <ul style={list}>
            {(d.expiring ?? []).map((c) => <li key={c.id} className="ig__row"><div className="ig__rowMain"><strong>#{c.number} {c.title}</strong><span className="ig__status ig__status--off">ends {day(c.end_date)}</span><p>{c.notice_deadline ? `Notice deadline ${day(c.notice_deadline)}` : 'No notice period recorded'}</p></div><button type="button" className="cs__btn" onClick={() => { setTab('contracts'); void showContract(c.id); }}>Open</button></li>)}
            {(d.remediation ?? []).map((r) => <li key={r.id} className="ig__row"><div className="ig__rowMain"><strong>Finding #{r.number} {r.title}</strong><span className="ig__status ig__status--off">{r.severity} · target {day(r.target_date)}</span><p>{r.engagement}</p></div></li>)}
            {(d.policies ?? []).map((p, i) => <li key={i} className="ig__row"><div className="ig__rowMain"><strong>{p.policy} v{p.version}</strong><span className="ig__status">{p.acknowledged} of {p.audience} acknowledged</span><p>Due {day(p.due_on)}</p></div></li>)}
            {d.holds && <li className="ig__row"><div className="ig__rowMain"><strong>Legal holds</strong><span className="ig__status">{d.holds.active} active · {d.holds.released} released, waiting for review</span></div></li>}
          </ul>
          <p><small>{d.disclaimer}</small></p>
        </>}

        {current === 'tasks' && <ul style={list}>{(tasks.data ?? []).map((t) => <li key={t.id} className="ig__row"><div className="ig__rowMain">
          <strong>{t.title}</strong><span className={`ig__status ${t.status === 'done' ? '' : 'ig__status--off'}`}>{t.status === 'open' ? `${t.due_on < new Date().toISOString().slice(0, 10) ? 'Overdue' : 'Due'} ${day(t.due_on)}` : t.status}{t.escalated_at ? ' · escalated' : ''}</span>
          <p>{t.kind === 'renewal' ? 'Renewal decision' : 'Obligation'}{t.contract ? ` · ${t.contract}` : ''} · {t.owner}{t.note ? ` · ${t.note}` : ''}{t.evidence ? ` · ${t.evidence}` : ''}</p></div>
          {t.status === 'open' && <button type="button" className="cs__btn cs__btn--primary" onClick={() => setAsking(t.kind === 'renewal'
            ? { id: t.id, label: 'Decision (renew, give_notice, let_lapse or renegotiate) | note | evidence (the notice, if you gave it)', run: async (s) => { const [decision, n, evidence] = s.split('|').map((x) => x.trim()); await postJson(`/api/gov/tasks/${t.id}/complete`, { decision, note: n, evidence }); return 'Recorded.'; } }
            : { id: t.id, label: t.evidence_required ? 'Evidence it was done' : 'Note (optional)', run: async (s) => { await postJson(`/api/gov/tasks/${t.id}/complete`, { evidence: s }); return 'Done.'; } })}>{t.kind === 'renewal' ? 'Decide' : 'Done'}</button>}
        </li>)}{tasks.data && !tasks.data.length && empty('Nothing due.')}</ul>}

        {current === 'read' && <ul style={list}>{(acks.data ?? []).map((a) => <li key={a.campaign_id} className="ig__row"><div className="ig__rowMain">
          <strong>{a.title} v{a.version}</strong><span className={`ig__status ${a.acknowledged_at ? '' : 'ig__status--off'}`}>{a.acknowledged_at ? 'Read' : `By ${day(a.due_on)}`}</span>
          <p>{a.summary}{a.document_ref ? ` · ${a.document_ref}` : ''}{a.statement ? ` · "${a.statement}"` : ''}</p></div>
          {!a.acknowledged_at && a.status === 'published' && <button type="button" className="cs__btn cs__btn--primary" onClick={() => void act(a.campaign_id, async () => { const r = await postJson<{ statement: string }>(`/api/gov/campaigns/${a.campaign_id}/acknowledge`, {}); return `Recorded: "${r.statement}"`; })}>I have read it</button>}
        </li>)}{acks.data && !acks.data.length && empty('No policies to read.')}</ul>}

        {current === 'findings' && <ul style={list}>{(findings.data ?? []).map((x) => <li key={x.id} className="ig__row"><div className="ig__rowMain">
          <strong>#{x.number} {x.title}</strong><span className="ig__status ig__status--off">{x.severity} · {words(x.status)}</span><p>{x.engagement} · {x.detail}{x.target_date ? ` · target ${day(x.target_date)}` : ''}</p></div>
          <div className="pp2__roleEdit">
            {x.status === 'open' && <button type="button" className="cs__btn cs__btn--primary" onClick={() => setAsking({ id: x.id, label: 'Management response | target date YYYY-MM-DD', run: async (s) => { const [b, target] = s.split('|').map((y) => y.trim()); await postJson(`/api/gov/findings/${x.id}`, { action: 'respond', body: b, targetDate: target }); return 'Response recorded.'; } })}>Respond</button>}
            {x.status === 'remediating' && <button type="button" className="cs__btn cs__btn--primary" onClick={() => setAsking({ id: x.id, label: 'Evidence it is fixed', run: async (r) => { await postJson(`/api/gov/findings/${x.id}`, { action: 'evidence', evidenceRef: r }); return 'Sent for validation.'; } })}>Submit fix</button>}
          </div></li>)}{findings.data && !findings.data.length && empty('No open findings for you.')}</ul>}

        {current === 'contracts' && (openContract ? contractPanel : <>
          <form className="ig__form" onSubmit={(e) => { e.preventDefault(); void act('c', async () => { const r = await postJson<{ number: number }>('/api/gov/contracts', { title: f('cT'), counterparty: f('cP'), value: f('cV') || undefined, currency: f('cC') || undefined, startDate: f('cS') || undefined, endDate: f('cE') || undefined, noticeDays: f('cN') || undefined, noticeCalendar: f('cCal') || 'calendar', autoRenews: f('cAR') === 'yes', personalData: f('cPD') === 'yes', documentRef: f('cD') || undefined }); setForm({}); return `Contract #${r.number} saved as a draft.`; }); }}>
            <div className="ig__formTitle"><strong>New contract</strong><p>It starts as a draft. Sending it for review asks for the reviews your rules require.</p></div>
            <Field id="c-t" label="Title"><input id="c-t" className="cs__input" required value={f('cT')} onChange={(e) => setF('cT', e.target.value)} /></Field>
            <Field id="c-p" label="Other party"><input id="c-p" className="cs__input" required value={f('cP')} onChange={(e) => setF('cP', e.target.value)} /></Field>
            <Field id="c-v" label="Value"><input id="c-v" type="number" className="cs__input" value={f('cV')} onChange={(e) => setF('cV', e.target.value)} /></Field>
            <Field id="c-c" label="Currency"><input id="c-c" className="cs__input" maxLength={3} value={f('cC')} onChange={(e) => setF('cC', e.target.value)} /></Field>
            <Field id="c-s" label="Starts"><input id="c-s" type="date" className="cs__input" value={f('cS')} onChange={(e) => setF('cS', e.target.value)} /></Field>
            <Field id="c-e" label="Ends"><input id="c-e" type="date" className="cs__input" value={f('cE')} onChange={(e) => setF('cE', e.target.value)} /></Field>
            <Field id="c-n" label="Notice period (days)"><input id="c-n" type="number" className="cs__input" value={f('cN')} onChange={(e) => setF('cN', e.target.value)} /></Field>
            <Field id="c-cal" label="Counted in"><select id="c-cal" className="cs__input" value={f('cCal')} onChange={(e) => setF('cCal', e.target.value)}><option value="calendar">Calendar days</option><option value="business">Working days</option></select></Field>
            <Field id="c-d" label="Document reference"><input id="c-d" className="cs__input" value={f('cD')} onChange={(e) => setF('cD', e.target.value)} /></Field>
            <div><label className="pp2__inlineLabel"><input type="checkbox" checked={f('cAR') === 'yes'} onChange={(e) => setF('cAR', e.target.checked ? 'yes' : '')} /> Renews automatically</label> <label className="pp2__inlineLabel"><input type="checkbox" checked={f('cPD') === 'yes'} onChange={(e) => setF('cPD', e.target.checked ? 'yes' : '')} /> Handles personal data</label></div>
            <button type="submit" className="cs__btn cs__btn--primary" disabled={busy === 'c'}>Save draft</button>
          </form>
          <ul style={list}>{(contracts.data ?? []).map((c) => <li key={c.id} className="ig__row"><div className="ig__rowMain"><strong>#{c.number} {c.title}</strong><span className={`ig__status ${c.status === 'signed' ? '' : 'ig__status--off'}`}>{words(c.status)} · v{c.current_version}</span>
            <p>{c.counterparty} · {c.owner}{c.value ? ` · ${c.currency} ${Number(c.value).toLocaleString()}` : ''}{c.end_date ? ` · ends ${day(c.end_date)}` : ''}</p></div><button type="button" className="cs__btn" onClick={() => void showContract(c.id)}>Open</button></li>)}{contracts.data && !contracts.data.length && empty('No contracts yet.')}</ul>
        </>)}

        {current === 'policies' && <>
          <form className="ig__form" onSubmit={(e) => { e.preventDefault(); void act('p', async () => { await postJson('/api/gov/policies', { title: f('pT'), summary: f('pS'), documentRef: f('pD') || undefined }); setForm({}); return 'Draft policy saved. Someone else approves it.'; }); }}>
            <div className="ig__formTitle"><strong>New policy</strong><p>Draft, then approved by someone other than the author, then published with an effective date. Publishing supersedes the previous version.</p></div>
            <Field id="p-t" label="Title"><input id="p-t" className="cs__input" required value={f('pT')} onChange={(e) => setF('pT', e.target.value)} /></Field>
            <Field id="p-s" label="Summary"><input id="p-s" className="cs__input" required value={f('pS')} onChange={(e) => setF('pS', e.target.value)} /></Field>
            <Field id="p-d" label="Document reference"><input id="p-d" className="cs__input" value={f('pD')} onChange={(e) => setF('pD', e.target.value)} /></Field>
            <button type="submit" className="cs__btn cs__btn--primary">Save draft</button>
          </form>
          <ul style={list}>{(policies.data ?? []).map((p) => <li key={p.id} className="ig__row" style={{ flexWrap: 'wrap' }}><div className="ig__rowMain"><strong>{p.title}</strong><span className="ig__status">{p.owner}</span>
            {(p.versions ?? []).map((v) => <p key={v.id}>v{v.version} · {v.status}{v.effective_from ? ` from ${day(v.effective_from)}` : ''} · {v.summary}
              {v.status === 'draft' && <> <button type="button" className="cs__btn" onClick={() => void act(v.id, async () => { await postJson(`/api/gov/policy-versions/${v.id}/approve`, {}); return 'Approved.'; })}>Approve</button></>}
              {v.status === 'approved' && <> <button type="button" className="cs__btn" onClick={() => setAsking({ id: v.id, label: 'Effective from (YYYY-MM-DD)', run: async (s) => { await postJson(`/api/gov/policy-versions/${v.id}/publish`, { effectiveFrom: s }); return 'Published.'; } })}>Publish</button></>}
              {v.status === 'published' && <> <button type="button" className="cs__btn" onClick={() => setAsking({ id: v.id, label: 'Acknowledge by (YYYY-MM-DD) | roles, comma separated (empty for everyone)', run: async (s) => { const [due, roles] = s.split('|').map((x) => x.trim()); await postJson(`/api/gov/policy-versions/${v.id}/campaign`, { dueOn: due, roles: (roles ?? '').split(',').map((x) => x.trim()).filter(Boolean) }); return 'Acknowledgement campaign started.'; } })}>Ask people to acknowledge</button></>}
            </p>)}
            {p.campaigns.map((c) => <p key={c.id}><small>Campaign v{c.version}: {c.acknowledged} of {c.audienceSize} by {day(c.due_on)}</small></p>)}</div>
            <button type="button" className="cs__btn" onClick={() => setAsking({ id: p.id, label: 'Summary of the new version', run: async (s) => { await postJson(`/api/gov/policies/${p.id}/versions`, { summary: s }); return 'New draft version.'; } })}>New version</button>
          </li>)}</ul>
        </>}

        {current === 'controls' && controls.data && <>
          <p className="ig__notice">{controls.data.disclaimer}</p>
          {team('compliance', 'security') && <form className="ig__form" onSubmit={(e) => { e.preventDefault(); void act('k', async () => { await postJson('/api/gov/controls', { ref: f('kR'), title: f('kT'), ownerId: f('kO'), framework: f('kF') || undefined, evidenceType: f('kE'), frequencyDays: Number(f('kQ') || 90) }); setForm({}); return 'Control saved.'; }); }}>
            <div className="ig__formTitle"><strong>Control</strong><p>Who owns it, what evidence shows it works, and how often it is tested.</p></div>
            <Field id="k-r" label="Reference"><input id="k-r" className="cs__input" required value={f('kR')} onChange={(e) => setF('kR', e.target.value)} /></Field>
            <Field id="k-t" label="What it does"><input id="k-t" className="cs__input" required value={f('kT')} onChange={(e) => setF('kT', e.target.value)} /></Field>
            {pick('k-o', 'Owner', 'kO')}
            <Field id="k-f" label="Internal framework (optional)"><input id="k-f" className="cs__input" value={f('kF')} onChange={(e) => setF('kF', e.target.value)} /></Field>
            <Field id="k-e" label="Evidence"><input id="k-e" className="cs__input" required value={f('kE')} onChange={(e) => setF('kE', e.target.value)} /></Field>
            <Field id="k-q" label="Test every (days)"><input id="k-q" type="number" className="cs__input" value={f('kQ')} onChange={(e) => setF('kQ', e.target.value)} /></Field>
            <button type="submit" className="cs__btn cs__btn--primary">Save control</button>
          </form>}
          <ul style={list}>{controls.data.controls.map((k) => <li key={k.id} className="ig__row"><div className="ig__rowMain"><strong>{k.ref} {k.title}</strong><span className={`ig__status ${k.status === 'effective' ? '' : 'ig__status--off'}`}>{words(k.status)}{k.overdue ? ' · test overdue' : ''}</span>
            <p>{k.owner} · evidence: {k.evidence_type} · every {k.frequency_days} days · next {day(k.next_test_due)}{k.framework ? ` · ${k.framework}` : ''}</p>
            {(k.tests ?? []).length > 0 && <p><small>{(k.tests ?? []).map((t) => `${day(t.tested_at)} ${t.result} (${t.evidence_ref}) by ${t.by}`).join(' · ')}</small></p>}</div>
            <button type="button" className="cs__btn" onClick={() => setAsking({ id: k.id, label: 'Result (pass or fail) | evidence reference | notes', run: async (s) => { const [result, evidenceRef, notes] = s.split('|').map((x) => x.trim()); await postJson(`/api/gov/controls/${k.id}/test`, { result, evidenceRef, notes }); return 'Test recorded.'; } })}>Record test</button></li>)}</ul>
        </>}

        {current === 'exceptions' && <ul style={list}>{(exceptions.data ?? []).map((x) => <li key={x.id} className="ig__row"><div className="ig__rowMain"><strong>{x.kind}: {x.target}</strong><span className={`ig__status ${x.status === 'approved' ? '' : 'ig__status--off'}`}>{x.status} · until {day(x.expires_on)}</span><p>{x.subject} · {x.reason} · asked by {x.requested_by}{x.decision_note ? ` · ${x.decision_note}` : ''}</p></div>
          {x.status === 'requested' && team('compliance') && <div className="pp2__roleEdit"><button type="button" className="cs__btn" onClick={() => setAsking({ id: x.id, label: 'Approval note', run: async (n) => { await postJson(`/api/gov/exceptions/${x.id}/decide`, { decision: 'approve', note: n }); return 'Approved.'; } })}>Approve</button><button type="button" className="cs__btn" onClick={() => setAsking({ id: x.id, label: 'Why not?', run: async (n) => { await postJson(`/api/gov/exceptions/${x.id}/decide`, { decision: 'reject', note: n }); return 'Rejected.'; } })}>Reject</button></div>}
        </li>)}{exceptions.data && !exceptions.data.length && empty('No exceptions.')}</ul>}

        {current === 'audits' && (openEngagement ? engagementPanel : <>
          {team('compliance') && <form className="ig__form" onSubmit={(e) => { e.preventDefault(); void act('en', async () => { await postJson('/api/gov/engagements', { title: f('eT'), periodFrom: f('eF'), periodTo: f('eTo'), scope: { processKeys: f('eP').split(',').map((x) => x.trim()).filter(Boolean), contractIds: f('eC') ? [f('eC')] : [] } }); setForm({}); return 'Engagement created.'; }); }}>
            <div className="ig__formTitle"><strong>New audit engagement</strong><p>The scope decides exactly what an auditor can read.</p></div>
            <Field id="e-t" label="Title"><input id="e-t" className="cs__input" required value={f('eT')} onChange={(e) => setF('eT', e.target.value)} /></Field>
            <Field id="e-f" label="Period from"><input id="e-f" type="date" className="cs__input" required value={f('eF')} onChange={(e) => setF('eF', e.target.value)} /></Field>
            <Field id="e-to" label="to"><input id="e-to" type="date" className="cs__input" required value={f('eTo')} onChange={(e) => setF('eTo', e.target.value)} /></Field>
            <Field id="e-p" label="Process keys in scope (comma separated)"><input id="e-p" className="cs__input" value={f('eP')} onChange={(e) => setF('eP', e.target.value)} /></Field>
            <Field id="e-c" label="Contract in scope (optional)"><select id="e-c" className="cs__input" value={f('eC')} onChange={(e) => setF('eC', e.target.value)}><option value="">None</option>{(contracts.data ?? []).map((c) => <option key={c.id} value={c.id}>#{c.number} {c.title}</option>)}</select></Field>
            <button type="submit" className="cs__btn cs__btn--primary">Create</button>
          </form>}
          <ul style={list}>{(engagements.data ?? []).map((e) => <li key={e.id} className="ig__row"><div className="ig__rowMain"><strong>{e.title}</strong><span className="ig__status">{words(e.status)}</span>
            <p>{day(e.period_from)} to {day(e.period_to)} · lead {e.lead} · {e.open_findings} open findings · {e.open_requests} open requests{(e.auditors ?? []).length ? ` · auditors: ${(e.auditors ?? []).map((a) => `${a.name} until ${day(a.expires_at)}${a.can_export ? ' (export)' : ''}`).join(', ')}` : ''}</p></div>
            <button type="button" className="cs__btn" onClick={() => void showEngagement(e.id)}>Open</button></li>)}{engagements.data && !engagements.data.length && empty('No engagements.')}</ul>
        </>)}

        {current === 'holds' && holds.data && <>
          <form className="ig__form" onSubmit={(e) => { e.preventDefault(); void act('h', async () => { await postJson('/api/gov/holds', { title: f('hT'), reason: f('hR'), scope: { processKeys: f('hP').split(',').map((x) => x.trim()).filter(Boolean) } }); setForm({}); return 'Legal hold placed. Matching records are kept out of every deletion run.'; }); }}>
            <div className="ig__formTitle"><strong>Place a legal hold</strong><p>Visible only to owners and the Legal team. Held records are skipped by retention and each blocked run is recorded here.</p></div>
            <Field id="h-t" label="Title"><input id="h-t" className="cs__input" required value={f('hT')} onChange={(e) => setF('hT', e.target.value)} /></Field>
            <Field id="h-r" label="Reason"><input id="h-r" className="cs__input" required value={f('hR')} onChange={(e) => setF('hR', e.target.value)} /></Field>
            <Field id="h-p" label="Process keys (comma separated)"><input id="h-p" className="cs__input" required value={f('hP')} onChange={(e) => setF('hP', e.target.value)} /></Field>
            <button type="submit" className="cs__btn cs__btn--primary">Place hold</button>
          </form>
          <ul style={list}>{holds.data.holds.map((h) => <li key={h.id} className="ig__row"><div className="ig__rowMain"><strong>{h.title}</strong><span className={`ig__status ${h.status === 'cleared' ? '' : 'ig__status--off'}`}>{h.status}{h.blocked ? ` · ${h.blocked} record(s) kept from deletion` : ''}</span>
            <p>{h.reason} · {h.scope.processKeys.join(', ')}{h.scope.instanceIds.length ? ` + ${h.scope.instanceIds.length} record(s)` : ''} · by {h.created_by}{h.release_reason ? ` · released by ${h.released_by}: ${h.release_reason}` : ''}{h.clear_note ? ` · cleared by ${h.cleared_by}: ${h.clear_note}` : ''}</p></div>
            {h.status === 'active' && <button type="button" className="cs__btn" onClick={() => setAsking({ id: h.id, label: 'Why release it?', run: async (r) => { const x = await postJson<{ next: string }>(`/api/gov/holds/${h.id}/release`, { reason: r }); return x.next; } })}>Release</button>}
            {h.status === 'released' && <button type="button" className="cs__btn" onClick={() => setAsking({ id: h.id, label: 'Your review before normal retention resumes', run: async (n) => { await postJson(`/api/gov/holds/${h.id}/clear`, { note: n }); return 'Cleared. Normal retention applies again.'; } })}>Review and clear</button>}
          </li>)}{!holds.data.holds.length && empty('No legal holds.')}</ul>
          {holds.data.blocks.length > 0 && <><strong>Deletion runs a hold stopped</strong><ul style={list}>{holds.data.blocks.map((b) => <li key={b.id}><small>{new Date(b.occurred_at).toLocaleString()} · {b.process_key} · {b.held_records} record(s) kept · hold "{b.hold}" · run by {b.run_by}</small></li>)}</ul></>}
          {me?.admin && <form className="ig__form" onSubmit={(e) => { e.preventDefault(); void act('rs', async () => { await postJson('/api/gov/retention-schedules', { processKey: f('rsK'), enabled: f('rsE') !== 'off' }); setForm({}); return 'Retention schedule saved.'; }); }}>
            <div className="ig__formTitle"><strong>Scheduled retention</strong><p>{holds.data.schedules.map((x) => `${x.process_key}: ${x.enabled ? 'daily' : 'off'}${x.last_run_at ? `, last ${new Date(x.last_run_at).toLocaleString()}` : ''}`).join(' · ') || 'Nothing scheduled. Records are deleted only when someone runs retention.'}</p></div>
            <Field id="rs-k" label="Process key"><input id="rs-k" className="cs__input" required value={f('rsK')} onChange={(e) => setF('rsK', e.target.value)} /></Field>
            <Field id="rs-e" label="Daily deletion"><select id="rs-e" className="cs__input" value={f('rsE')} onChange={(e) => setF('rsE', e.target.value)}><option value="on">On</option><option value="off">Off</option></select></Field>
            <button type="submit" className="cs__btn">Save</button>
          </form>}
        </>}

        {current === 'setup' && settings.data && <>
          <form className="ig__form" onSubmit={(e) => { e.preventDefault(); void act('gs', async () => { await postJson('/api/gov/settings', { alwaysReview: (f('aR') || settings.data!.settings.alwaysReview.join(',')).split(',').map((x) => x.trim()), materialInvalidates: (f('mI') || settings.data!.settings.materialInvalidates.join(',')).split(',').map((x) => x.trim()), financeAbove: f('fA') === '' ? settings.data!.settings.financeAbove : f('fA'), renewalLeadDays: Number(f('rL') || settings.data!.settings.renewalLeadDays) }); setForm({}); return 'Rules saved.'; }); }}>
            <div className="ig__formTitle"><strong>Contract review rules</strong><p>Changing these asks for your password again.</p></div>
            <Field id="g-ar" label="Every contract is reviewed by (business, legal, security, finance)"><input id="g-ar" className="cs__input" value={f('aR') || settings.data.settings.alwaysReview.join(', ')} onChange={(e) => setF('aR', e.target.value)} /></Field>
            <Field id="g-fa" label="Finance also reviews from this value"><input id="g-fa" type="number" className="cs__input" value={f('fA') || String(settings.data.settings.financeAbove ?? '')} onChange={(e) => setF('fA', e.target.value)} /></Field>
            <Field id="g-mi" label="A material change cancels these approvals"><input id="g-mi" className="cs__input" value={f('mI') || settings.data.settings.materialInvalidates.join(', ')} onChange={(e) => setF('mI', e.target.value)} /></Field>
            <Field id="g-rl" label="Renewal task appears this many days before the notice deadline"><input id="g-rl" type="number" className="cs__input" value={f('rL') || String(settings.data.settings.renewalLeadDays)} onChange={(e) => setF('rL', e.target.value)} /></Field>
            <button type="submit" className="cs__btn cs__btn--primary">Save rules</button>
          </form>
          <form className="ig__form" onSubmit={(e) => { e.preventDefault(); void act('gt', async () => { await postJson('/api/gov/teams', { team: f('gT') || 'legal', actorId: f('gA') }); setForm({}); return 'Added.'; }); }}>
            <div className="ig__formTitle"><strong>Teams</strong><p>{settings.data.teams.map((x) => `${x.team}: ${x.display_name}`).join(' · ') || 'Nobody yet.'}</p></div>
            <Field id="g-t" label="Team"><select id="g-t" className="cs__input" value={f('gT')} onChange={(e) => setF('gT', e.target.value)}>{['legal', 'compliance', 'security', 'finance'].map((x) => <option key={x} value={x}>{x}</option>)}</select></Field>
            {pick('g-a', 'Person', 'gA')}
            <button type="submit" className="cs__btn cs__btn--primary">Add</button>
          </form>
        </>}
      </section>
    </div>
  </div>;
}
