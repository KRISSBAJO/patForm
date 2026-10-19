'use client';

import { useCallback, useEffect, useState } from 'react';
import { Icon } from './Icon';
import { postJson } from './stepup';
import { unitPath, type OrgChart } from './OrgPlacement';

/*
 * Organisation & authority: the structure (legal entities and units), who
 * may approve how much (grants and delegations), and the audit of every
 * administrative change. PRD Module 1, ORG-02 and ORG-05 to ORG-07.
 */

type Tab = 'structure' | 'authority' | 'audit';
type Grant = { id: string; actor_id: string; actor_email: string; actor_name: string; decision_type: string; amount_limit: string | null; currency: string; legal_entity_id: string | null; valid_from: string; valid_to: string | null; revoked_at: string | null };
type Delegation = { id: string; from_actor_id: string; from_name: string; from_email: string; to_actor_id: string; to_name: string; to_email: string; scope: string; amount_limit: string | null; valid_from: string; valid_to: string | null; reason: string | null; revoked_at: string | null };
type AuditRow = { id: number; action: string; target_id: string | null; detail: Record<string, unknown>; occurred_at: string; actor_email: string | null; actor_name: string | null };
type Process = { process_key: string; name: string };

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
    try { setData(await get<T>(path)); setError(null); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  }, [path]);
  useEffect(() => { void reload(); }, [reload]);
  return { data, error, reload };
}
const day = (v: string | null) => (v ? new Date(v).toLocaleDateString() : null);
const when = (v: string) => new Date(v).toLocaleString();
const money = (v: string | null, currency: string) => (v === null ? 'No limit' : `${currency} ${Number(v).toLocaleString()}`);

const ACTION_WORDS: Record<string, string> = {
  'authority.granted': 'granted approval authority',
  'authority.revoked': 'revoked approval authority',
  'delegation.created': 'delegated approval authority',
  'delegation.revoked': 'ended a delegation',
  'member.role_changed': 'changed a workspace role',
  'member.deactivated': 'deactivated a member',
  'member.reactivated': 'restored a member',
  'member.manager_changed': 'changed a manager',
  'module.enabled': 'switched a module on',
  'module.disabled': 'switched a module off',
  'workspace.settings_changed': 'changed workspace settings',
};

