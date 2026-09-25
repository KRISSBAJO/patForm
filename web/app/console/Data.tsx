'use client';

import { useCallback, useEffect, useState } from 'react';
import { useConfirm } from '../../components/confirm-dialog';
import { Icon } from './Icon';
import { postJson } from './stepup';

type Tab = 'import' | 'map' | 'retention';
type Process = { process_key: string; name: string };
type ImportPlan = {
  processKey: string;
  processName: string;
  columns: { column: string; field: string | null; note: string }[];
  rows: { line: number; problems: { field: string; message: string }[] }[];
  valid: number;
  invalid: number;
  duplicates: { line: number; existingReference: string }[];
};
type ImportResult = ImportPlan & { applied: boolean; created: { reference: string }[]; skipped: { line: number; reason: string }[] };
type MapField = { key: string; label: string; classification: string; collectionReason: string | null; hiddenFrom: string[]; leaves: string[] };
type ProcessMap = { processKey: string; processName: string; version: number; sensitivityCeiling: string; retention: { days: number | null; action: string }; liveRecords: number; fields: MapField[]; notes: string[] };

export function DataView({ processes }: { processes: Process[] }) {
  const [confirm, confirmDialog] = useConfirm();
  const [tab, setTab] = useState<Tab>('import');
  const [processKey, setProcessKey] = useState(processes[0]?.process_key ?? '');
  const [mapKey, setMapKey] = useState('');
  const [fieldSearch, setFieldSearch] = useState('');
  const [csv, setCsv] = useState('');
  const [fileName, setFileName] = useState('');
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [retentionPreview, setRetentionPreview] = useState<number | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [map, setMap] = useState<ProcessMap[] | null>(null);
  const [mapError, setMapError] = useState<string | null>(null);

  const loadMap = useCallback(async () => {
    try {
      const res = await fetch('/api/data-map', { credentials: 'same-origin' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.reason ?? body.error ?? `HTTP ${res.status}`);
      setMap(body as ProcessMap[]); setMapError(null);
    } catch (err) { setMapError(err instanceof Error ? err.message : String(err)); }
  }, []);
  useEffect(() => { void loadMap(); }, [loadMap]);

  const run = async (id: string, work: () => Promise<string>) => {
    setBusy(id); setNote(null);
    try { setNote(await work()); }
    catch (err) { setNote(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(null); }
  };
  const chooseProcess = (key: string) => { setProcessKey(key); setPlan(null); setRetentionPreview(null); };
  const selectedMap = map?.find(item => item.processKey === mapKey) ?? map?.[0];
  const visibleFields = selectedMap?.fields.filter(field => `${field.label} ${field.key} ${field.classification}`.toLowerCase().includes(fieldSearch.toLowerCase())) ?? [];
  const importableCount = plan?.rows.filter(row => !row.problems.length && !plan.duplicates.some(duplicate => duplicate.line === row.line)).length ?? 0;
  const tabs: { id: Tab; label: string; icon: 'export' | 'table' | 'trail' }[] = [
    { id: 'import', label: 'Import records', icon: 'export' },
    { id: 'map', label: 'Data map', icon: 'table' },
    { id: 'retention', label: 'Retention', icon: 'trail' },
  ];

  return <div className="dt__workspace">
    {confirmDialog}
    <header className="ig__hero"><span className="ig__eyebrow">WORKSPACE DATA</span><h2>Bring data in. Know where it goes.</h2><p>Import records, inspect collected fields and manage retention.</p></header>
    <div className="ig__surface">
      <div className="ig__tabs" role="tablist" aria-label="Data tools">{tabs.map((item, index) => <button type="button" key={item.id} id={`dt-tab-${item.id}`} role="tab" aria-selected={tab === item.id} aria-controls={`dt-panel-${item.id}`} tabIndex={tab === item.id ? 0 : -1} className="ig__tab" onClick={() => { setTab(item.id); setNote(null); }} onKeyDown={event => { const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index - 1 + tabs.length) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1; if (next < 0) return; event.preventDefault(); const id = tabs[next]!.id; setTab(id); setNote(null); document.getElementById(`dt-tab-${id}`)?.focus(); }}><Icon name={item.icon} />{item.label}</button>)}</div>
      <section id={`dt-panel-${tab}`} role="tabpanel" aria-labelledby={`dt-tab-${tab}`} className="ig__panel">
        <div className="ig__panelHead"><div><h3>{{ import: 'Import records', map: 'Data map', retention: 'Retention' }[tab]}</h3><p>{{ import: 'Check every row before creating records.', map: 'See what each published process collects and where values travel.', retention: 'Preview records due for deletion under the published policy.' }[tab]}</p></div></div>
        {note && <p className="ig__notice" role="status">{note}</p>}

        {tab === 'import' && <div className="dt__content">
          <div className="dt__importLayout"><div className="dt__importFields">
            <label className="ig__field">Destination process<select className="cs__input" value={processKey} onChange={e => chooseProcess(e.target.value)}>{processes.map(item => <option key={item.process_key} value={item.process_key}>{item.name}</option>)}</select></label>
            <label className="dt__file">Choose a CSV file<input type="file" accept=".csv,text/csv" onChange={e => { const file = e.target.files?.[0]; if (!file) return; void file.text().then(text => { setCsv(text); setFileName(file.name); setPlan(null); }); }} /></label>
            {fileName && <p className="dt__fileName">Selected: {fileName}</p>}
            <label className="ig__field">Or paste CSV rows<textarea className="cs__input" rows={8} value={csv} onChange={e => { setCsv(e.target.value); setFileName(''); setPlan(null); }} placeholder={'full_name,email\nAlex Morgan,alex@example.com'} /></label>
            <button type="button" className="cs__btn cs__btn--primary" disabled={busy === 'plan' || !csv.trim() || !processKey} onClick={() => void run('plan', async () => { const result = await postJson<ImportPlan>(`/api/import/${processKey}/plan`, { csv }); setPlan(result); return 'Preview ready. No records were created.'; })}>{busy === 'plan' ? 'Checking…' : 'Preview import'}</button>
          </div><aside className="dt__importAside"><span className="ig__eyebrow">SAFE IMPORT</span><h4>Check before you commit</h4><ol><li>Choose the process and add CSV rows.</li><li>Preview field matches and row problems.</li><li>Import only after reviewing the result.</li></ol><p>A preview runs validation without creating records.</p></aside></div>

          {plan && <div className="dt__plan"><div className="dt__planHead"><div><span className="ig__eyebrow">IMPORT PREVIEW</span><h4>{plan.processName}</h4></div><div className="dt__counts"><span><strong>{plan.valid}</strong> valid</span><span className={plan.invalid ? 'dt__countBad' : ''}><strong>{plan.invalid}</strong> need fixes</span><span><strong>{plan.duplicates.length}</strong> duplicates</span></div></div>
            <div className="dt__columns"><strong>Column mapping</strong><div>{plan.columns.map(column => <span key={column.column} className={column.field ? '' : 'dt__unmatched'}>{column.column} <b>→</b> {column.field ?? 'Ignored'}</span>)}</div></div>
            {plan.rows.some(row => row.problems.length) && <div className="dt__problems"><strong>Rows to fix</strong><ul>{plan.rows.flatMap(row => row.problems.map((problem, index) => <li key={`${row.line}-${index}`}>Row {row.line} · {problem.field}: {problem.message}</li>)).slice(0, 15)}</ul></div>}
            {plan.duplicates.length > 0 && <p className="dt__duplicate">{plan.duplicates.length} row(s) match records that already exist and will be skipped.</p>}
            <div className="dt__planActions"><span>{plan.invalid ? 'Fix the listed rows and preview again.' : 'Ready to import. Duplicates will be skipped.'}</span><button type="button" className="cs__btn cs__btn--primary" disabled={busy === 'apply' || plan.invalid > 0 || importableCount === 0} onClick={() => void run('apply', async () => { const result = await postJson<ImportResult>(`/api/import/${processKey}/apply`, { csv }); if (!result.applied) return 'Nothing imported. Review the row problems and preview again.'; setPlan(null); setCsv(''); setFileName(''); return `Created ${result.created.length} record(s). ${result.skipped.length} skipped.`; })}>Import {importableCount} records</button></div>
          </div>}
        </div>}

        {tab === 'map' && <div className="dt__content">
          {mapError && <p className="ig__error" role="alert">{mapError}</p>}
          {map === null && !mapError && <div className="ig__loading">Loading data map…</div>}
          {map?.length === 0 && <div className="ig__empty"><strong>No published processes yet</strong><p>The data map appears when a process is published.</p></div>}
          {selectedMap && <><div className="dt__tools"><label className="ig__field">Process<select className="cs__input" value={selectedMap.processKey} onChange={e => { setMapKey(e.target.value); setFieldSearch(''); }}>{map?.map(item => <option key={item.processKey} value={item.processKey}>{item.processName}</option>)}</select></label><label className="ig__field">Find a field<input className="cs__input" value={fieldSearch} onChange={e => setFieldSearch(e.target.value)} placeholder="Search fields…" /></label></div>
            <div className="dt__mapSummary"><span>Version {selectedMap.version}</span><span>{selectedMap.fields.length} fields</span><span>{selectedMap.liveRecords} records</span><span>Retention: {selectedMap.retention.action}</span></div>
            {selectedMap.notes.length > 0 && <div className="dt__mapNotes"><strong>Review these findings</strong><ul>{selectedMap.notes.map((item, index) => <li key={index}>{item}</li>)}</ul></div>}
            <ul className="dt__fields">{visibleFields.map(field => <li key={field.key}><div><strong>{field.label}</strong><span className="ig__mono">{field.key}</span><span className="ig__status">{field.classification}</span></div>{field.collectionReason && <p>Why collected: {field.collectionReason}</p>}<p>Goes to: {field.leaves.length ? field.leaves.join(', ') : 'Stays in PatForm'}{field.hiddenFrom.length ? ` · Hidden from ${field.hiddenFrom.join(', ')}` : ''}</p></li>)}</ul>{visibleFields.length === 0 && <div className="ig__empty"><strong>No matching fields</strong><p>Try a different search.</p></div>}
          </>}
        </div>}

        {tab === 'retention' && <div className="dt__content dt__retention">
          <div className="dt__retentionIntro"><span className="dt__retentionIcon" aria-hidden="true"><Icon name="trail" /></span><div><strong>Delete only what the process policy allows</strong><p>Running records are not touched. The system keeps an account of each deletion.</p></div></div>
          <label className="ig__field">Process<select className="cs__input" value={processKey} onChange={e => chooseProcess(e.target.value)}>{processes.map(item => <option key={item.process_key} value={item.process_key}>{item.name}</option>)}</select></label>
          <button type="button" className="cs__btn" disabled={busy === 'retention-preview' || !processKey} onClick={() => void run('retention-preview', async () => { const result = await postJson<{ instances: number }>('/api/retention', { processKey, preview: true }); setRetentionPreview(result.instances); return 'Preview complete. Nothing was deleted.'; })}>{busy === 'retention-preview' ? 'Checking…' : 'Preview deletion'}</button>
          {retentionPreview !== null && <div className="dt__retentionResult"><div><strong>{retentionPreview}</strong><span>{retentionPreview === 1 ? 'record' : 'records'} eligible for deletion</span></div><p>Only records past the published retention period are included.</p><button type="button" className="cs__btn" disabled={busy === 'retention-run' || retentionPreview === 0} onClick={() => void (async () => { const approved = await confirm({ title: `Delete ${retentionPreview} eligible record(s)?`, body: 'This removes the records permanently under the published retention policy. The deletion is recorded.', confirmLabel: 'Delete eligible records', tone: 'danger' }); if (!approved) return; void run('retention-run', async () => { const result = await postJson<{ instances: number }>('/api/retention', { processKey, preview: false }); setRetentionPreview(null); await loadMap(); return `${result.instances} record(s) deleted. The deletion was recorded.`; }); })()}>Delete eligible records</button></div>}
        </div>}
      </section>
    </div>
  </div>;
}
