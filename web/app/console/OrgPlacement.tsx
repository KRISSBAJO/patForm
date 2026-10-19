'use client';

import { useCallback, useEffect, useState } from 'react';
import { postJson } from './stepup';

/*
 * Where a member sits in the organisation: their manager (a dated reporting
 * line), unit, legal entity and title. Shown on the member profile. Every
 * change goes through the directory routes, which check loops and tenancy;
 * the refusal they return is shown next to the control that caused it.
 */

export type OrgChart = {
  entities: { id: string; name: string; code: string | null }[];
  units: { id: string; name: string; parent_id: string | null; legal_entity_id: string | null; head_actor_id: string | null; members: number }[];
  people: { id: string; email: string; display_name: string; active: boolean; org_unit_id: string | null; legal_entity_id: string | null; position_title: string | null; manager: { id: string; email: string; name: string } | null }[];
};
type Line = { id: string; manager_id: string; manager_email: string; manager_name: string; kind: string; effective_from: string; effective_to: string | null };

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path, { credentials: 'same-origin' });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.reason ?? body.error ?? `HTTP ${res.status}`);
  return body as T;
}

/** "Operations › Lagos › Fleet", so two units with the same name read differently. */
export function unitPath(units: OrgChart['units'], id: string | null): string {
  const names: string[] = [];
  let current = id;
  const seen = new Set<string>();
  while (current && !seen.has(current)) {
    seen.add(current);
    const u = units.find((x) => x.id === current);
    if (!u) break;
    names.unshift(u.name);
    current = u.parent_id;
  }
  return names.join(' › ');
}

function day(value: string | null) { return value ? new Date(value).toLocaleDateString() : null; }

