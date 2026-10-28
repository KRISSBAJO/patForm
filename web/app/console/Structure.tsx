'use client';

import './meetings.css';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { EmptyState } from './module-shell';
import { postJson } from './stepup';
import { Choice, COUNTRIES, F, Sheet, SheetSection } from './sheet';

/*
 * Structure & offices. The tiers of the organisation (for a church:
 * National, District, Zone, Area, Station), the offices at each, and who
 * holds them now and before. Everyone sees the tree; what each person may
 * change depends on the offices they hold and how far down they reach.
 * Holders change all the time: replacing or ending an appointment is one
 * click, the history stays, and anything waiting for the office moves to
 * whoever holds it next.
 */

type Level = { id: string; key: string; name: string; rank: number; is_station: boolean };
type OfficeType = { id: string; key: string; name: string; level_id: string | null; kind: string; single: boolean; permissions: string[]; active: boolean; sort: number };
type Catalog = { id: string; key: string; name: string; active: boolean; sort: number };
type Unit = { id: string; name: string; parent_id: string | null; level_id: string | null; host_station_id: string | null; country: string | null; code: string | null; active: boolean; members: number; holders: number; vacant: string[]; overseer: { name: string; acting: boolean } | null };
type MyOffice = { id: string; unit_id: string; unit: string; office: string; kind: string; acting: boolean; starts_on: string; mandate_limit: string | null; permissions: string[] };
type Structure = { levels: Level[]; officeTypes: OfficeType[]; catalog: Catalog[]; units: Unit[]; committees: { id: string; name: string; org_unit_id: string | null; structure_key: string | null }[]; me: { workspaceAdmin: boolean; scopes: { unitId: string; permissions: string[] }[]; offices: MyOffice[] }; permissions: string[] };
type Holder = { id: string; office_type_id: string; department_id: string | null; actor_id: string; name: string; email: string; acting: boolean; starts_on: string; ends_on: string | null; mandate_limit: string | null; end_reason: string | null; appointed_by: string | null; live: boolean };
type Detail = {
  unit: Unit; chain: { id: string; name: string; level_id: string | null }[]; host: Unit | null; hosts: { id: string; name: string; level_id: string | null }[];
  holders: Holder[]; departments: { id: string; catalog_id: string; name: string; key: string; active: boolean }[];
  members: { id: string; display_name: string; email: string; workspace_role: string; position_title: string | null }[]; children: number;
  committees: { id: string; name: string; structure_key: string | null }[]; can: Record<'people' | 'appointments' | 'structure' | 'reports', boolean>;
};
type Person = { id: string; display_name: string; email: string; unit: string | null };

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path, { credentials: 'same-origin' });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.reason ?? body.error ?? `HTTP ${res.status}`);
  return body as T;
}
function useFeed<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => { if (!path) { setData(null); return; } try { setData(await get<T>(path)); setError(null); } catch (err) { setError(err instanceof Error ? err.message : String(err)); } }, [path]);
  useEffect(() => { void reload(); }, [reload]);
  return { data, error, reload };
}
const initials = (n: string) => n.split(/\s+/).filter(Boolean).slice(0, 2).map((x) => x[0]!.toUpperCase()).join('');
const day = (v: string | null) => (v ? new Date(`${v}T00:00:00`).toLocaleDateString([], { dateStyle: 'medium' }) : '');
const Pill = ({ s, text }: { s: string; text: string }) => <span className={`mx__pill mx__pill--${s}`}><i />{text}</span>;
const PERM_LABEL: Record<string, string> = { people: 'Add and place people', appointments: 'Appoint and end offices', structure: 'Shape the structure', reports: 'See reports' };
const KIND_LABEL: Record<string, string> = { overseer: 'Head (pastor)', assistant: 'Assistant', admin: 'Administrator', secretary: 'Secretary', unit_head: 'Unit head', officer: 'Officer' };
const END_REASONS: [string, string][] = [['transferred', 'Transferred'], ['retired', 'Retired'], ['resigned', 'Resigned'], ['deceased', 'Called to glory'], ['ended', 'Term ended']];

/** Search members and pick one. */
function PersonPicker({ value, onPick }: { value: Person | null; onPick: (p: Person | null) => void }) {
  const [q, setQ] = useState('');
  const [list, setList] = useState<Person[]>([]);
  useEffect(() => {
    if (value) return;
    const t = setTimeout(() => { void get<Person[]>(`/api/structure/people?q=${encodeURIComponent(q)}`).then(setList).catch(() => setList([])); }, 200);
    return () => clearTimeout(t);
  }, [q, value]);
  if (value) return <div className="st__picked"><span className="mx__avatar" style={{ marginLeft: 0 }}>{initials(value.display_name)}</span><div><strong>{value.display_name}</strong><small>{value.email}{value.unit ? ` · ${value.unit}` : ''}</small></div><button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => onPick(null)}>Change</button></div>;
  return <div className="st__picker">
    <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name or email" />
    <ul>{list.map((p) => <li key={p.id}><button type="button" onClick={() => onPick(p)}><span className="mx__avatar" style={{ marginLeft: 0 }}>{initials(p.display_name)}</span><span><strong>{p.display_name}</strong><small>{p.email}{p.unit ? ` · ${p.unit}` : ''}</small></span></button></li>)}
      {!list.length && <li className="st__none">Nobody matches. Invite them instead.</li>}</ul>
  </div>;
}