export function OrganisationView({ canAdminister, processes, myId }: { canAdminister: boolean; processes: Process[]; myId: string }) {
  const [tab, setTab] = useState<Tab>('structure');
  const chart = useFeed<OrgChart>('/api/org');
  const authority = useFeed<{ grants: Grant[]; delegations: Delegation[] }>('/api/authority');
  const audit = useFeed<AuditRow[]>(canAdminister ? '/api/audit?limit=200' : null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [creating, setCreating] = useState<null | 'entity' | 'unit' | 'grant' | 'delegation'>(null);

  // Forms. Kept as plain state: the page is a settings page, not a wizard.
  const [entityName, setEntityName] = useState(''); const [entityCode, setEntityCode] = useState('');
  const [unitName, setUnitName] = useState(''); const [unitParent, setUnitParent] = useState(''); const [unitEntity, setUnitEntity] = useState(''); const [unitHead, setUnitHead] = useState('');
  const [editingUnit, setEditingUnit] = useState<string | null>(null);
  const [grantActor, setGrantActor] = useState(''); const [grantType, setGrantType] = useState('*'); const [grantLimit, setGrantLimit] = useState(''); const [grantCurrency, setGrantCurrency] = useState('GBP'); const [grantEntity, setGrantEntity] = useState(''); const [grantFrom, setGrantFrom] = useState(''); const [grantTo, setGrantTo] = useState('');
  const [delFrom, setDelFrom] = useState(''); const [delTo, setDelTo] = useState(''); const [delScope, setDelScope] = useState('*'); const [delLimit, setDelLimit] = useState(''); const [delFromDate, setDelFromDate] = useState(''); const [delToDate, setDelToDate] = useState(''); const [delReason, setDelReason] = useState('');

  const act = async (id: string, work: () => Promise<string>) => {
    setBusy(id); setNote(null);
    try { setNote(await work()); }
    catch (err) { setNote(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(null); }
  };

  const people = chart.data?.people.filter((p) => p.active) ?? [];
  const units = chart.data?.units ?? [];
  const entities = chart.data?.entities ?? [];
  const liveGrants = authority.data?.grants.filter((g) => !g.revoked_at) ?? [];
  const liveDelegations = authority.data?.delegations.filter((d) => !d.revoked_at) ?? [];
  const tabs: { id: Tab; name: string; count: number; icon: 'table' | 'account' | 'trail' }[] = [
    { id: 'structure', name: 'Structure', count: units.length, icon: 'table' },
    { id: 'authority', name: 'Approval authority', count: liveGrants.length + liveDelegations.length, icon: 'account' },
    ...(canAdminister ? [{ id: 'audit' as const, name: 'Audit', count: audit.data?.length ?? 0, icon: 'trail' as const }] : []),
  ];
  const activeError = { structure: chart.error, authority: authority.error, audit: audit.error }[tab];
  const copy = {
    structure: ['Legal entities and units', 'Nest units as deep as the organisation goes. A unit cannot be moved inside itself.'],
    authority: ['Who may approve how much', 'A role lets someone take part in approvals; a grant says up to what amount. A delegate acts under the holder\'s limit, never above it.'],
    audit: ['Administrative changes', 'Every change to people, authority, modules and settings, newest first. These rows cannot be edited or deleted.'],
  }[tab];

  const unitRow = (u: OrgChart['units'][number]) => {
    const editing = editingUnit === u.id;
    return <li key={u.id} className="ig__row">
      <div className="ig__rowMain">
        <strong>{unitPath(units, u.id)}</strong>
        <p>{u.members} {u.members === 1 ? 'member' : 'members'}{u.legal_entity_id ? ` · ${entities.find((e) => e.id === u.legal_entity_id)?.name ?? 'entity'}` : ''}{u.head_actor_id ? ` · Head: ${people.find((p) => p.id === u.head_actor_id)?.display_name ?? 'member'}` : ''}</p>
        {editing && <div className="pp2__roleEdit" style={{ marginTop: 10 }}>
          <label className="pp2__inlineLabel" htmlFor={`unit-parent-${u.id}`}>Parent</label>
          <select id={`unit-parent-${u.id}`} value={unitParent} onChange={(e) => setUnitParent(e.target.value)}>
            <option value="">Top level</option>
            {units.filter((x) => x.id !== u.id).map((x) => <option key={x.id} value={x.id}>{unitPath(units, x.id)}</option>)}
          </select>
          <label className="pp2__inlineLabel" htmlFor={`unit-head-${u.id}`}>Head</label>
          <select id={`unit-head-${u.id}`} value={unitHead} onChange={(e) => setUnitHead(e.target.value)}>
            <option value="">Nobody</option>
            {people.map((p) => <option key={p.id} value={p.id}>{p.display_name}</option>)}
          </select>
          <button type="button" className="cs__btn cs__btn--primary" disabled={busy === u.id} onClick={() => void act(u.id, async () => { await postJson(`/api/org/units/${u.id}`, { parentId: unitParent || null, headActorId: unitHead || null }); setEditingUnit(null); await chart.reload(); return `${u.name} updated.`; })}>Save</button>
          <button type="button" className="cs__btn" onClick={() => setEditingUnit(null)}>Cancel</button>
        </div>}
      </div>
      {canAdminister && !editing && <button type="button" className="cs__btn" onClick={() => { setEditingUnit(u.id); setUnitParent(u.parent_id ?? ''); setUnitHead(u.head_actor_id ?? ''); }}>Move or set head</button>}
    </li>;
  };

  return <div className="ig__workspace">
    <header className="ig__hero">
      <span className="ig__eyebrow">ORGANISATION</span>
      <h2>How the organisation is put together</h2>
      <p>Entities, units, who reports to whom, and who may approve how much. Processes route by what is set here.</p>
    </header>

    <div className="ig__surface">
      <div className="ig__tabs" role="tablist" aria-label="Organisation areas">
        {tabs.map((item, index) => <button key={item.id} id={`org-tab-${item.id}`} type="button" role="tab" aria-controls={`org-panel-${item.id}`} aria-selected={tab === item.id} tabIndex={tab === item.id ? 0 : -1} className="ig__tab" onClick={() => { setTab(item.id); setCreating(null); setNote(null); }} onKeyDown={(event) => { const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index - 1 + tabs.length) % tabs.length : -1; if (next < 0) return; event.preventDefault(); const id = tabs[next]!.id; setTab(id); setCreating(null); document.getElementById(`org-tab-${id}`)?.focus(); }}>
          <Icon name={item.icon} /><span>{item.name}</span><span className="ig__tabCount">{item.count}</span>
        </button>)}
      </div>

      <section id={`org-panel-${tab}`} role="tabpanel" aria-labelledby={`org-tab-${tab}`} className="ig__panel">
        <div className="ig__panelHead"><div><h3>{copy[0]}</h3><p>{copy[1]}</p></div>
          {canAdminister && tab === 'structure' && <div className="pp2__roleEdit"><button type="button" className="cs__btn" aria-expanded={creating === 'entity'} onClick={() => setCreating((c) => c === 'entity' ? null : 'entity')}>Add legal entity</button><button type="button" className="cs__btn cs__btn--primary" aria-expanded={creating === 'unit'} onClick={() => setCreating((c) => c === 'unit' ? null : 'unit')}>Add unit</button></div>}
          {tab === 'authority' && <div className="pp2__roleEdit">{canAdminister && <button type="button" className="cs__btn cs__btn--primary" aria-expanded={creating === 'grant'} onClick={() => setCreating((c) => c === 'grant' ? null : 'grant')}>Grant authority</button>}<button type="button" className="cs__btn" aria-expanded={creating === 'delegation'} onClick={() => setCreating((c) => c === 'delegation' ? null : 'delegation')}>Delegate</button></div>}
        </div>
        {note && <p className="ig__notice" role="status">{note}</p>}
        {activeError && <p className="ig__error" role="alert">{activeError}</p>}

        {tab === 'structure' && <>
          {creating === 'entity' && <form className="ig__form" onSubmit={(e) => { e.preventDefault(); void act('entity', async () => { await postJson('/api/org/entities', { name: entityName, code: entityCode }); setEntityName(''); setEntityCode(''); setCreating(null); await chart.reload(); return 'Legal entity added.'; }); }}>
            <div className="ig__formTitle"><strong>Add a legal entity</strong><p>A company or registered body people and units belong to.</p></div>
            <div><label className="cs__label" htmlFor="entity-name">Name</label><input id="entity-name" className="cs__input" required value={entityName} onChange={(e) => setEntityName(e.target.value)} /></div>
            <div><label className="cs__label" htmlFor="entity-code">Code (optional)</label><input id="entity-code" className="cs__input" value={entityCode} maxLength={40} onChange={(e) => setEntityCode(e.target.value)} /></div>
            <button type="submit" className="cs__btn cs__btn--primary" disabled={busy === 'entity'}>Add entity</button>
          </form>}
          {creating === 'unit' && <form className="ig__form" onSubmit={(e) => { e.preventDefault(); void act('unit', async () => { await postJson('/api/org/units', { name: unitName, parentId: unitParent || null, legalEntityId: unitEntity || null, headActorId: unitHead || null }); setUnitName(''); setCreating(null); await chart.reload(); return 'Unit added.'; }); }}>
            <div className="ig__formTitle"><strong>Add a unit</strong><p>A department, team, branch or division. Put it under a parent to nest it.</p></div>
            <div><label className="cs__label" htmlFor="unit-name">Name</label><input id="unit-name" className="cs__input" required value={unitName} onChange={(e) => setUnitName(e.target.value)} /></div>
            <div><label className="cs__label" htmlFor="unit-parent">Parent unit</label><select id="unit-parent" className="cs__input" value={unitParent} onChange={(e) => setUnitParent(e.target.value)}><option value="">Top level</option>{units.map((u) => <option key={u.id} value={u.id}>{unitPath(units, u.id)}</option>)}</select></div>
            <div><label className="cs__label" htmlFor="unit-entity">Legal entity</label><select id="unit-entity" className="cs__input" value={unitEntity} onChange={(e) => setUnitEntity(e.target.value)}><option value="">None</option>{entities.map((en) => <option key={en.id} value={en.id}>{en.name}</option>)}</select></div>
            <div><label className="cs__label" htmlFor="unit-head">Head of unit</label><select id="unit-head" className="cs__input" value={unitHead} onChange={(e) => setUnitHead(e.target.value)}><option value="">Nobody yet</option>{people.map((p) => <option key={p.id} value={p.id}>{p.display_name}</option>)}</select></div>
            <button type="submit" className="cs__btn cs__btn--primary" disabled={busy === 'unit'}>Add unit</button>
          </form>}
          {entities.length > 0 && <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>{entities.map((en) => <li key={en.id} className="ig__row"><div className="ig__rowMain"><strong>{en.name}</strong><span className="ig__status">Legal entity</span><p>{en.code ? `Code ${en.code} · ` : ''}{units.filter((u) => u.legal_entity_id === en.id).length} units</p></div></li>)}</ul>}
          {units.length > 0 ? <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>{[...units].sort((a, b) => unitPath(units, a.id).localeCompare(unitPath(units, b.id))).map(unitRow)}</ul>
            : chart.data && <p className="ig__rowMain" style={{ padding: '0 28px 24px' }}>No units yet. Add the first department or branch, then place people in it from their profile.</p>}
        </>}

        {tab === 'authority' && <>
          {creating === 'grant' && canAdminister && <form className="ig__form" onSubmit={(e) => { e.preventDefault(); void act('grant', async () => { await postJson('/api/authority/grants', { actorId: grantActor, decisionType: grantType, amountLimit: grantLimit || null, currency: grantCurrency, legalEntityId: grantEntity || null, validFrom: grantFrom || undefined, validTo: grantTo || undefined }); setGrantLimit(''); setCreating(null); await authority.reload(); await audit.reload(); return 'Authority granted.'; }); }}>
            <div className="ig__formTitle"><strong>Grant approval authority</strong><p>You cannot grant to yourself. Leave the limit empty for no limit.</p></div>
            <div><label className="cs__label" htmlFor="grant-actor">Person</label><select id="grant-actor" className="cs__input" required value={grantActor} onChange={(e) => setGrantActor(e.target.value)}><option value="">Choose…</option>{people.filter((p) => p.id !== myId).map((p) => <option key={p.id} value={p.id}>{p.display_name} ({p.email})</option>)}</select></div>
            <div><label className="cs__label" htmlFor="grant-type">For</label><select id="grant-type" className="cs__input" value={grantType} onChange={(e) => setGrantType(e.target.value)}><option value="*">Every process</option>{processes.map((p) => <option key={p.process_key} value={p.process_key}>{p.name}</option>)}</select></div>
            <div><label className="cs__label" htmlFor="grant-limit">Limit per approval</label><input id="grant-limit" className="cs__input" inputMode="decimal" placeholder="No limit" value={grantLimit} onChange={(e) => setGrantLimit(e.target.value)} /></div>
            <div><label className="cs__label" htmlFor="grant-currency">Currency</label><input id="grant-currency" className="cs__input" maxLength={3} value={grantCurrency} onChange={(e) => setGrantCurrency(e.target.value.toUpperCase())} /></div>
            <div><label className="cs__label" htmlFor="grant-entity">Legal entity</label><select id="grant-entity" className="cs__input" value={grantEntity} onChange={(e) => setGrantEntity(e.target.value)}><option value="">Any</option>{entities.map((en) => <option key={en.id} value={en.id}>{en.name}</option>)}</select></div>
            <div><label className="cs__label" htmlFor="grant-from">Valid from</label><input id="grant-from" type="date" className="cs__input" value={grantFrom} onChange={(e) => setGrantFrom(e.target.value)} /></div>
            <div><label className="cs__label" htmlFor="grant-to">Valid to</label><input id="grant-to" type="date" className="cs__input" value={grantTo} onChange={(e) => setGrantTo(e.target.value)} /></div>
            <button type="submit" className="cs__btn cs__btn--primary" disabled={busy === 'grant'}>Grant</button>
          </form>}
          {creating === 'delegation' && <form className="ig__form" onSubmit={(e) => { e.preventDefault(); void act('delegation', async () => { await postJson('/api/authority/delegations', { fromActorId: delFrom || myId, toActorId: delTo, scope: delScope, amountLimit: delLimit || null, validFrom: delFromDate || undefined, validTo: delToDate || undefined, reason: delReason }); setDelTo(''); setDelReason(''); setCreating(null); await authority.reload(); await audit.reload(); return 'Delegation created.'; }); }}>
            <div className="ig__formTitle"><strong>Delegate approval authority</strong><p>The delegate acts under the holder&rsquo;s limit, or a lower cap. Ends automatically on the end date.</p></div>
            {canAdminister && <div><label className="cs__label" htmlFor="del-from">Holder</label><select id="del-from" className="cs__input" value={delFrom} onChange={(e) => setDelFrom(e.target.value)}><option value="">Me</option>{people.filter((p) => p.id !== myId).map((p) => <option key={p.id} value={p.id}>{p.display_name}</option>)}</select></div>}
            <div><label className="cs__label" htmlFor="del-to">Delegate</label><select id="del-to" className="cs__input" required value={delTo} onChange={(e) => setDelTo(e.target.value)}><option value="">Choose…</option>{people.filter((p) => p.id !== (delFrom || myId)).map((p) => <option key={p.id} value={p.id}>{p.display_name} ({p.email})</option>)}</select></div>
            <div><label className="cs__label" htmlFor="del-scope">For</label><select id="del-scope" className="cs__input" value={delScope} onChange={(e) => setDelScope(e.target.value)}><option value="*">Every process</option>{processes.map((p) => <option key={p.process_key} value={p.process_key}>{p.name}</option>)}</select></div>
            <div><label className="cs__label" htmlFor="del-limit">Cap (optional)</label><input id="del-limit" className="cs__input" inputMode="decimal" placeholder="Holder's limit" value={delLimit} onChange={(e) => setDelLimit(e.target.value)} /></div>
            <div><label className="cs__label" htmlFor="del-from-date">From</label><input id="del-from-date" type="date" className="cs__input" value={delFromDate} onChange={(e) => setDelFromDate(e.target.value)} /></div>
            <div><label className="cs__label" htmlFor="del-to-date">To</label><input id="del-to-date" type="date" className="cs__input" value={delToDate} onChange={(e) => setDelToDate(e.target.value)} /></div>
            <div><label className="cs__label" htmlFor="del-reason">Reason (optional)</label><input id="del-reason" className="cs__input" maxLength={500} value={delReason} onChange={(e) => setDelReason(e.target.value)} /></div>
            <button type="submit" className="cs__btn cs__btn--primary" disabled={busy === 'delegation'}>Delegate</button>
          </form>}
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {liveGrants.map((g) => <li key={g.id} className="ig__row"><div className="ig__rowMain"><strong>{g.actor_name}</strong><span className="ig__status">Grant</span><p>{money(g.amount_limit, g.currency)} · {g.decision_type === '*' ? 'every process' : processes.find((p) => p.process_key === g.decision_type)?.name ?? g.decision_type}{g.legal_entity_id ? ` · ${entities.find((en) => en.id === g.legal_entity_id)?.name ?? 'entity'}` : ''} · from {day(g.valid_from)}{g.valid_to ? ` to ${day(g.valid_to)}` : ''}</p></div>{canAdminister && <button type="button" className="cs__btn" disabled={busy === g.id} onClick={() => void act(g.id, async () => { await postJson(`/api/authority/grants/${g.id}/revoke`, {}); await authority.reload(); await audit.reload(); return `${g.actor_name}'s grant is revoked.`; })}>Revoke</button>}</li>)}
            {liveDelegations.map((d) => <li key={d.id} className="ig__row"><div className="ig__rowMain"><strong>{d.from_name} → {d.to_name}</strong><span className="ig__status ig__status--off">Delegation</span><p>{d.scope === '*' ? 'every process' : processes.find((p) => p.process_key === d.scope)?.name ?? d.scope}{d.amount_limit !== null ? ` · capped at ${Number(d.amount_limit).toLocaleString()}` : ''} · from {day(d.valid_from)}{d.valid_to ? ` to ${day(d.valid_to)}` : ''}{d.reason ? ` · ${d.reason}` : ''}</p></div>{(canAdminister || d.from_actor_id === myId) && <button type="button" className="cs__btn" disabled={busy === d.id} onClick={() => void act(d.id, async () => { await postJson(`/api/authority/delegations/${d.id}/revoke`, {}); await authority.reload(); await audit.reload(); return 'Delegation ended.'; })}>End</button>}</li>)}
          </ul>
          {authority.data && !liveGrants.length && !liveDelegations.length && <p className="ig__rowMain" style={{ padding: '0 28px 24px' }}>Nobody holds approval authority yet. Approvals that check a limit will escalate or wait until someone does.</p>}
        </>}

        {tab === 'audit' && canAdminister && <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {(audit.data ?? []).map((r) => <li key={r.id} className="ig__row"><div className="ig__rowMain"><strong>{r.actor_name ?? 'System'} {ACTION_WORDS[r.action] ?? r.action}</strong><p>{when(r.occurred_at)} · {Object.entries(r.detail).filter(([, v]) => v !== null && v !== undefined && typeof v !== 'object').map(([k, v]) => `${k}: ${String(v)}`).join(' · ') || r.action}</p></div></li>)}
          {audit.data && !audit.data.length && <li className="ig__row"><div className="ig__rowMain"><p>No administrative changes recorded yet.</p></div></li>}
        </ul>}
      </section>
    </div>
  </div>;
}
