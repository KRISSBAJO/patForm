'use client';

import './meetings.css';
import { useCallback, useEffect, useState } from 'react';
import { EmptyState } from './module-shell';
import { postJson } from './stepup';
import { Choice, F, Sheet, SheetSection } from './sheet';

/*
 * Headquarters. One workspace is the International Headquarters of a
 * worldwide church; each National is its own workspace that joined with a
 * one-time code from Headquarters. Headquarters sees figures for every
 * National, sets rules they all follow, and decides requests a rule sends to
 * it. Nationals never see each other, and see when Headquarters opened their
 * records.
 */

type Status =
  | { role: 'headquarters'; group: { id: string; name: string }; permissions: string[]; canAdminister: boolean }
  | { role: 'national'; group: { id: string; name: string }; label: string | null; headquarters: string | null; joinedAt: string | null; rules: Rule[]; canAdminister: boolean }
  | { role: 'none'; canAdminister: boolean; isOwner: boolean };
type Rule = { id: string; kind: 'escalate' | 'require_document'; name: string; applies: { typeSeed?: string; category?: string; minAmount?: number }; document: string | null; active?: boolean };
type NationalRow = { id: string; label: string; workspace: string; joinedAt: string; stations: number; jurisdictions: number; members: number; vacant: number; open: number; overdue: number; decided30: number; escalations: number };
type Overview = { group: { id: string; name: string }; permissions: string[]; nationals: NationalRow[]; totals: { nationals: number; stations: number; members: number; vacant: number; open: number; overdue: number; escalations: number; rules: number } };
type Escalation = { id: string; title: string; national: string; type_name: string; category: string | null; requester: string; opened_at: string; mine: boolean };
type Access = { people: { id: string; display_name: string; email: string; workspace_role: string; permissions: string[]; implicit: boolean }[]; invites: { id: string; label: string; created_at: string; expires_at: string; accepted_at: string | null; revoked_at: string | null }[]; permissions: string[] };
type Detail = { request: { id: string; title: string; status: string; answers: Record<string, unknown>; national: string; requester: string | null }; type: { fields: { key: string; label: string }[] } | null; steps: { id: number; name: string; status: string; note: string | null; hq: boolean; approvals: number; required: number; votes: { name: string; decision: string; note: string | null }[] }[]; files: { id: string; filename: string; byte_size: number }[]; canDecide: boolean };

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path, { credentials: 'same-origin' });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.reason ?? body.error ?? `HTTP ${res.status}`);
  return body as T;
}
function useFeed<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => { if (!path) return; try { setData(await get<T>(path)); setError(null); } catch (err) { setError(err instanceof Error ? err.message : String(err)); } }, [path]);
  useEffect(() => { void reload(); }, [reload]);
  return { data, error, reload };
}
const day = (v: string | null) => (v ? new Date(v).toLocaleDateString([], { dateStyle: 'medium' }) : '');
const PERM: Record<string, string> = { view: 'See figures', records: 'Open National records', policies: 'Set global rules', escalations: 'Decide escalations', manage: 'Nationals and access' };
const covers = (r: Rule) => [r.applies.category && `${r.applies.category} requests`, r.applies.typeSeed && `the ${r.applies.typeSeed.replace(/_/g, ' ')} type`, r.applies.minAmount !== undefined && `from ${r.applies.minAmount.toLocaleString()}`].filter(Boolean).join(' · ');
const Pill = ({ s, text }: { s: string; text: string }) => <span className={`mx__pill mx__pill--${s}`}><i />{text}</span>;