export function StructureView({ canAdminister }: { canAdminister: boolean }) {
  const s = useFeed<Structure>('/api/structure');
  const [tab, setTab] = useState<'tree' | 'vacant' | 'mine' | 'settings'>('tree');
  const [selected, setSelected] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [q, setQ] = useState('');
  const [note, setNote] = useState<{ text: string; err?: boolean } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [setup, setSetup] = useState<{ adopt: boolean } | null>(null);
  const [unitSheet, setUnitSheet] = useState<{ id?: string; parentId: string | null; name: string; levelId: string; country: string; code: string; hostStationId: string; active: boolean } | null>(null);
  const [appointSheet, setAppointSheet] = useState<{ officeTypeId: string; person: Person | null; departmentId: string; acting: boolean; startsOn: string; endsOn: string; mandate: string; replace: boolean; occupiedBy: string | null } | null>(null);
  const [endSheet, setEndSheet] = useState<{ holder: Holder; reason: string; endsOn: string } | null>(null);
  const [inviteSheet, setInviteSheet] = useState<{ email: string; role: string; officeTypeId: string } | null>(null);
  const [placeSheet, setPlaceSheet] = useState<{ person: Person | null } | null>(null);
  const [deptSheet, setDeptSheet] = useState<Set<string> | null>(null);
  const [committeeSheet, setCommitteeSheet] = useState<{ bodyId: string; key: string } | null>(null);
  const [levelSheet, setLevelSheet] = useState<{ id?: string; name: string; rank: string; isStation: boolean } | null>(null);
  const [officeSheet, setOfficeSheet] = useState<{ id?: string; name: string; levelId: string; kind: string; single: boolean; permissions: string[]; active: boolean; sort: string } | null>(null);
  const [catalogSheet, setCatalogSheet] = useState<{ id?: string; name: string; active: boolean; sort: string } | null>(null);
  const [showPast, setShowPast] = useState(false);
  const detail = useFeed<Detail>(selected ? `/api/structure/units/${selected}` : null);

  const data = s.data;
  const levels = useMemo(() => new Map((data?.levels ?? []).map((l) => [l.id, l])), [data]);
  const units = useMemo(() => data?.units ?? [], [data]);
  const byId = useMemo(() => new Map(units.map((u) => [u.id, u])), [units]);
  const kids = useMemo(() => { const m = new Map<string | null, Unit[]>(); for (const u of units) { const k = u.parent_id && byId.has(u.parent_id) ? u.parent_id : null; m.set(k, [...(m.get(k) ?? []), u]); } return m; }, [units, byId]);
  const types = useMemo(() => (data?.officeTypes ?? []).filter((t) => t.active), [data]);
  const isStation = (u: { level_id: string | null } | undefined) => !!u?.level_id && !!levels.get(u.level_id)?.is_station;
  const lvName = (id: string | null) => (id ? levels.get(id)?.name ?? '' : '');
  const stations = units.filter((u) => isStation(u)).length;
  const vacantTotal = units.reduce((n, u) => n + u.vacant.length, 0);

  // Open the top two tiers the first time, and select the first unit.
  useEffect(() => {
    if (!data || open.size) return;
    const top = (kids.get(null) ?? []);
    setOpen(new Set([...top.map((u) => u.id), ...top.flatMap((u) => (kids.get(u.id) ?? []).map((k) => k.id))]));
    if (!selected && top[0]) setSelected(top[0].id);
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  const act = async (id: string, work: () => Promise<string>) => {
    setBusy(id); setNote(null);
    try { setNote({ text: await work() }); await Promise.all([s.reload(), detail.reload()]); }
    catch (err) { setNote({ text: err instanceof Error ? err.message : String(err), err: true }); }
    finally { setBusy(null); }
  };
  const reveal = (id: string) => { const next = new Set(open); let at = byId.get(id); while (at?.parent_id) { next.add(at.parent_id); at = byId.get(at.parent_id); } setOpen(next); setSelected(id); setTab('tree'); };

  const matches = q.trim() ? units.filter((u) => `${u.name} ${u.code ?? ''}`.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 60) : null;
  const row = (u: Unit, depth: number): React.ReactNode => {
    const children = kids.get(u.id) ?? [];
    const isOpen = open.has(u.id);
    return <div key={u.id}>
      <div className={`st__row ${selected === u.id ? 'is-on' : ''} ${u.active ? '' : 'is-off'}`} style={{ paddingLeft: 10 + depth * 16 }}>
        {children.length ? <button type="button" className="st__caret" aria-label={isOpen ? 'Collapse' : 'Expand'} onClick={() => { const n = new Set(open); if (isOpen) n.delete(u.id); else n.add(u.id); setOpen(n); }}>{isOpen ? '▾' : '▸'}</button> : <span className="st__caret" />}
        <button type="button" className="st__name" onClick={() => setSelected(u.id)}>
          <span className={`st__dot ${isStation(u) ? 'st__dot--station' : ''}`} />
          <span className="st__label">{u.name}</span>
          <span className="st__lv">{lvName(u.level_id)}</span>
          {u.vacant.length > 0 && <span className="st__gap" title={`${u.vacant.length} office${u.vacant.length === 1 ? '' : 's'} vacant`}>{u.vacant.length}</span>}
        </button>
      </div>
      {isOpen && children.map((c) => row(c, depth + 1))}
    </div>;
  };

  if (s.error) return <div className="mx"><p className="mx__notice mx__notice--err">{s.error}</p></div>;
  if (!data) return <div className="mx"><p className="mx__tiny">Loading the structure…</p></div>;

  const d = detail.data;
  const unit = d?.unit;
  const unitLevel = unit?.level_id ? levels.get(unit.level_id) : undefined;
  const seats = unit ? types.filter((t) => t.level_id ? t.level_id === unit.level_id : true) : [];
  const live = (d?.holders ?? []).filter((h) => h.live);
  const past = (d?.holders ?? []).filter((h) => !h.live);
  const childLevels = (parentLevel: Level | undefined) => data.levels.filter((l) => !parentLevel || l.rank > parentLevel.rank);
  const openUnitSheet = (parentId: string | null, existing?: Unit) => {
    const pl = parentId ? levels.get(byId.get(parentId)?.level_id ?? '') : undefined;
    const next = childLevels(pl).filter((l) => !l.is_station)[0] ?? childLevels(pl)[0];
    setUnitSheet(existing
      ? { id: existing.id, parentId: existing.parent_id, name: existing.name, levelId: existing.level_id ?? '', country: existing.country ?? '', code: existing.code ?? '', hostStationId: existing.host_station_id ?? '', active: existing.active }
      : { parentId, name: '', levelId: next?.id ?? '', country: byId.get(parentId ?? '')?.country ?? '', code: '', hostStationId: '', active: true });
  };
  const stationsUnder = (id: string) => units.filter((u) => isStation(u) && (() => { let at: Unit | undefined = u; while (at) { if (at.id === id) return true; at = at.parent_id ? byId.get(at.parent_id) : undefined; } return false; })());

  // ---------------------------------------------------------- first run
  if (!data.levels.length) return <div className="mx st">
    <section className="mx__band"><div className="mx__bandGrid"><div>
      <div className="mx__eyebrow">Structure & offices</div>
      <h2 className="mx__bandTitle">Set up your church structure</h2>
      <p className="mx__bandSub">Levels from National to Station, the offices at each, and who holds them.</p>
      <div className="mx__bandActions">{canAdminister ? <button type="button" className="mx__btn mx__btn--light" onClick={() => setSetup({ adopt: true })}>Set up church structure</button> : <span className="mx__tiny" style={{ color: '#fff' }}>An owner or admin sets this up.</span>}</div>
    </div></div></section>
    {note && <p className={`mx__notice ${note.err ? 'mx__notice--err' : ''}`} style={{ marginTop: 16 }}>{note.text}</p>}
    {setup && <Sheet eyebrow="Structure" title="Set up church structure" subtitle="You can rename levels, add offices and change the unit catalogue afterwards." onClose={() => setSetup(null)}
      footer={<><button type="button" className="mx__btn mx__btn--ghost" onClick={() => setSetup(null)}>Cancel</button><button type="button" className="mx__btn" disabled={busy === 'setup'} onClick={() => void act('setup', async () => { const r = await postJson<{ adopted: string[] }>('/api/structure/setup', { adoptPolicy: setup.adopt }); setSetup(null); return r.adopted.length ? `Structure ready. The church approval line is now the default for ${r.adopted.length} process${r.adopted.length === 1 ? '' : 'es'}.` : 'Structure ready. Add your National office first.'; })}>Set up</button></>}>
      <SheetSection title="Levels"><ol className="st__steps">{['National', 'District', 'Zone', 'Area', 'Station (the local church)'].map((x) => <li key={x}>{x}</li>)}</ol></SheetSection>
      <SheetSection title="Offices"><p className="mx__tiny st__wide">A pastor and an admin at every level. Each station also has Associate Pastors, a Church Administrator, a CMC Secretary and unit heads.</p></SheetSection>
      <SheetSection title="Approvals"><F label="Default approval line" wide><Choice value={setup.adopt ? 'yes' : 'no'} onChange={(v) => setSetup({ adopt: v === 'yes' })} options={[['yes', 'Resident Pastor, then up the line by amount'], ['no', 'Not now']]} /></F></SheetSection>
    </Sheet>}
  </div>;

  // ------------------------------------------------------------- the page
  return <div className="mx st">
    <section className="mx__band"><div className="mx__bandGrid">
      <div>
        <div className="mx__eyebrow">Structure & offices</div>
        <h2 className="mx__bandTitle">{vacantTotal ? `${vacantTotal} office${vacantTotal === 1 ? '' : 's'} to fill` : 'Every office is filled'}</h2>
        <p className="mx__bandSub">Holders change any time. History stays, and pending approvals follow the office.</p>
        <div className="mx__bandActions">
          {canAdminister && <button type="button" className="mx__btn mx__btn--light" onClick={() => openUnitSheet(null)}>+ Top-level unit</button>}
          <button type="button" className="mx__btn mx__btn--outline" onClick={() => setTab('vacant')}>Vacancies</button>
        </div>
      </div>
      <div className="mx__kpi"><span>Stations</span><strong>{stations}</strong><small>{units.length - stations} jurisdictions</small></div>
      <div className={`mx__kpi ${vacantTotal ? 'mx__kpi--live' : ''}`}><span>Vacant</span><strong>{vacantTotal}</strong><small>head and single offices</small></div>
      <div className="mx__kpi"><span>Your offices</span><strong>{data.me.offices.length}</strong><small>{data.me.workspaceAdmin ? 'workspace admin' : data.me.scopes.length ? 'with admin rights' : 'view only'}</small></div>
    </div></section>

    {note && <p className={`mx__notice ${note.err ? 'mx__notice--err' : ''}`} style={{ marginTop: 16 }} role="status">{note.text}</p>}
    <div className="mx__segs" style={{ marginTop: 16 }}>{([['tree', 'Structure'], ['vacant', 'Vacancies'], ['mine', 'My offices'], ...(canAdminister ? [['settings', 'Levels & offices']] : [])] as [typeof tab, string][]).map(([k, l]) => <button key={k} type="button" className={`mx__seg ${tab === k ? 'is-on' : ''}`} onClick={() => setTab(k)}>{l}</button>)}</div>

    {tab === 'tree' && <div className="st__grid">
      <div className="mx__card st__treeCard">
        <div className="st__search"><input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${units.length.toLocaleString()} units`} /></div>
        <div className="st__tree">
          {matches ? matches.map((u) => <button key={u.id} type="button" className={`st__hit ${selected === u.id ? 'is-on' : ''}`} onClick={() => reveal(u.id)}><span className={`st__dot ${isStation(u) ? 'st__dot--station' : ''}`} /><span className="st__label">{u.name}</span><span className="st__lv">{lvName(u.level_id)}</span></button>)
            : (kids.get(null) ?? []).map((u) => row(u, 0))}
          {matches && !matches.length && <p className="mx__tiny" style={{ padding: 12 }}>No unit matches.</p>}
          {!units.length && <EmptyState icon="people" title="No units yet" text="Start with your National office, then add Districts, Zones, Areas and Stations under it." action={canAdminister ? { label: 'Add the National office', onClick: () => openUnitSheet(null) } : undefined} />}
        </div>
      </div>

      <div className="mx__stack">
        {!d && selected && <div className="mx__card"><div className="mx__cardBody"><p className="mx__tiny">Loading…</p></div></div>}
        {d && unit && <>
          <div className="mx__card">
            <div className="mx__cardBody">
              <div className="st__crumbs">{[...d.chain].reverse().slice(0, -1).map((c) => <button key={c.id} type="button" onClick={() => reveal(c.id)}>{c.name}</button>)}</div>
              <div className="st__head">
                <div>
                  <h3>{unit.name} {!unit.active && <Pill s="cancelled" text="Inactive" />}</h3>
                  <small>{unitLevel?.name ?? 'Unit'}{unit.code ? ` · ${unit.code}` : ''}{unit.country ? ` · ${COUNTRIES.find(([c]) => c === unit.country)?.[1] ?? unit.country}` : ''}{d.host ? ` · office hosted at ${d.host.name}` : ''}{d.hosts.length ? ` · hosts the ${d.hosts.map((h) => h.name).join(', ')} office` : ''} · {d.members.length} member{d.members.length === 1 ? '' : 's'}{d.children ? ` · ${d.children} under it` : ''}</small>
                </div>
                <div className="mx__bar">
                  {d.can.people && <button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => setInviteSheet({ email: '', role: 'read_only', officeTypeId: '' })}>Invite</button>}
                  {d.can.structure && <button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => openUnitSheet(unit.parent_id, byId.get(unit.id))}>Edit</button>}
                  {d.can.structure && !unitLevel?.is_station && <button type="button" className="mx__btn mx__btn--sm" onClick={() => openUnitSheet(unit.id)}>+ Under {unit.name}</button>}
                </div>
              </div>
            </div>
          </div>

          <div className="mx__card">
            <div className="mx__cardHead"><h3>Offices</h3><small>{live.length} held now</small></div>
            <ul className="mx__list">{seats.filter((t) => t.kind !== 'unit_head').map((t) => {
              const hs = live.filter((h) => h.office_type_id === t.id);
              return <li key={t.id} className="st__office">
                <div className="st__officeName"><strong>{t.name}</strong><small>{KIND_LABEL[t.kind]}{t.permissions.length ? ` · ${t.permissions.map((p) => PERM_LABEL[p]?.toLowerCase()).join(', ')}` : ''}</small></div>
                <div className="st__holders">
                  {hs.map((h) => <div key={h.id} className="st__holder">
                    <span className="mx__avatar" style={{ marginLeft: 0 }}>{initials(h.name)}</span>
                    <div><strong>{h.name}{h.acting && <span className="st__acting">Acting</span>}</strong><small>since {day(h.starts_on)}{h.ends_on ? ` · until ${day(h.ends_on)}` : ''}{h.mandate_limit ? ` · approves up to ${Number(h.mandate_limit).toLocaleString()}` : ''}</small></div>
                    {d.can.appointments && <div className="st__holderBtns">
                      {t.single && <button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => setAppointSheet({ officeTypeId: t.id, person: null, departmentId: '', acting: false, startsOn: '', endsOn: '', mandate: '', replace: true, occupiedBy: h.name })}>Replace</button>}
                      <button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => setEndSheet({ holder: h, reason: 'transferred', endsOn: '' })}>End</button>
                    </div>}
                  </div>)}
                  {!hs.length && <span className={`st__vacant ${t.single ? '' : 'st__vacant--soft'}`}>{t.single ? 'Vacant' : 'None yet'}</span>}
                </div>
                {d.can.appointments && (!t.single || !hs.length) && <button type="button" className="mx__btn mx__btn--sm" onClick={() => setAppointSheet({ officeTypeId: t.id, person: null, departmentId: '', acting: false, startsOn: '', endsOn: '', mandate: '', replace: false, occupiedBy: null })}>Appoint</button>}
              </li>;
            })}
              {!seats.length && <li><p className="mx__tiny">No offices are set for this level. Add them under Levels & offices.</p></li>}
            </ul>
            {past.length > 0 && <div className="st__past"><button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => setShowPast(!showPast)}>{showPast ? 'Hide history' : `History · ${past.length}`}</button>
              {showPast && <ul className="mx__list">{past.map((h) => <li key={h.id}><span className="mx__avatar" style={{ marginLeft: 0, opacity: .6 }}>{initials(h.name)}</span><div className="mx__main"><strong>{h.name} · {types.find((t) => t.id === h.office_type_id)?.name ?? data.officeTypes.find((t) => t.id === h.office_type_id)?.name}{h.acting ? ' (acting)' : ''}</strong><small>{day(h.starts_on)} to {day(h.ends_on)}{h.end_reason ? ` · ${END_REASONS.find(([k]) => k === h.end_reason)?.[1] ?? h.end_reason}` : ''}{h.appointed_by ? ` · appointed by ${h.appointed_by}` : ''}</small></div></li>)}</ul>}
            </div>}
          </div>

          {unitLevel?.is_station && <div className="mx__card">
            <div className="mx__cardHead"><h3>Units</h3><div className="mx__bar"><small>from the approved catalogue</small>{d.can.structure && <button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => setDeptSheet(new Set(d.departments.filter((x) => x.active).map((x) => x.catalog_id)))}>Choose units</button>}</div></div>
            <ul className="mx__list">{d.departments.filter((x) => x.active).map((dep) => {
              const head = types.find((t) => t.kind === 'unit_head');
              const hs = live.filter((h) => h.department_id === dep.id);
              return <li key={dep.id}><div className="mx__main"><strong>{dep.name}</strong><small>{hs.length ? hs.map((h) => `${h.name}${h.acting ? ' (acting)' : ''}`).join(', ') : 'No unit head'}</small></div>
                {d.can.appointments && head && (hs.length
                  ? <><button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => setAppointSheet({ officeTypeId: head.id, person: null, departmentId: dep.id, acting: false, startsOn: '', endsOn: '', mandate: '', replace: true, occupiedBy: hs[0]!.name })}>Replace</button><button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => setEndSheet({ holder: hs[0]!, reason: 'ended', endsOn: '' })}>End</button></>
                  : <button type="button" className="mx__btn mx__btn--sm" onClick={() => setAppointSheet({ officeTypeId: head.id, person: null, departmentId: dep.id, acting: false, startsOn: '', endsOn: '', mandate: '', replace: false, occupiedBy: null })}>Appoint head</button>)}
              </li>;
            })}{!d.departments.some((x) => x.active) && <li><p className="mx__tiny">No units chosen for this station yet.</p></li>}</ul>
          </div>}

          <div className="hr__grid2">
            <div className="mx__card">
              <div className="mx__cardHead"><h3>Members</h3><div className="mx__bar"><small>{d.members.length}</small>{d.can.people && <button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => setPlaceSheet({ person: null })}>Place someone</button>}</div></div>
              <ul className="mx__list">{d.members.slice(0, 50).map((m) => <li key={m.id}><span className="mx__avatar" style={{ marginLeft: 0 }}>{initials(m.display_name)}</span><div className="mx__main"><strong>{m.display_name}</strong><small>{m.position_title ? `${m.position_title} · ` : ''}{m.email}</small></div></li>)}
                {!d.members.length && <li><p className="mx__tiny">Nobody is placed here yet.</p></li>}
                {d.members.length > 50 && <li><p className="mx__tiny">and {d.members.length - 50} more</p></li>}</ul>
            </div>
            <div className="mx__card">
              <div className="mx__cardHead"><h3>Committees</h3><div className="mx__bar"><small>approve as a body</small>{d.can.structure && <button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => setCommitteeSheet({ bodyId: '', key: 'cmc' })}>Link</button>}</div></div>
              <ul className="mx__list">{d.committees.map((c) => <li key={c.id}><div className="mx__main"><strong>{c.name}</strong><small>key {c.structure_key}</small></div></li>)}
                {!d.committees.length && <li><p className="mx__tiny">No committee is linked. Create the CMC in Meetings, then link it here.</p></li>}</ul>
            </div>
          </div>
        </>}
        {!selected && <div className="mx__card"><div className="mx__cardBody"><EmptyState icon="people" title="Choose a unit" text="Pick a jurisdiction or station on the left to see its offices and people." /></div></div>}
      </div>
    </div>}

    {tab === 'vacant' && <div className="mx__card" style={{ marginTop: 14 }}>
      <div className="mx__cardHead"><h3>Vacancies</h3><small>head and single offices with nobody in them</small></div>
      <table className="mx__table"><thead><tr><th>Unit</th><th>Level</th><th>Vacant offices</th><th>Under</th></tr></thead>
        <tbody>{units.filter((u) => u.vacant.length && u.active).sort((a, b) => (levels.get(a.level_id ?? '')?.rank ?? 99) - (levels.get(b.level_id ?? '')?.rank ?? 99)).map((u) => <tr key={u.id} className="is-click" onClick={() => reveal(u.id)}><td><strong>{u.name}</strong></td><td>{lvName(u.level_id)}</td><td>{u.vacant.map((id) => types.find((t) => t.id === id)?.name).join(', ')}</td><td>{u.parent_id ? byId.get(u.parent_id)?.name : '—'}</td></tr>)}
          {!units.some((u) => u.vacant.length && u.active) && <tr><td colSpan={4}><EmptyState icon="check" title="No vacancies" text="Every head and single office is filled." /></td></tr>}</tbody></table>
    </div>}

    {tab === 'mine' && <div className="mx__card" style={{ marginTop: 14 }}>
      <div className="mx__cardHead"><h3>My offices</h3><small>you act in each of these separately</small></div>
      <ul className="mx__list">{data.me.offices.map((o) => <li key={o.id}><span className="mx__avatar" style={{ marginLeft: 0 }}>{initials(o.office)}</span><div className="mx__main"><strong>{o.acting ? 'Acting ' : ''}{o.office} · {o.unit}</strong><small>since {day(o.starts_on)}{o.mandate_limit ? ` · approves up to ${Number(o.mandate_limit).toLocaleString()}` : ''}{o.permissions.length ? ` · ${o.permissions.map((p) => PERM_LABEL[p]?.toLowerCase()).join(', ')}` : ' · no admin rights'}</small></div><button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => reveal(o.unit_id)}>Open</button></li>)}
        {!data.me.offices.length && <li><EmptyState icon="people" title="You hold no office" text={data.me.workspaceAdmin ? 'As a workspace admin you can still manage the whole structure.' : 'When you are appointed to an office it shows here.'} /></li>}</ul>
    </div>}

    {tab === 'settings' && canAdminister && <div className="mx__stack" style={{ marginTop: 14 }}>
      <div className="mx__card"><div className="mx__cardHead"><h3>Levels</h3><button type="button" className="mx__btn mx__btn--sm" onClick={() => setLevelSheet({ name: '', rank: String((data.levels.at(-1)?.rank ?? 0) + 1), isStation: false })}>+ Level</button></div>
        <table className="mx__table"><thead><tr><th>Rank</th><th>Name</th><th>Kind</th><th>Units</th></tr></thead>
          <tbody>{data.levels.map((l) => <tr key={l.id} className="is-click" onClick={() => setLevelSheet({ id: l.id, name: l.name, rank: String(l.rank), isStation: l.is_station })}><td>{l.rank}</td><td><strong>{l.name}</strong></td><td>{l.is_station ? 'Church (station)' : 'Jurisdiction'}</td><td>{units.filter((u) => u.level_id === l.id).length}</td></tr>)}</tbody></table></div>
      <div className="mx__card"><div className="mx__cardHead"><h3>Offices</h3><button type="button" className="mx__btn mx__btn--sm" onClick={() => setOfficeSheet({ name: '', levelId: '', kind: 'officer', single: false, permissions: [], active: true, sort: '100' })}>+ Office</button></div>
        <table className="mx__table"><thead><tr><th>Office</th><th>Level</th><th>Kind</th><th>Seats</th><th>Permissions</th></tr></thead>
          <tbody>{data.officeTypes.map((t) => <tr key={t.id} className="is-click" onClick={() => setOfficeSheet({ id: t.id, name: t.name, levelId: t.level_id ?? '', kind: t.kind, single: t.single, permissions: t.permissions, active: t.active, sort: String(t.sort) })}><td><strong>{t.name}</strong>{!t.active && <> <Pill s="cancelled" text="Off" /></>}</td><td>{lvName(t.level_id) || 'Any'}</td><td>{KIND_LABEL[t.kind]}</td><td>{t.single ? 'One' : 'Several'}</td><td>{t.permissions.length ? t.permissions.map((p) => PERM_LABEL[p]).join(', ') : '—'}</td></tr>)}</tbody></table></div>
      <div className="mx__card"><div className="mx__cardHead"><h3>Unit catalogue</h3><button type="button" className="mx__btn mx__btn--sm" onClick={() => setCatalogSheet({ name: '', active: true, sort: '100' })}>+ Unit</button></div>
        <div className="mx__cardBody"><div className="st__chips">{data.catalog.map((c) => <button key={c.id} type="button" className={`st__chip ${c.active ? '' : 'is-off'}`} onClick={() => setCatalogSheet({ id: c.id, name: c.name, active: c.active, sort: String(c.sort) })}>{c.name}</button>)}</div></div></div>
    </div>}

    {/* ------------------------------------------------------------ sheets */}
    {unitSheet && <Sheet eyebrow={unitSheet.id ? 'Edit' : unitSheet.parentId ? `Under ${byId.get(unitSheet.parentId)?.name}` : 'Top level'} title={unitSheet.id ? unitSheet.name || 'Unit' : 'New unit'} onClose={() => setUnitSheet(null)}
      footer={<><button type="button" className="mx__btn mx__btn--ghost" onClick={() => setUnitSheet(null)}>Cancel</button><button type="button" className="mx__btn" disabled={!unitSheet.name.trim() || !unitSheet.levelId || busy === 'unit'} onClick={() => void act('unit', async () => { const r = await postJson<{ id: string }>('/api/structure/units', { id: unitSheet.id, name: unitSheet.name, parentId: unitSheet.parentId, levelId: unitSheet.levelId, country: unitSheet.country, code: unitSheet.code, hostStationId: unitSheet.hostStationId, active: unitSheet.active }); setUnitSheet(null); if (unitSheet.parentId) setOpen(new Set([...open, unitSheet.parentId])); setSelected(r.id); return unitSheet.id ? 'Saved.' : `${unitSheet.name} added.`; })}>{unitSheet.id ? 'Save' : 'Add'}</button></>}>
      <SheetSection title="The unit">
        <F label="Name" wide><input autoFocus value={unitSheet.name} onChange={(e) => setUnitSheet({ ...unitSheet, name: e.target.value })} placeholder="Area 07" /></F>
        <F label="Level"><select value={unitSheet.levelId} onChange={(e) => setUnitSheet({ ...unitSheet, levelId: e.target.value })}>{childLevels(unitSheet.parentId ? levels.get(byId.get(unitSheet.parentId)?.level_id ?? '') : undefined).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></F>
        <F label="Code" hint="optional"><input value={unitSheet.code} onChange={(e) => setUnitSheet({ ...unitSheet, code: e.target.value })} placeholder="A07" /></F>
        <F label="Country"><select value={unitSheet.country} onChange={(e) => setUnitSheet({ ...unitSheet, country: e.target.value })}><option value="">—</option>{COUNTRIES.map(([c, n]) => <option key={c} value={c}>{n}</option>)}</select></F>
        {unitSheet.id && !levels.get(unitSheet.levelId)?.is_station && <F label="Office hosted at" hint="the station where this office sits"><select value={unitSheet.hostStationId} onChange={(e) => setUnitSheet({ ...unitSheet, hostStationId: e.target.value })}><option value="">Not set</option>{stationsUnder(unitSheet.id).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></F>}
        {unitSheet.id && <F label="Status"><Choice value={unitSheet.active ? 'yes' : 'no'} onChange={(v) => setUnitSheet({ ...unitSheet, active: v === 'yes' })} options={[['yes', 'Active'], ['no', 'Inactive']]} /></F>}
      </SheetSection>
    </Sheet>}

    {appointSheet && unit && (() => {
      const t = types.find((x) => x.id === appointSheet.officeTypeId);
      return <Sheet eyebrow={unit.name} title={appointSheet.replace ? `Replace ${appointSheet.occupiedBy}` : `Appoint ${t?.name ?? ''}`} subtitle={appointSheet.replace ? `${appointSheet.occupiedBy}’s appointment ends on the start date and stays in the history. Anything waiting for this office moves to the new holder.` : 'One person may hold several offices. Each appointment has its own dates.'} onClose={() => setAppointSheet(null)}
        footer={<><button type="button" className="mx__btn mx__btn--ghost" onClick={() => setAppointSheet(null)}>Cancel</button><button type="button" className="mx__btn" disabled={!appointSheet.person || busy === 'appoint'} onClick={() => void act('appoint', async () => { await postJson('/api/structure/appointments', { unitId: unit.id, officeTypeId: appointSheet.officeTypeId, actorId: appointSheet.person!.id, departmentId: appointSheet.departmentId || undefined, acting: appointSheet.acting, startsOn: appointSheet.startsOn || undefined, endsOn: appointSheet.endsOn || undefined, mandateLimit: appointSheet.mandate || undefined, replace: appointSheet.replace }); setAppointSheet(null); return `${appointSheet.person!.display_name} is now ${appointSheet.acting ? 'acting ' : ''}${t?.name ?? 'appointed'}.`; })}>{appointSheet.replace ? 'Replace' : 'Appoint'}</button></>}>
        <SheetSection title="Who">
          {!appointSheet.departmentId && !appointSheet.replace && <F label="Office" wide><select value={appointSheet.officeTypeId} onChange={(e) => setAppointSheet({ ...appointSheet, officeTypeId: e.target.value })}>{seats.filter((x) => x.kind !== 'unit_head').map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></F>}
          <div className="mx__field mx__field--wide"><label>Person</label><PersonPicker value={appointSheet.person} onPick={(p) => setAppointSheet({ ...appointSheet, person: p })} /></div>
          <F label="Capacity" wide><Choice value={appointSheet.acting ? 'acting' : 'full'} onChange={(v) => setAppointSheet({ ...appointSheet, acting: v === 'acting' })} options={[['full', 'Substantive'], ['acting', 'Acting']]} /></F>
        </SheetSection>
        <SheetSection title="When and how much" hint="Leave the end empty for an open appointment. The mandate caps what they can approve in this office.">
          <F label="Starts"><input type="date" value={appointSheet.startsOn} onChange={(e) => setAppointSheet({ ...appointSheet, startsOn: e.target.value })} /></F>
          <F label="Ends"><input type="date" value={appointSheet.endsOn} onChange={(e) => setAppointSheet({ ...appointSheet, endsOn: e.target.value })} /></F>
          <F label="Approval mandate" hint="optional"><input inputMode="decimal" value={appointSheet.mandate} onChange={(e) => setAppointSheet({ ...appointSheet, mandate: e.target.value })} placeholder="No limit" /></F>
        </SheetSection>
      </Sheet>;
    })()}

    {endSheet && unit && <Sheet eyebrow={unit.name} title={`End ${endSheet.holder.name}’s appointment`} subtitle="The appointment stays in the history. Anything waiting for them in this office moves to the next holder or the level above." onClose={() => setEndSheet(null)}
      footer={<><button type="button" className="mx__btn mx__btn--ghost" onClick={() => setEndSheet(null)}>Cancel</button><button type="button" className="mx__btn" disabled={busy === 'end'} onClick={() => void act('end', async () => { await postJson(`/api/structure/appointments/${endSheet.holder.id}/end`, { reason: endSheet.reason, endsOn: endSheet.endsOn || undefined }); setEndSheet(null); return `${endSheet.holder.name}’s appointment ended.`; })}>End appointment</button></>}>
      <SheetSection title="Why and when">
        <F label="Reason" wide><Choice value={endSheet.reason} onChange={(v) => setEndSheet({ ...endSheet, reason: v })} options={END_REASONS} wide /></F>
        <F label="Last day" hint="today if empty"><input type="date" value={endSheet.endsOn} onChange={(e) => setEndSheet({ ...endSheet, endsOn: e.target.value })} /></F>
      </SheetSection>
    </Sheet>}

    {inviteSheet && unit && <Sheet eyebrow={unit.name} title="Invite someone" subtitle="They join this unit, and take the office on arrival if you choose one." onClose={() => setInviteSheet(null)}
      footer={<><button type="button" className="mx__btn mx__btn--ghost" onClick={() => setInviteSheet(null)}>Cancel</button><button type="button" className="mx__btn" disabled={!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(inviteSheet.email) || busy === 'invite'} onClick={() => void act('invite', async () => { await postJson('/api/structure/invite', { unitId: unit.id, email: inviteSheet.email, role: inviteSheet.role, officeTypeId: inviteSheet.officeTypeId || undefined }); setInviteSheet(null); return `Invitation sent to ${inviteSheet.email}.`; })}>Send invitation</button></>}>
      <SheetSection title="Who">
        <F label="Email" wide><input autoFocus type="email" value={inviteSheet.email} onChange={(e) => setInviteSheet({ ...inviteSheet, email: e.target.value })} placeholder="name@church.org" /></F>
        <F label="Access" wide><Choice value={inviteSheet.role} onChange={(v) => setInviteSheet({ ...inviteSheet, role: v })} options={[['read_only', 'Member'], ['approver', 'Approver'], ['operator', 'Operator']]} /></F>
        {d?.can.appointments && <F label="Office on arrival" hint="optional" wide><select value={inviteSheet.officeTypeId} onChange={(e) => setInviteSheet({ ...inviteSheet, officeTypeId: e.target.value })}><option value="">None</option>{seats.filter((x) => x.kind !== 'unit_head').map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></F>}
      </SheetSection>
    </Sheet>}

    {placeSheet && unit && <Sheet eyebrow={unit.name} title="Place someone here" subtitle="This becomes their unit. Requests they make route from here." onClose={() => setPlaceSheet(null)}
      footer={<><button type="button" className="mx__btn mx__btn--ghost" onClick={() => setPlaceSheet(null)}>Cancel</button><button type="button" className="mx__btn" disabled={!placeSheet.person || busy === 'place'} onClick={() => void act('place', async () => { await postJson(`/api/structure/members/${placeSheet.person!.id}/place`, { unitId: unit.id }); setPlaceSheet(null); return `${placeSheet.person!.display_name} placed in ${unit.name}.`; })}>Place</button></>}>
      <SheetSection title="Who"><div className="mx__field mx__field--wide"><label>Person</label><PersonPicker value={placeSheet.person} onPick={(p) => setPlaceSheet({ person: p })} /></div></SheetSection>
    </Sheet>}

    {deptSheet && unit && <Sheet eyebrow={unit.name} title="Units at this station" subtitle="From the approved catalogue. Turning one off keeps its history." onClose={() => setDeptSheet(null)}
      footer={<><button type="button" className="mx__btn mx__btn--ghost" onClick={() => setDeptSheet(null)}>Cancel</button><button type="button" className="mx__btn" disabled={busy === 'dept'} onClick={() => void act('dept', async () => { await postJson(`/api/structure/units/${unit.id}/departments`, { catalogIds: [...deptSheet] }); setDeptSheet(null); return 'Units saved.'; })}>Save</button></>}>
      <SheetSection title="Catalogue"><div className="st__chips st__wide">{data.catalog.filter((c) => c.active).map((c) => <button key={c.id} type="button" className={`st__chip ${deptSheet.has(c.id) ? 'is-on' : ''}`} onClick={() => { const n = new Set(deptSheet); if (n.has(c.id)) n.delete(c.id); else n.add(c.id); setDeptSheet(n); }}>{c.name}</button>)}</div></SheetSection>
    </Sheet>}

    {committeeSheet && unit && <Sheet eyebrow={unit.name} title="Link a committee" subtitle="A policy step can then ask this committee to approve, for requests from this unit and below." onClose={() => setCommitteeSheet(null)}
      footer={<><button type="button" className="mx__btn mx__btn--ghost" onClick={() => setCommitteeSheet(null)}>Cancel</button><button type="button" className="mx__btn" disabled={!committeeSheet.bodyId || !committeeSheet.key || busy === 'cmc'} onClick={() => void act('cmc', async () => { await postJson('/api/structure/committees', { unitId: unit.id, bodyId: committeeSheet.bodyId, key: committeeSheet.key }); setCommitteeSheet(null); return 'Committee linked.'; })}>Link</button></>}>
      <SheetSection title="Committee">
        <F label="Body" wide><select value={committeeSheet.bodyId} onChange={(e) => setCommitteeSheet({ ...committeeSheet, bodyId: e.target.value })}><option value="">Choose…</option>{data.committees.map((c) => <option key={c.id} value={c.id}>{c.name}{c.org_unit_id ? ` (linked to ${byId.get(c.org_unit_id)?.name ?? 'a unit'})` : ''}</option>)}</select></F>
        <F label="Key" hint="what a policy step asks for, like cmc"><input value={committeeSheet.key} onChange={(e) => setCommitteeSheet({ ...committeeSheet, key: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_') })} /></F>
      </SheetSection>
    </Sheet>}

    {levelSheet && <Sheet eyebrow="Levels" title={levelSheet.id ? `Edit ${levelSheet.name}` : 'New level'} onClose={() => setLevelSheet(null)}
      footer={<><button type="button" className="mx__btn mx__btn--ghost" onClick={() => setLevelSheet(null)}>Cancel</button><button type="button" className="mx__btn" disabled={!levelSheet.name.trim() || busy === 'level'} onClick={() => void act('level', async () => { await postJson('/api/structure/levels', { id: levelSheet.id, name: levelSheet.name, rank: levelSheet.rank, isStation: levelSheet.isStation }); setLevelSheet(null); return 'Level saved.'; })}>Save</button></>}>
      <SheetSection title="Level"><F label="Name"><input autoFocus value={levelSheet.name} onChange={(e) => setLevelSheet({ ...levelSheet, name: e.target.value })} /></F><F label="Rank" hint="1 is the top"><input inputMode="numeric" value={levelSheet.rank} onChange={(e) => setLevelSheet({ ...levelSheet, rank: e.target.value })} /></F>
        {!levelSheet.id && <F label="Kind" wide><Choice value={levelSheet.isStation ? 'station' : 'jur'} onChange={(v) => setLevelSheet({ ...levelSheet, isStation: v === 'station' })} options={[['jur', 'Jurisdiction'], ['station', 'Church (station)']]} /></F>}</SheetSection>
    </Sheet>}

    {officeSheet && <Sheet wide eyebrow="Offices" title={officeSheet.id ? `Edit ${officeSheet.name}` : 'New office'} subtitle="Permissions are explicit. A title gives nothing on its own, and admin rights give no approval authority." onClose={() => setOfficeSheet(null)}
      footer={<><button type="button" className="mx__btn mx__btn--ghost" onClick={() => setOfficeSheet(null)}>Cancel</button><button type="button" className="mx__btn" disabled={!officeSheet.name.trim() || busy === 'office'} onClick={() => void act('office', async () => { await postJson('/api/structure/office-types', { ...officeSheet, levelId: officeSheet.levelId || null }); setOfficeSheet(null); return 'Office saved.'; })}>Save</button></>}>
      <SheetSection title="The office">
        <F label="Name"><input autoFocus value={officeSheet.name} onChange={(e) => setOfficeSheet({ ...officeSheet, name: e.target.value })} placeholder="Youth Pastor" /></F>
        <F label="Level"><select value={officeSheet.levelId} onChange={(e) => setOfficeSheet({ ...officeSheet, levelId: e.target.value })}><option value="">Any level</option>{data.levels.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></F>
        <F label="Kind" wide><Choice value={officeSheet.kind} onChange={(v) => setOfficeSheet({ ...officeSheet, kind: v })} options={Object.entries(KIND_LABEL) as [string, string][]} wide /></F>
        <F label="Seats"><Choice value={officeSheet.single ? 'one' : 'many'} onChange={(v) => setOfficeSheet({ ...officeSheet, single: v === 'one' })} options={[['one', 'One holder'], ['many', 'Several']]} /></F>
        <F label="Status"><Choice value={officeSheet.active ? 'yes' : 'no'} onChange={(v) => setOfficeSheet({ ...officeSheet, active: v === 'yes' })} options={[['yes', 'In use'], ['no', 'Off']]} /></F>
      </SheetSection>
      <SheetSection title="Permissions" hint="Over this unit and everything under it.">
        <div className="st__perms st__wide">{data.permissions.map((p) => <label key={p} className="st__perm"><input type="checkbox" checked={officeSheet.permissions.includes(p)} onChange={(e) => setOfficeSheet({ ...officeSheet, permissions: e.target.checked ? [...officeSheet.permissions, p] : officeSheet.permissions.filter((x) => x !== p) })} /><span>{PERM_LABEL[p]}</span></label>)}</div>
      </SheetSection>
    </Sheet>}

    {catalogSheet && <Sheet eyebrow="Unit catalogue" title={catalogSheet.id ? `Edit ${catalogSheet.name}` : 'New unit'} onClose={() => setCatalogSheet(null)}
      footer={<><button type="button" className="mx__btn mx__btn--ghost" onClick={() => setCatalogSheet(null)}>Cancel</button><button type="button" className="mx__btn" disabled={!catalogSheet.name.trim() || busy === 'cat'} onClick={() => void act('cat', async () => { await postJson('/api/structure/catalog', catalogSheet); setCatalogSheet(null); return 'Catalogue saved.'; })}>Save</button></>}>
      <SheetSection title="Unit"><F label="Name"><input autoFocus value={catalogSheet.name} onChange={(e) => setCatalogSheet({ ...catalogSheet, name: e.target.value })} placeholder="Drama" /></F>{catalogSheet.id && <F label="Status"><Choice value={catalogSheet.active ? 'yes' : 'no'} onChange={(v) => setCatalogSheet({ ...catalogSheet, active: v === 'yes' })} options={[['yes', 'In use'], ['no', 'Off']]} /></F>}</SheetSection>
    </Sheet>}
  </div>;
}
