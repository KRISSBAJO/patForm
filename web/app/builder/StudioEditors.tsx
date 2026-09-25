'use client';

import { useState } from 'react';
import { useConfirm } from '../../components/confirm-dialog';
import type { Blueprint, BpDocument, BpField, BpScenario, BpTestStep } from './Builder';

type Change = (fn: (bp: Blueprint) => void) => void;
const keyFor = (prefix: string) => `${prefix}_${Math.random().toString(36).slice(2, 8)}`;
function move<T>(list: T[], from: number, to: number) {
  if (to < 0 || to >= list.length) return;
  list.splice(to, 0, list.splice(from, 1)[0]!);
}

type Clause = { op: 'eq' | 'ne' | 'is_present' | 'is_empty'; left: { field: string }; right?: { literal: string | number | boolean } };
function asClauses(value: unknown): { join: 'and' | 'or'; clauses: Clause[] } | null {
  if (!value) return { join: 'and', clauses: [] };
  if (typeof value !== 'object') return null;
  const e = value as Record<string, unknown>;
  if (e.op === 'and' || e.op === 'or') {
    if (!Array.isArray(e.operands)) return null;
    const clauses = e.operands.map(asClauses);
    if (clauses.some((c) => !c || c.clauses.length !== 1)) return null;
    return { join: e.op, clauses: clauses.flatMap((c) => c!.clauses) };
  }
  if (!['eq', 'ne', 'is_present', 'is_empty'].includes(String(e.op))) return null;
  if (!e.left || typeof e.left !== 'object' || !('field' in e.left)) return null;
  if ((e.op === 'eq' || e.op === 'ne') && (!e.right || typeof e.right !== 'object' || !('literal' in e.right))) return null;
  return { join: 'and', clauses: [e as Clause] };
}
function pack(join: 'and' | 'or', clauses: Clause[]): unknown {
  if (!clauses.length) return undefined;
  return clauses.length === 1 ? clauses[0] : { op: join, operands: clauses };
}

export function ConditionEditor({ title, value, fields, onChange }: { title: string; value: unknown; fields: BpField[]; onChange: (next: unknown) => void }) {
  const parsed = asClauses(value);
  const fieldOptions = fields.flatMap((f) => [f, ...(f.fields ?? [])]);
  const change = (fn: (clauses: Clause[]) => void, join = parsed?.join ?? 'and') => {
    const clauses = structuredClone(parsed?.clauses ?? []);
    fn(clauses);
    onChange(pack(join, clauses));
  };
  return <div className="st__condition">
    <div className="st__conditionHead"><strong>{title}</strong><span>Optional</span></div>
    {!parsed ? <div className="st__complex"><p>This condition has advanced logic. It stays intact until you replace it.</p><button type="button" onClick={() => onChange(undefined)}>Replace with a simple condition</button></div> : <>
      {parsed.clauses.length > 1 && <label className="st__inline">Match <select value={parsed.join} onChange={(e) => onChange(pack(e.target.value as 'and' | 'or', parsed.clauses))}><option value="and">all</option><option value="or">any</option></select> of these conditions</label>}
      {parsed.clauses.map((clause, i) => <div className="st__conditionRow" key={i}>
        <select aria-label="Question" value={clause.left.field} onChange={(e) => change((list) => { list[i]!.left.field = e.target.value; })}><option value="">Choose a question</option>{fieldOptions.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}</select>
        <select aria-label="Comparison" value={clause.op} onChange={(e) => change((list) => { const next = e.target.value as Clause['op']; list[i]!.op = next; if (next === 'eq' || next === 'ne') list[i]!.right = list[i]!.right ?? { literal: '' }; else delete list[i]!.right; })}><option value="eq">is</option><option value="ne">is not</option><option value="is_present">has an answer</option><option value="is_empty">is empty</option></select>
        {(clause.op === 'eq' || clause.op === 'ne') && <input aria-label="Value" placeholder="Value" value={String(clause.right?.literal ?? '')} onChange={(e) => change((list) => { list[i]!.right = { literal: e.target.value }; })} />}
        <button type="button" aria-label="Remove condition" onClick={() => change((list) => { list.splice(i, 1); })}>×</button>
      </div>)}
      <button type="button" className="st__quiet" onClick={() => change((list) => { list.push({ op: 'eq', left: { field: fieldOptions[0]?.key ?? '' }, right: { literal: '' } }); })}>+ Add condition</button>
    </>}
  </div>;
}