export function PlacementSection({ memberId, canAdminister, onChanged }: { memberId: string; canAdminister: boolean; onChanged: () => void }) {
  const [chart, setChart] = useState<OrgChart | null>(null);
  const [history, setHistory] = useState<Line[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [problem, setProblem] = useState<{ at: 'manager' | 'placement'; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [managerId, setManagerId] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState('');
  const [unitId, setUnitId] = useState('');
  const [entityId, setEntityId] = useState('');
  const [title, setTitle] = useState('');

  const load = useCallback(async () => {
    try {
      const [c, h] = await Promise.all([get<OrgChart>('/api/org'), get<Line[]>(`/api/members/${memberId}/reporting`)]);
      setChart(c); setHistory(h); setError(null);
      const me = c.people.find((p) => p.id === memberId);
      setManagerId(me?.manager?.id ?? '');
      setUnitId(me?.org_unit_id ?? '');
      setEntityId(me?.legal_entity_id ?? '');
      setTitle(me?.position_title ?? '');
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  }, [memberId]);
  useEffect(() => { void load(); }, [load]);

  if (error) return <div className="pp2__detailSection pp2__detailSection--wide"><h4>Place in the organisation</h4><p className="pp2__problem" role="alert">{error}</p></div>;
  if (!chart) return <div className="pp2__detailSection pp2__detailSection--wide"><h4>Place in the organisation</h4><p>Loading…</p></div>;

  const me = chart.people.find((p) => p.id === memberId);
  const candidates = chart.people.filter((p) => p.active && p.id !== memberId);
  const managerDirty = managerId !== (me?.manager?.id ?? '');
  const placementDirty = unitId !== (me?.org_unit_id ?? '') || entityId !== (me?.legal_entity_id ?? '') || title !== (me?.position_title ?? '');

  const saveManager = async () => {
    setBusy('manager'); setProblem(null);
    try {
      await postJson(`/api/members/${memberId}/manager`, { managerId: managerId || null, ...(effectiveFrom ? { effectiveFrom } : {}) });
      await load(); onChanged();
    } catch (err) { setProblem({ at: 'manager', text: err instanceof Error ? err.message : String(err) }); }
    finally { setBusy(null); }
  };
  const savePlacement = async () => {
    setBusy('placement'); setProblem(null);
    try {
      await postJson(`/api/members/${memberId}/placement`, { unitId: unitId || null, legalEntityId: entityId || null, positionTitle: title || null });
      await load(); onChanged();
    } catch (err) { setProblem({ at: 'placement', text: err instanceof Error ? err.message : String(err) }); }
    finally { setBusy(null); }
  };

  return (
    <div className="pp2__detailSection pp2__detailSection--wide">
      <h4>Place in the organisation</h4>
      <p>Who they report to, where they sit, and what they do. Approvals addressed to &ldquo;the submitter&rsquo;s manager&rdquo; use the manager set here.</p>
      <div className="pp2__placement">
        <div>
          <label htmlFor="pp2-manager">Manager</label>
          {canAdminister ? <div className="pp2__roleEdit">
            <select id="pp2-manager" value={managerId} disabled={busy === 'manager'} onChange={(e) => setManagerId(e.target.value)}>
              <option value="">No manager</option>
              {candidates.map((p) => <option key={p.id} value={p.id}>{p.display_name} ({p.email})</option>)}
            </select>
            <label className="pp2__inlineLabel" htmlFor="pp2-manager-from">From</label>
            <input id="pp2-manager-from" type="date" className="cs__input pp2__date" value={effectiveFrom} disabled={busy === 'manager'} onChange={(e) => setEffectiveFrom(e.target.value)} />
            <button type="button" className="cs__btn cs__btn--primary" disabled={!managerDirty || busy === 'manager'} onClick={() => void saveManager()}>{busy === 'manager' ? 'Saving…' : 'Set manager'}</button>
          </div> : <div className="pp2__value">{me?.manager ? `${me.manager.name} (${me.manager.email})` : 'No manager on file'}</div>}
          {problem?.at === 'manager' && <p className="pp2__problem" role="alert">{problem.text}</p>}
          {history.length > 0 && <details className="pp2__history">
            <summary>Reporting history ({history.length})</summary>
            <ul>
              {history.map((l) => <li key={l.id}>{l.manager_name} · from {day(l.effective_from)}{l.effective_to ? ` to ${day(l.effective_to)}` : ' (current)'}</li>)}
            </ul>
          </details>}
        </div>
        <div>
          <label htmlFor="pp2-unit">Unit</label>
          {canAdminister ? <select id="pp2-unit" className="pp2__select" value={unitId} disabled={busy === 'placement'} onChange={(e) => setUnitId(e.target.value)}>
            <option value="">No unit</option>
            {chart.units.map((u) => <option key={u.id} value={u.id}>{unitPath(chart.units, u.id)}</option>)}
          </select> : <div className="pp2__value">{unitPath(chart.units, me?.org_unit_id ?? null) || 'No unit'}</div>}
          <label htmlFor="pp2-entity">Legal entity</label>
          {canAdminister ? <select id="pp2-entity" className="pp2__select" value={entityId} disabled={busy === 'placement'} onChange={(e) => setEntityId(e.target.value)}>
            <option value="">No entity</option>
            {chart.entities.map((en) => <option key={en.id} value={en.id}>{en.name}{en.code ? ` (${en.code})` : ''}</option>)}
          </select> : <div className="pp2__value">{chart.entities.find((en) => en.id === me?.legal_entity_id)?.name ?? 'No entity'}</div>}
          <label htmlFor="pp2-title">Position title</label>
          {canAdminister ? <input id="pp2-title" className="cs__input" value={title} maxLength={120} disabled={busy === 'placement'} onChange={(e) => setTitle(e.target.value)} /> : <div className="pp2__value">{me?.position_title || 'No title'}</div>}
          {canAdminister && <button type="button" className="cs__btn cs__btn--primary" style={{ marginTop: 12 }} disabled={!placementDirty || busy === 'placement'} onClick={() => void savePlacement()}>{busy === 'placement' ? 'Saving…' : 'Save placement'}</button>}
          {problem?.at === 'placement' && <p className="pp2__problem" role="alert">{problem.text}</p>}
        </div>
      </div>
    </div>
  );
}