export function HeadquartersView() {
  const status = useFeed<Status>('/api/headquarters');
  const s = status.data;
  const isHq = s?.role === 'headquarters';
  const can = (p: string) => s?.role === 'headquarters' && s.permissions.includes(p);
  const overview = useFeed<Overview>(isHq && can('view') ? '/api/headquarters/overview' : null);
  const escalations = useFeed<Escalation[]>(isHq && (can('escalations') || can('records')) ? '/api/headquarters/escalations' : null);
  const rules = useFeed<Rule[]>(isHq && (can('policies') || can('view') || can('escalations')) ? '/api/headquarters/rules' : null);
  const access = useFeed<Access>(isHq && (can('manage') || can('view')) ? '/api/headquarters/access' : null);
  const [tab, setTab] = useState<'overview' | 'escalations' | 'rules' | 'access'>('overview');
  const [note, setNote] = useState<{ text: string; err?: boolean } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [create, setCreate] = useState<string | null>(null);
  const [join, setJoin] = useState<string | null>(null);
  const [invite, setInvite] = useState<{ label: string; code?: string } | null>(null);
  const [ruleSheet, setRuleSheet] = useState<{ id?: string; kind: 'escalate' | 'require_document'; name: string; category: string; typeSeed: string; minAmount: string; document: string; active: boolean } | null>(null);
  const [opened, setOpened] = useState<Detail | null>(null);
  const [decision, setDecision] = useState<{ kind: 'approve' | 'return' | 'reject'; note: string } | null>(null);
  const [records, setRecords] = useState<{ national: { id: string; label: string }; requests: { id: string; title: string; status: string; type_name: string; requester: string; updated_at: string }[] } | null>(null);

  const act = async (id: string, work: () => Promise<string>) => {
    setBusy(id); setNote(null);
    try { setNote({ text: await work() }); await Promise.all([status.reload(), overview.reload(), escalations.reload(), rules.reload(), access.reload()]); }
    catch (err) { setNote({ text: err instanceof Error ? err.message : String(err), err: true }); }
    finally { setBusy(null); }
  };
  const openRequest = async (id: string) => { try { setOpened(await get<Detail>(`/api/headquarters/requests/${id}`)); setDecision(null); } catch (err) { setNote({ text: err instanceof Error ? err.message : String(err), err: true }); } };

  if (status.error) return <div className="mx"><p className="mx__notice mx__notice--err">{status.error}</p></div>;
  if (!s) return <div className="mx"><p className="mx__tiny">Loading…</p></div>;

  const notice = note && <p className={`mx__notice ${note.err ? 'mx__notice--err' : ''}`} style={{ marginTop: 16 }} role="status">{note.text}</p>;

  // ---------------------------------------------------------- not yet
  if (s.role === 'none') return <div className="mx">
    <section className="mx__band"><div className="mx__bandGrid"><div>
      <div className="mx__eyebrow">Headquarters</div>
      <h2 className="mx__bandTitle">One church, many Nationals</h2>
      <p className="mx__bandSub">Link this workspace to an International Headquarters, or make it the Headquarters.</p>
    </div></div></section>
    {notice}
    <div className="hr__grid2" style={{ marginTop: 16 }}>
      <div className="mx__card"><div className="mx__cardBody"><h3 className="hq__h">This is a National</h3><p className="mx__tiny">Enter the code your Headquarters gave you. Your workspace stays yours. Headquarters sees figures, sets rules you follow, and decides requests those rules send to it.</p>
        {s.isOwner ? <button type="button" className="mx__btn" onClick={() => setJoin('')}>Join a headquarters</button> : <p className="mx__tiny">Only the workspace owner can join.</p>}</div></div>
      <div className="mx__card"><div className="mx__cardBody"><h3 className="hq__h">This is the Headquarters</h3><p className="mx__tiny">Invite each National with a one-time code, see their figures in one place, set global rules and decide what they escalate.</p>
        {s.canAdminister ? <button type="button" className="mx__btn mx__btn--ghost" onClick={() => setCreate('')}>Make this the Headquarters</button> : <p className="mx__tiny">An owner or admin can do this.</p>}</div></div>
    </div>
    {join !== null && <Sheet eyebrow="Headquarters" title="Join a headquarters" subtitle="Headquarters sees only what its grants allow, and every time it opens one of your records, your audit log shows it." onClose={() => setJoin(null)}
      footer={<><button type="button" className="mx__btn mx__btn--ghost" onClick={() => setJoin(null)}>Cancel</button><button type="button" className="mx__btn" disabled={!join.trim() || busy === 'join'} onClick={() => void act('join', async () => { const r = await postJson<{ headquarters: string; label: string }>('/api/headquarters/join', { code: join.trim() }); setJoin(null); return `Joined ${r.headquarters} as ${r.label}.`; })}>Join</button></>}>
      <SheetSection title="Code"><F label="Code from Headquarters" wide><input autoFocus value={join} onChange={(e) => setJoin(e.target.value)} placeholder="grp_…" /></F></SheetSection>
    </Sheet>}
    {create !== null && <Sheet eyebrow="Headquarters" title="Make this the Headquarters" subtitle="This workspace becomes the International Headquarters. Nationals join with codes you give them." onClose={() => setCreate(null)}
      footer={<><button type="button" className="mx__btn mx__btn--ghost" onClick={() => setCreate(null)}>Cancel</button><button type="button" className="mx__btn" disabled={!create.trim() || busy === 'create'} onClick={() => void act('create', async () => { await postJson('/api/headquarters', { name: create.trim() }); setCreate(null); return 'This workspace is now the Headquarters. Invite your first National.'; })}>Create</button></>}>
      <SheetSection title="The church"><F label="Name of the church worldwide" wide><input autoFocus value={create} onChange={(e) => setCreate(e.target.value)} placeholder="The Worldwide Church" /></F></SheetSection>
    </Sheet>}
  </div>;

  // ---------------------------------------------------------- a National
  if (s.role === 'national') return <div className="mx">
    <section className="mx__band"><div className="mx__bandGrid"><div>
      <div className="mx__eyebrow">Headquarters</div>
      <h2 className="mx__bandTitle">{s.label ?? 'National'} of {s.group.name}</h2>
      <p className="mx__bandSub">Headquarters workspace: {s.headquarters ?? 'not shown'} · joined {day(s.joinedAt)}</p>
    </div>
      <div className="mx__kpi"><span>Global rules</span><strong>{s.rules.length}</strong><small>set by Headquarters</small></div>
    </div></section>
    {notice}
    <div className="mx__card" style={{ marginTop: 16 }}><div className="mx__cardHead"><h3>Rules you follow</h3><small>Headquarters sets these; they apply to every National</small></div>
      <ul className="mx__list">{s.rules.map((r) => <li key={r.id}><div className="mx__main"><strong>{r.name}</strong><small>{r.kind === 'escalate' ? 'Goes to Headquarters for review after your own approvals' : `Requires: ${r.document}`} · {covers(r)}</small></div><Pill s={r.kind === 'escalate' ? 'called' : 'open'} text={r.kind === 'escalate' ? 'Escalation' : 'Document'} /></li>)}
        {!s.rules.length && <li><EmptyState icon="check" title="No global rules yet" text="When Headquarters sets one, it shows here and applies to your requests at once." /></li>}</ul></div>
    <p className="mx__tiny" style={{ margin: '12px 4px' }}>Every time Headquarters opens one of your records or decides a request, it is written to your workspace audit log.</p>
  </div>;

  // ---------------------------------------------------------- Headquarters
  const o = overview.data;
  const tabs = ([['overview', 'Nationals'], ['escalations', 'Escalations'], ['rules', 'Global rules'], ['access', 'Access & codes']] as [typeof tab, string][]).filter(([k]) => k === 'overview' ? can('view') : k === 'escalations' ? can('escalations') || can('records') : k === 'rules' ? can('policies') || can('view') : can('manage'));
  const activeTab = tabs.some(([k]) => k === tab) ? tab : tabs[0]?.[0];
  return <div className="mx">
    <section className="mx__band"><div className="mx__bandGrid">
      <div>
        <div className="mx__eyebrow">International Headquarters</div>
        <h2 className="mx__bandTitle">{s.group.name}</h2>
        <p className="mx__bandSub">{o ? `${o.totals.nationals} National${o.totals.nationals === 1 ? '' : 's'} · ${o.totals.stations.toLocaleString()} stations · ${o.totals.members.toLocaleString()} people` : 'Figures need the view permission.'}</p>
        <div className="mx__bandActions">{can('manage') && <button type="button" className="mx__btn mx__btn--light" onClick={() => setInvite({ label: '' })}>+ Invite a National</button>}</div>
      </div>
      <div className={`mx__kpi ${o?.totals.escalations ? 'mx__kpi--live' : ''}`}><span>Escalations</span><strong>{o?.totals.escalations ?? escalations.data?.length ?? 0}</strong><small>waiting for Headquarters</small></div>
      <div className="mx__kpi"><span>Open requests</span><strong>{o?.totals.open ?? '—'}</strong><small>{o ? `${o.totals.overdue} older than a week` : ''}</small></div>
      <div className="mx__kpi"><span>Vacant offices</span><strong>{o?.totals.vacant ?? '—'}</strong><small>across all Nationals</small></div>
    </div></section>
    {notice}
    <div className="mx__segs" style={{ marginTop: 16 }}>{tabs.map(([k, l]) => <button key={k} type="button" className={`mx__seg ${activeTab === k ? 'is-on' : ''}`} onClick={() => setTab(k)}>{l}</button>)}</div>

    {activeTab === 'overview' && <div className="mx__card" style={{ marginTop: 14 }}>
      <div className="mx__cardHead"><h3>Nationals</h3><small>figures only{can('records') ? '; open one to see its requests' : ''}</small></div>
      <table className="mx__table"><thead><tr><th>National</th><th>Stations</th><th>People</th><th>Vacant</th><th>Open</th><th>Older than a week</th><th>Decided, 30 days</th><th>Escalations</th><th>Joined</th></tr></thead>
        <tbody>{(o?.nationals ?? []).map((n) => <tr key={n.id} className={can('records') ? 'is-click' : ''} onClick={() => can('records') && void get<NonNullable<typeof records>>(`/api/headquarters/nationals/${n.id}/requests`).then(setRecords).catch((e: Error) => setNote({ text: e.message, err: true }))}>
          <td><strong>{n.label}</strong><br /><span className="mx__tiny">{n.workspace} · {n.jurisdictions} jurisdictions</span></td><td>{n.stations}</td><td>{n.members}</td><td>{n.vacant}</td><td>{n.open}</td><td>{n.overdue ? <Pill s="failed" text={String(n.overdue)} /> : 0}</td><td>{n.decided30}</td><td>{n.escalations ? <Pill s="called" text={String(n.escalations)} /> : 0}</td><td>{day(n.joinedAt)}</td></tr>)}
          {o && !o.nationals.length && <tr><td colSpan={9}><EmptyState icon="people" title="No Nationals yet" text="Invite each National with a one-time code. Its owner enters the code to join." action={can('manage') ? { label: 'Invite a National', onClick: () => setInvite({ label: '' }) } : undefined} /></td></tr>}</tbody></table>
    </div>}

    {activeTab === 'escalations' && <div className="mx__card" style={{ marginTop: 14 }}>
      <div className="mx__cardHead"><h3>Waiting for Headquarters</h3><small>sent here by a global rule, after the National’s own approvals</small></div>
      <ul className="mx__list">{(escalations.data ?? []).map((e) => <li key={e.id}><div className="mx__main"><strong>{e.title}</strong><small>{e.national} · {e.type_name}{e.category ? ` · ${e.category}` : ''} · from {e.requester} · since {day(e.opened_at)}</small></div>{e.mine && <Pill s="open" text="Yours to decide" />}<button type="button" className="mx__btn mx__btn--sm" onClick={() => void openRequest(e.id)}>Open</button></li>)}
        {escalations.data && !escalations.data.length && <li><EmptyState icon="check" title="Nothing waiting" text="Requests a global rule escalates arrive here once the National has approved them." /></li>}</ul>
    </div>}

    {activeTab === 'rules' && <div className="mx__card" style={{ marginTop: 14 }}>
      <div className="mx__cardHead"><h3>Global rules</h3>{can('policies') && <button type="button" className="mx__btn mx__btn--sm" onClick={() => setRuleSheet({ kind: 'escalate', name: '', category: 'Finance', typeSeed: '', minAmount: '', document: '', active: true })}>+ Rule</button>}</div>
      <ul className="mx__list">{(rules.data ?? []).map((r) => <li key={r.id} className={r.active === false ? 'is-off' : ''}><div className="mx__main"><strong>{r.name}{r.active === false && ' (off)'}</strong><small>{r.kind === 'escalate' ? 'Headquarters reviews last' : `Requires: ${r.document}`} · {covers(r)}</small></div>{can('policies') && <button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => setRuleSheet({ id: r.id, kind: r.kind, name: r.name, category: r.applies.category ?? '', typeSeed: r.applies.typeSeed ?? '', minAmount: r.applies.minAmount === undefined ? '' : String(r.applies.minAmount), document: r.document ?? '', active: r.active !== false })}>Edit</button>}</li>)}
        {rules.data && !rules.data.length && <li><EmptyState icon="register" title="No global rules" text="A rule can send large requests to Headquarters, or require a document from every National." /></li>}</ul>
    </div>}

    {activeTab === 'access' && access.data && <div className="mx__stack" style={{ marginTop: 14 }}>
      <div className="mx__card"><div className="mx__cardHead"><h3>Who can do what across the Nationals</h3><small>owners and admins here hold everything</small></div>
        <table className="mx__table"><thead><tr><th>Person</th>{access.data.permissions.map((p) => <th key={p}>{PERM[p]}</th>)}</tr></thead>
          <tbody>{access.data.people.map((p) => <tr key={p.id}><td><strong>{p.display_name}</strong><br /><span className="mx__tiny">{p.email}</span></td>{access.data!.permissions.map((perm) => <td key={perm}><input type="checkbox" aria-label={`${p.display_name}: ${PERM[perm]}`} checked={p.implicit || p.permissions.includes(perm)} disabled={p.implicit || !can('manage') || busy === p.id} onChange={(e) => void act(p.id, async () => { await postJson('/api/headquarters/access', { actorId: p.id, permissions: e.target.checked ? [...p.permissions, perm] : p.permissions.filter((x) => x !== perm) }); return `Access for ${p.display_name} saved.`; })} /></td>)}</tr>)}</tbody></table></div>
      <div className="mx__card"><div className="mx__cardHead"><h3>Join codes</h3>{can('manage') && <button type="button" className="mx__btn mx__btn--sm" onClick={() => setInvite({ label: '' })}>+ Invite a National</button>}</div>
        <ul className="mx__list">{access.data.invites.map((i) => <li key={i.id}><div className="mx__main"><strong>{i.label}</strong><small>made {day(i.created_at)} · {i.accepted_at ? `joined ${day(i.accepted_at)}` : i.revoked_at ? 'withdrawn' : new Date(i.expires_at) < new Date() ? 'expired' : `open until ${day(i.expires_at)}`}</small></div>
          {!i.accepted_at && !i.revoked_at && new Date(i.expires_at) > new Date() && can('manage') && <button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => void act(i.id, async () => { await postJson(`/api/headquarters/invites/${i.id}/revoke`, {}); return 'Code withdrawn.'; })}>Withdraw</button>}</li>)}
          {!access.data.invites.length && <li><p className="mx__tiny">No codes yet.</p></li>}</ul></div>
      {can('manage') && (o?.nationals.length ?? 0) > 0 && <div className="mx__card"><div className="mx__cardHead"><h3>Remove a National</h3><small>it keeps its workspace and records; Headquarters loses access</small></div>
        <ul className="mx__list">{o!.nationals.map((n) => <li key={n.id}><div className="mx__main"><strong>{n.label}</strong></div><button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" disabled={busy === `rm-${n.id}`} onClick={() => void act(`rm-${n.id}`, async () => { await postJson(`/api/headquarters/nationals/${n.id}/remove`, {}); return `${n.label} removed from the group.`; })}>Remove</button></li>)}</ul></div>}
    </div>}

    {/* -------------------------------------------------------------- sheets */}
    {invite && <Sheet eyebrow="Nationals" title={invite.code ? `Code for ${invite.label}` : 'Invite a National'} subtitle={invite.code ? 'Send this to the National’s workspace owner. It works once, for 14 days, and is not shown again.' : 'The National’s owner enters the code in their own workspace, under Settings, Headquarters.'} onClose={() => setInvite(null)}
      footer={invite.code ? <button type="button" className="mx__btn" onClick={() => setInvite(null)}>Done</button> : <><button type="button" className="mx__btn mx__btn--ghost" onClick={() => setInvite(null)}>Cancel</button><button type="button" className="mx__btn" disabled={!invite.label.trim() || busy === 'invite'} onClick={() => void act('invite', async () => { const r = await postJson<{ code: string }>('/api/headquarters/invites', { label: invite.label.trim() }); setInvite({ label: invite.label.trim(), code: r.code }); return 'Code made.'; })}>Make code</button></>}>
      {invite.code ? <SheetSection title="Join code"><div className="hq__code">{invite.code}</div><button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => void navigator.clipboard?.writeText(invite.code!).then(() => setNote({ text: 'Code copied.' })).catch(() => setNote({ text: 'Copy was blocked; select the code instead.', err: true }))}>Copy</button></SheetSection>
        : <SheetSection title="The National"><F label="Name" wide><input autoFocus value={invite.label} onChange={(e) => setInvite({ label: e.target.value })} placeholder="Nigeria National" /></F></SheetSection>}
    </Sheet>}

    {ruleSheet && <Sheet eyebrow="Global rules" title={ruleSheet.id ? `Edit ${ruleSheet.name}` : 'New global rule'} subtitle="Every National follows this rule. They can see it, but cannot change it." onClose={() => setRuleSheet(null)}
      footer={<><button type="button" className="mx__btn mx__btn--ghost" onClick={() => setRuleSheet(null)}>Cancel</button><button type="button" className="mx__btn" disabled={!ruleSheet.name.trim() || busy === 'rule'} onClick={() => void act('rule', async () => { await postJson('/api/headquarters/rules', { id: ruleSheet.id, kind: ruleSheet.kind, name: ruleSheet.name, document: ruleSheet.document, active: ruleSheet.active, applies: { category: ruleSheet.category || undefined, typeSeed: ruleSheet.typeSeed || undefined, minAmount: ruleSheet.minAmount === '' ? undefined : Number(ruleSheet.minAmount) } }); setRuleSheet(null); return 'Rule saved. It applies to new submissions in every National.'; })}>Save rule</button></>}>
      <SheetSection title="What it does">
        <F label="Rule" wide><Choice value={ruleSheet.kind} onChange={(v) => setRuleSheet({ ...ruleSheet, kind: v as 'escalate' | 'require_document' })} options={[['escalate', 'Headquarters reviews last'], ['require_document', 'Requires a document']]} /></F>
        <F label="Name" wide><input autoFocus value={ruleSheet.name} onChange={(e) => setRuleSheet({ ...ruleSheet, name: e.target.value })} placeholder="Large spending goes to Headquarters" /></F>
        {ruleSheet.kind === 'require_document' && <F label="Document" wide><input value={ruleSheet.document} onChange={(e) => setRuleSheet({ ...ruleSheet, document: e.target.value })} placeholder="Board resolution" /></F>}
      </SheetSection>
      <SheetSection title="Which requests" hint="All that you fill must match. The amount uses each request type’s amount question.">
        <F label="Category"><input value={ruleSheet.category} onChange={(e) => setRuleSheet({ ...ruleSheet, category: e.target.value })} placeholder="Finance" /></F>
        <F label="From amount"><input inputMode="decimal" value={ruleSheet.minAmount} onChange={(e) => setRuleSheet({ ...ruleSheet, minAmount: e.target.value })} placeholder="50000" /></F>
        <F label="Only this request type" hint="optional, e.g. church_expenditure"><input value={ruleSheet.typeSeed} onChange={(e) => setRuleSheet({ ...ruleSheet, typeSeed: e.target.value })} /></F>
        {ruleSheet.id && <F label="Status"><Choice value={ruleSheet.active ? 'on' : 'off'} onChange={(v) => setRuleSheet({ ...ruleSheet, active: v === 'on' })} options={[['on', 'In force'], ['off', 'Off']]} /></F>}
      </SheetSection>
    </Sheet>}

    {records && <Sheet wide eyebrow="National records" title={records.national.label} subtitle="Opening this list was recorded in the National’s audit log." onClose={() => setRecords(null)}>
      <SheetSection title="Requests"><ul className="mx__list hq__wide">{records.requests.map((r) => <li key={r.id}><div className="mx__main"><strong>{r.title}</strong><small>{r.type_name} · {r.requester} · {r.status} · {day(r.updated_at)}</small></div><button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => void openRequest(r.id)}>Open</button></li>)}{!records.requests.length && <li><p className="mx__tiny">No submitted requests.</p></li>}</ul></SheetSection>
    </Sheet>}

    {opened && <Sheet wide eyebrow={`${opened.request.national} · ${opened.request.status}`} title={opened.request.title} subtitle={`From ${opened.request.requester ?? 'a member'}. Opening it was recorded in the National’s audit log.`} onClose={() => setOpened(null)}
      footer={opened.canDecide ? (decision
        ? <><button type="button" className="mx__btn mx__btn--ghost" onClick={() => setDecision(null)}>Back</button><button type="button" className="mx__btn" disabled={busy === 'decide' || (decision.kind !== 'approve' && !decision.note.trim())} onClick={() => void act('decide', async () => { const r = await postJson<{ status: string }>(`/api/headquarters/requests/${opened.request.id}/decide`, { decision: decision.kind, note: decision.note }); setOpened(null); setDecision(null); return r.status === 'approved' ? 'Approved by Headquarters.' : r.status === 'rejected' ? 'Rejected. The National and requester can see why.' : r.status === 'returned' ? 'Returned to the requester.' : 'Your decision is recorded.'; })}>Confirm</button></>
        : <><button type="button" className="mx__btn mx__btn--ghost" onClick={() => setDecision({ kind: 'reject', note: '' })}>Reject</button><button type="button" className="mx__btn mx__btn--ghost" onClick={() => setDecision({ kind: 'return', note: '' })}>Return</button><button type="button" className="mx__btn" onClick={() => setDecision({ kind: 'approve', note: '' })}>Approve</button></>) : undefined}>
      {decision && <SheetSection title={decision.kind === 'approve' ? 'Approve' : decision.kind === 'reject' ? 'Reject' : 'Return for changes'}><F label={decision.kind === 'approve' ? 'Note (optional)' : 'Why? The National and requester see this.'} wide><textarea rows={3} value={decision.note} onChange={(e) => setDecision({ ...decision, note: e.target.value })} /></F></SheetSection>}
      <SheetSection title="Answers"><div className="hq__answers hq__wide">{(opened.type?.fields ?? []).map((f) => <div key={f.key}><span>{f.label}</span><strong>{String(opened.request.answers[f.key] ?? '—')}</strong></div>)}</div></SheetSection>
      <SheetSection title="Documents"><div className="hq__wide">{opened.files.map((f) => <button key={f.id} type="button" className="mx__btn mx__btn--ghost mx__btn--sm" style={{ marginRight: 8 }} onClick={() => void get<{ url: string }>(`/api/headquarters/requests/${opened.request.id}/files/${f.id}`).then((l) => window.open(l.url, '_blank', 'noopener,noreferrer')).catch((e: Error) => setNote({ text: e.message, err: true }))}>{f.filename}</button>)}{!opened.files.length && <p className="mx__tiny">No files.</p>}</div></SheetSection>
      <SheetSection title="Route"><ol className="hq__route hq__wide">{opened.steps.map((st) => <li key={st.id} className={`is-${st.status}`}><strong>{st.name}{st.hq ? ' (Headquarters)' : ''}</strong><small>{st.status.replace('_', ' ')}{st.status === 'approved' || st.status === 'pending' ? ` · ${st.approvals}/${st.required}` : ''}{st.note && st.status !== 'not_needed' ? ` · ${st.note}` : ''}</small>{st.votes.map((v, i) => <small key={i}>{v.name}: {v.decision}{v.note ? `, “${v.note}”` : ''}</small>)}</li>)}</ol></SheetSection>
    </Sheet>}
  </div>;
}