export function PageEditor({ blueprint, index, onIndex, onChange, onSelectField }: { blueprint: Blueprint; index: number; onIndex: (i: number) => void; onChange: Change; onSelectField: (i: number) => void }) {
  const [askConfirm, confirmDialog] = useConfirm();
  const page = blueprint.experience?.pages?.[index];
  const [newField, setNewField] = useState<Record<string, string>>({});
  if (!page) return <p className="bd__none">Choose a page or add one in the process map.</p>;
  const pages = blueprint.experience?.pages ?? [];
  const placed = new Set(pages.flatMap((p) => (p.sections ?? []).flatMap((s) => s.fields ?? [])));
  const available = blueprint.data.fields.filter((f) => (f.setBy ?? 'respondent') === 'respondent' && !placed.has(f.key));
  const mutatePage = (fn: (p: NonNullable<typeof page>) => void) => onChange((bp) => fn(bp.experience!.pages![index]!));
  return <div className="st__editor">
    {confirmDialog}
    <header className="st__head"><div><span className="st__eyebrow">FORM PAGE {index + 1} OF {pages.length}</span><h2>{page.title || 'Untitled page'}</h2><p>Arrange what people see and when they see it.</p></div><div className="st__actions"><button type="button" aria-label="Move page up" disabled={index === 0} onClick={() => { onChange((bp) => move(bp.experience!.pages!, index, index - 1)); onIndex(index - 1); }}>↑</button><button type="button" aria-label="Move page down" disabled={index === pages.length - 1} onClick={() => { onChange((bp) => move(bp.experience!.pages!, index, index + 1)); onIndex(index + 1); }}>↓</button><button type="button" disabled={pages.length <= 1} onClick={() => void (async () => { if (!(await askConfirm({ title: 'Remove this page?', body: 'Its fields will stay in the process.', confirmLabel: 'Remove page', tone: 'danger' }))) return; onChange((bp) => { bp.experience!.pages!.splice(index, 1); }); onIndex(Math.max(0, index - 1)); })()}>Remove page</button></div></header>
    <div className="st__pair"><label>Page title<input value={page.title} onChange={(e) => mutatePage((p) => { p.title = e.target.value; })} /></label><label>Page key<input value={page.key} readOnly title="Used by saved references" /></label></div>
    <label className="st__label">Introduction<textarea rows={2} value={page.description ?? ''} onChange={(e) => mutatePage((p) => { p.description = e.target.value || undefined; })} /></label>
    <ConditionEditor title="Show this page when" value={page.visibleWhen} fields={blueprint.data.fields} onChange={(next) => mutatePage((p) => { if (next) p.visibleWhen = next; else delete p.visibleWhen; })} />
    <div className="st__sectionTitle"><h3>Sections <span>{page.sections?.length ?? 0}</span></h3><button type="button" onClick={() => mutatePage((p) => { p.sections = p.sections ?? []; p.sections.push({ key: keyFor('section'), title: 'New section', fields: [] }); })}>+ Add section</button></div>
    {(page.sections ?? []).map((section, si) => <section className="st__section" key={section.key}>
      <header><span className="st__eyebrow">SECTION {si + 1}</span><div className="st__actions"><button type="button" aria-label="Move section up" disabled={si === 0} onClick={() => mutatePage((p) => move(p.sections!, si, si - 1))}>↑</button><button type="button" aria-label="Move section down" disabled={si === page.sections!.length - 1} onClick={() => mutatePage((p) => move(p.sections!, si, si + 1))}>↓</button><button type="button" aria-label="Remove section" disabled={page.sections!.length <= 1} onClick={() => void (async () => { if (await askConfirm({ title: 'Remove this section?', body: 'Its fields will stay in the process.', confirmLabel: 'Remove section', tone: 'danger' })) mutatePage((p) => p.sections!.splice(si, 1)); })()}>Remove</button></div></header>
      <label className="st__label">Section title<input value={section.title ?? ''} onChange={(e) => mutatePage((p) => { p.sections![si]!.title = e.target.value || undefined; })} /></label>
      <label className="st__label">Description<textarea rows={2} value={section.description ?? ''} onChange={(e) => mutatePage((p) => { p.sections![si]!.description = e.target.value || undefined; })} /></label>
      <ConditionEditor title="Show this section when" value={section.visibleWhen} fields={blueprint.data.fields} onChange={(next) => mutatePage((p) => { if (next) p.sections![si]!.visibleWhen = next; else delete p.sections![si]!.visibleWhen; })} />
      <strong className="st__minor">Questions, in form order</strong>
      {(section.fields ?? []).map((key, fi) => { const field = blueprint.data.fields.find((f) => f.key === key); return <div className="st__item" key={`${key}-${fi}`}><button type="button" className="st__itemName" onClick={() => onSelectField(blueprint.data.fields.findIndex((f) => f.key === key))}>{field?.label ?? key}<small>{field?.type.replaceAll('_', ' ') ?? 'Missing field'}</small></button><div className="st__actions"><button type="button" aria-label="Move question up" disabled={fi === 0} onClick={() => mutatePage((p) => move(p.sections![si]!.fields!, fi, fi - 1))}>↑</button><button type="button" aria-label="Move question down" disabled={fi === section.fields!.length - 1} onClick={() => mutatePage((p) => move(p.sections![si]!.fields!, fi, fi + 1))}>↓</button><button type="button" aria-label="Remove question from section" onClick={() => mutatePage((p) => p.sections![si]!.fields!.splice(fi, 1))}>×</button></div></div>; })}
      <div className="st__addRow"><select aria-label={`Add a question to ${section.title ?? 'section'}`} value={newField[section.key] ?? ''} onChange={(e) => setNewField((was) => ({ ...was, [section.key]: e.target.value }))}><option value="">Choose an unplaced question</option>{available.map((f) => <option value={f.key} key={f.key}>{f.label}</option>)}</select><button type="button" disabled={!newField[section.key]} onClick={() => { const key = newField[section.key]; if (key) mutatePage((p) => { p.sections![si]!.fields = [...(p.sections![si]!.fields ?? []), key]; }); setNewField((was) => ({ ...was, [section.key]: '' })); }}>Add</button><button type="button" onClick={() => { const key = keyFor('question'); const nextIndex = blueprint.data.fields.length; onChange((bp) => { bp.data.fields.push({ key, type: 'short_text', label: 'New question', classification: 'internal', setBy: 'respondent' }); bp.experience!.pages![index]!.sections![si]!.fields = [...(bp.experience!.pages![index]!.sections![si]!.fields ?? []), key]; }); onSelectField(nextIndex); }}>+ New question</button></div>
    </section>)}
    <p className="st__footnote">Removing a question from a page keeps its data field and workflow references. Add it to another section whenever you need.</p>
  </div>;
}

export function DocumentEditor({ document: doc, fields, onChange, onRemove }: { document?: BpDocument; fields: BpField[]; onChange: (fn: (d: BpDocument) => void) => void; onRemove: () => void }) {
  const [askConfirm, confirmDialog] = useConfirm();
  const [placeholder, setPlaceholder] = useState('');
  if (!doc) return <p className="bd__none">Choose a document or add one in the process map.</p>;
  return <div className="st__editor">{confirmDialog}<header className="st__head"><div><span className="st__eyebrow">GENERATED DOCUMENT</span><h2>{doc.name}</h2><p>Map process answers into a registered document template.</p></div><button type="button" className="st__danger" onClick={() => void (async () => { if (await askConfirm({ title: 'Remove this document?', body: 'It will be removed from this draft.', confirmLabel: 'Remove document', tone: 'danger' })) onRemove(); })()}>Remove</button></header>
    <div className="st__pair"><label>Name<input value={doc.name} onChange={(e) => onChange((d) => { d.name = e.target.value; })} /></label><label>Source<select value={doc.source} onChange={(e) => onChange((d) => { d.source = e.target.value as BpDocument['source']; })}><option value="html">HTML</option><option value="docx">Word document</option></select></label></div>
    <div className="st__pair"><label>Template reference<input value={doc.templateRef} onChange={(e) => onChange((d) => { d.templateRef = e.target.value; })} /></label><label>Output filename<input value={doc.filename} onChange={(e) => onChange((d) => { d.filename = e.target.value; })} /></label></div>
    <p className="st__footnote">The referenced template must already be registered. This editor connects and fills it; it does not upload a new template.</p>
    <div className="st__sectionTitle"><h3>Delivery</h3></div><div className="st__checks">{([['attach_to_record', 'Attach to record'], ['email', 'Include in email']] as const).map(([value, label]) => <label key={value}><input type="checkbox" checked={doc.deliver.includes(value)} onChange={(e) => onChange((d) => { d.deliver = e.target.checked ? [...d.deliver, value] : d.deliver.filter((x) => x !== value); })} /> {label}</label>)}</div>
    <div className="st__sectionTitle"><h3>Template mapping <span>{Object.keys(doc.mapping).length}</span></h3></div>
    {Object.entries(doc.mapping).map(([token, field]) => <div className="st__mapping" key={token}><code>{token}</code><span>←</span><select aria-label={`Field for ${token}`} value={field} onChange={(e) => onChange((d) => { d.mapping[token] = e.target.value; })}><option value="">Choose field</option>{fields.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}</select><button type="button" aria-label={`Remove ${token} mapping`} onClick={() => onChange((d) => { delete d.mapping[token]; })}>×</button></div>)}
    <div className="st__addRow"><input aria-label="Template placeholder" placeholder="Template placeholder" value={placeholder} onChange={(e) => setPlaceholder(e.target.value)} /><button type="button" disabled={!placeholder.trim() || !fields.length || placeholder in doc.mapping} onClick={() => { onChange((d) => { d.mapping[placeholder.trim()] = fields[0]!.key; }); setPlaceholder(''); }}>+ Map field</button></div>
  </div>;
}

const kinds: BpScenario['kind'][] = ['happy_path', 'rejection', 'missing_data', 'timeout', 'duplicate', 'permission'];
const stepKinds: BpTestStep['step'][] = ['submit', 'decide', 'complete_task', 'advance_hours', 'manual', 'attempt'];
function newStep(kind: BpTestStep['step'], bp: Blueprint): BpTestStep {
  const role = bp.roles.find((r) => r.kind === 'internal')?.key ?? 'operator';
  if (kind === 'submit') return { step: 'submit', answers: {} };
  if (kind === 'decide') return { step: 'decide', approval: bp.workflow.approvals?.[0]?.key ?? 'approval', as: role, decision: 'approved' };
  if (kind === 'complete_task') return { step: 'complete_task', task: bp.workflow.tasks?.[0]?.key ?? 'task', as: role };
  if (kind === 'advance_hours') return { step: 'advance_hours', hours: 1 };
  if (kind === 'manual') return { step: 'manual', transition: bp.workflow.transitions[0]?.key ?? 'transition', as: role };
  return { step: 'attempt', as: role, action: 'view', expectDenied: true };
}
function Choices({ value, options, onChange }: { value: string[]; options: { key: string; name: string }[]; onChange: (next: string[]) => void }) {
  return <div className="st__checks">{options.length ? options.map((option) => <label key={option.key}><input type="checkbox" checked={value.includes(option.key)} onChange={(e) => onChange(e.target.checked ? [...value, option.key] : value.filter((v) => v !== option.key))} />{option.name}</label>) : <span className="st__footnote">None defined yet.</span>}</div>;
}
function answerFromInput(field: BpField | undefined, input: string): unknown {
  if (['number', 'currency', 'integer', 'decimal'].includes(field?.type ?? '') && input.trim() !== '' && Number.isFinite(Number(input))) return Number(input);
  if (field?.type === 'yes_no' || field?.type === 'boolean') return input === 'true';
  return input;
}
export function ScenarioEditor({ scenario, blueprint, onChange, onRemove }: { scenario?: BpScenario; blueprint: Blueprint; onChange: (fn: (s: BpScenario) => void) => void; onRemove: () => void }) {
  const [askConfirm, confirmDialog] = useConfirm();
  const [newAnswer, setNewAnswer] = useState<Record<number, string>>({});
  if (!scenario) return <p className="bd__none">Choose a scenario or add one in the process map.</p>;
  const roles = blueprint.roles.filter((r) => r.kind === 'internal');
  const fields = blueprint.data.fields.flatMap((f) => [f, ...(f.fields ?? [])]);
  const changeStep = (i: number, fn: (step: BpTestStep) => void) => onChange((s) => fn(s.steps[i]!));
  return <div className="st__editor">{confirmDialog}<header className="st__head"><div><span className="st__eyebrow">TEST SCENARIO</span><h2>{scenario.name}</h2><p>Simulate a request and verify the outcome before launch.</p></div><button type="button" className="st__danger" onClick={() => void (async () => { if (await askConfirm({ title: 'Remove this test scenario?', body: 'It will be removed from this draft.', confirmLabel: 'Remove scenario', tone: 'danger' })) onRemove(); })()}>Remove</button></header>
    <div className="st__pair"><label>Scenario name<input value={scenario.name} onChange={(e) => onChange((s) => { s.name = e.target.value; })} /></label><label>Type<select value={scenario.kind} onChange={(e) => onChange((s) => { s.kind = e.target.value as BpScenario['kind']; })}>{kinds.map((k) => <option value={k} key={k}>{k.replaceAll('_', ' ')}</option>)}</select></label></div>
    <div className="st__sectionTitle"><h3>Steps <span>{scenario.steps.length}</span></h3><button type="button" onClick={() => onChange((s) => { s.steps.push(newStep('submit', blueprint)); })}>+ Add step</button></div>
    {scenario.steps.map((step, i) => <section className="st__section" key={i}><header><span className="st__eyebrow">STEP {i + 1}</span><div className="st__actions"><button type="button" disabled={i === 0} onClick={() => onChange((s) => move(s.steps, i, i - 1))}>↑</button><button type="button" disabled={i === scenario.steps.length - 1} onClick={() => onChange((s) => move(s.steps, i, i + 1))}>↓</button><button type="button" disabled={scenario.steps.length === 1} onClick={() => onChange((s) => { s.steps.splice(i, 1); })}>Remove</button></div></header>
      <label className="st__label">Action<select value={step.step} onChange={(e) => onChange((s) => { s.steps[i] = newStep(e.target.value as BpTestStep['step'], blueprint); })}>{stepKinds.map((k) => <option value={k} key={k}>{k.replaceAll('_', ' ')}</option>)}</select></label>
      {step.step === 'submit' && <><strong className="st__minor">Answers</strong>{Object.entries(step.answers).map(([key, value]) => { const field = fields.find((f) => f.key === key); return <div className="st__mapping" key={key}><code>{field?.label ?? key}</code><span>→</span>{field?.type === 'yes_no' || field?.type === 'boolean' ? <select aria-label={`Answer for ${key}`} value={String(value)} onChange={(e) => changeStep(i, (item) => { if (item.step === 'submit') item.answers[key] = e.target.value === 'true'; })}><option value="true">Yes</option><option value="false">No</option></select> : <input aria-label={`Answer for ${key}`} type={['number', 'currency', 'integer', 'decimal'].includes(field?.type ?? '') ? 'number' : 'text'} value={typeof value === 'string' ? value : JSON.stringify(value)} onChange={(e) => changeStep(i, (item) => { if (item.step === 'submit') item.answers[key] = answerFromInput(field, e.target.value); })} />}<button type="button" aria-label={`Remove answer ${key}`} onClick={() => changeStep(i, (item) => { if (item.step === 'submit') delete item.answers[key]; })}>×</button></div>; })}<div className="st__addRow"><select aria-label="Question to answer" value={newAnswer[i] ?? ''} onChange={(e) => setNewAnswer((was) => ({ ...was, [i]: e.target.value }))}><option value="">Choose a question</option>{fields.filter((f) => !(f.key in step.answers)).map((f) => <option value={f.key} key={f.key}>{f.label}</option>)}</select><button type="button" disabled={!newAnswer[i]} onClick={() => { const key = newAnswer[i]; if (key) changeStep(i, (item) => { if (item.step === 'submit') item.answers[key] = fields.find((f) => f.key === key)?.type === 'yes_no' ? false : ''; }); setNewAnswer((was) => ({ ...was, [i]: '' })); }}>Add answer</button></div><p className="st__footnote">For repeating groups and files, use Blueprint JSON to enter structured test values.</p></>}
      {step.step === 'decide' && <div className="st__pair"><label>Approval<select value={step.approval} onChange={(e) => changeStep(i, (item) => { if (item.step === 'decide') item.approval = e.target.value; })}>{(blueprint.workflow.approvals ?? []).map((a) => <option key={a.key} value={a.key}>{a.name}</option>)}</select></label><label>Decision<select value={step.decision} onChange={(e) => changeStep(i, (item) => { if (item.step === 'decide') item.decision = e.target.value as typeof item.decision; })}><option value="approved">Approve</option><option value="rejected">Reject</option><option value="changes_requested">Request changes</option></select></label></div>}
      {step.step === 'complete_task' && <label className="st__label">Task<select value={step.task} onChange={(e) => changeStep(i, (item) => { if (item.step === 'complete_task') item.task = e.target.value; })}>{(blueprint.workflow.tasks ?? []).map((t) => <option key={t.key} value={t.key}>{t.name}</option>)}</select></label>}
      {step.step === 'manual' && <label className="st__label">Transition<select value={step.transition} onChange={(e) => changeStep(i, (item) => { if (item.step === 'manual') item.transition = e.target.value; })}>{blueprint.workflow.transitions.map((t) => <option key={t.key} value={t.key}>{t.name ?? t.key}</option>)}</select></label>}
      {step.step === 'advance_hours' && <label className="st__label">Hours to advance<input type="number" min="0.01" step="0.25" value={step.hours} onChange={(e) => changeStep(i, (item) => { if (item.step === 'advance_hours') item.hours = Number(e.target.value); })} /></label>}
      {step.step === 'attempt' && <div className="st__pair"><label>Action<select value={step.action} onChange={(e) => changeStep(i, (item) => { if (item.step === 'attempt') item.action = e.target.value as typeof item.action; })}>{['submit', 'view', 'edit', 'approve', 'export', 'operate'].map((a) => <option key={a}>{a}</option>)}</select></label><label className="st__check"><input type="checkbox" checked={step.expectDenied} onChange={(e) => changeStep(i, (item) => { if (item.step === 'attempt') item.expectDenied = e.target.checked; })} /> Should be denied</label></div>}
      {'as' in step && <label className="st__label">Acting as<select value={step.as} onChange={(e) => changeStep(i, (item) => { if ('as' in item) item.as = e.target.value; })}>{roles.map((r) => <option key={r.key} value={r.key}>{r.name}</option>)}</select></label>}
      {step.step === 'decide' && <label className="st__label">Reason<input value={step.reason ?? ''} onChange={(e) => changeStep(i, (item) => { if (item.step === 'decide') item.reason = e.target.value || undefined; })} /></label>}
      {step.step === 'complete_task' && <label className="st__check"><input type="checkbox" checked={step.expectDenied ?? false} onChange={(e) => changeStep(i, (item) => { if (item.step === 'complete_task') item.expectDenied = e.target.checked; })} /> Should be denied</label>}
    </section>)}
    <div className="st__sectionTitle"><h3>Expected result</h3></div><div className="st__pair"><label>Final state<select value={scenario.expect.state ?? ''} onChange={(e) => onChange((s) => { if (e.target.value) s.expect.state = e.target.value; else delete s.expect.state; })}><option value="">Do not check</option>{blueprint.workflow.states.map((st) => <option value={st.key} key={st.key}>{st.name}</option>)}</select></label><label>Number of records<input type="number" min="0" value={scenario.expect.instanceCount ?? ''} placeholder="Do not check" onChange={(e) => onChange((s) => { if (e.target.value) s.expect.instanceCount = Number(e.target.value); else delete s.expect.instanceCount; })} /></label></div>
    <strong className="st__minor">Expected messages</strong><Choices value={scenario.expect.emails ?? []} options={(blueprint.communications?.email ?? []).map((m) => ({ key: m.key, name: m.name }))} onChange={(next) => onChange((s) => { s.expect.emails = next; })} />
    <strong className="st__minor">Expected documents</strong><Choices value={scenario.expect.documents ?? []} options={(blueprint.outputs?.documents ?? []).map((d) => ({ key: d.key, name: d.name }))} onChange={(next) => onChange((s) => { s.expect.documents = next; })} />
    <strong className="st__minor">Tasks left open</strong><Choices value={scenario.expect.openTasks ?? []} options={(blueprint.workflow.tasks ?? []).map((t) => ({ key: t.key, name: t.name }))} onChange={(next) => onChange((s) => { s.expect.openTasks = next; })} />
  </div>;
}
