'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { FormPreview } from '../SidePanel';
import './launch.css';

type Role = { key: string; name: string; capabilities: string[]; decides: boolean; doesWork: boolean; receivesUpdates: boolean; actorIds: string[]; eligibleActorIds: string[] };
type Member = { id: string; display_name: string; email: string; workspace_role: string; provisioned_by: string };
type Diagnostic = { code: string; severity: 'error' | 'warning'; message: string };
type Setup = {
  draft: {
    id: string; processKey: string; processName: string; revision: number; publishable: boolean;
    blueprint: React.ComponentProps<typeof FormPreview>['blueprint'] & {
      description?: string;
      workflow: { approvals?: { name: string }[]; tasks?: { name: string }[] };
    };
    diagnostics: Diagnostic[];
  };
  members: Member[];
  roles: Role[];
  live: { version: number; public_id: string | null } | null;
  publishedAs: number | null;
};
type TestResult = { passed: number; total: number; results: { test: string; passed: boolean; failures: string[] }[] };
type Impact = { inFlight: number; warnings: Diagnostic[]; fields: { added: string[]; removed: string[] } };
type Phase = 'review' | 'people' | 'launch' | 'done';

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.reason ?? body.error ?? `HTTP ${response.status}`);
  return body as T;
}

export function Launch() {
  const [draftId, setDraftId] = useState('');
  const [setup, setSetup] = useState<Setup | null>(null);
  const [phase, setPhase] = useState<Phase>('review');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [tests, setTests] = useState<TestResult | null>(null);
  const [impact, setImpact] = useState<Impact | null>(null);
  const [inviteRole, setInviteRole] = useState('');
  const [inviteEmail, setInviteEmail] = useState('');
  const [chosen, setChosen] = useState<Record<string, string>>({});

  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('draft') ?? '';
    if (!/^[0-9a-f-]{36}$/.test(id)) { setError('Open this page from an installed template.'); return; }
    setDraftId(id);
    void api<Setup>(`/api/builder/drafts/${id}/setup`)
      .then((value) => { setSetup(value); if (value.publishedAs !== null) setPhase(new URLSearchParams(window.location.search).get('step') === 'people' ? 'people' : 'done'); })
      .catch((reason: Error) => setError(reason.message));
  }, []);

  const refresh = useCallback(async () => {
    if (!draftId) return;
    setSetup(await api<Setup>(`/api/builder/drafts/${draftId}/setup`));
  }, [draftId]);

  const needed = useMemo(() => setup?.roles.filter((role) => role.decides || role.doesWork || role.receivesUpdates) ?? [], [setup]);
  const missing = needed.filter((role) => role.actorIds.length === 0);
  const approvalPeopleChosen = setup?.roles.filter((role) => role.decides).every((role) => role.actorIds.length > 0) ?? false;
  const warnings = setup?.draft.diagnostics.filter((item) => item.severity === 'warning' && !(
    approvalPeopleChosen && /The people in the chain are roles|Who exactly approves this where you work/.test(item.message)
  )) ?? [];
  const formUrl = setup?.live?.public_id ? `${typeof window === 'undefined' ? '' : window.location.origin}/f/${setup.live.public_id}` : '';

  const assign = async (role: Role, member: Member) => {
    setBusy(true); setError(''); setNotice('');
    try {
      await api(`/api/builder/drafts/${draftId}/setup/assign`, {
        method: 'POST', body: JSON.stringify({ roleKey: role.key, actorId: member.id, assigned: !role.actorIds.includes(member.id) }),
      });
      await refresh();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };

  const invite = async (role: Role) => {
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await api<{ delivered: string }>(`/api/builder/drafts/${draftId}/setup/invite`, {
        method: 'POST', body: JSON.stringify({ roleKey: role.key, email: inviteEmail.trim() }),
      });
      setNotice(result.delivered === 'sent'
        ? `Invitation sent to ${inviteEmail.trim()}. When they join, refresh this page to continue.`
        : `Invitation created for ${inviteEmail.trim()}, but delivery was ${result.delivered}. Check email delivery before waiting for them to join.`);
      setInviteEmail(''); setInviteRole('');
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };

  const runTests = async () => {
    setBusy(true); setError('');
    try { setTests(await api<TestResult>(`/api/builder/drafts/${draftId}/test`, { method: 'POST' })); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };

  const reviewPublish = async () => {
    setBusy(true); setError('');
    try { setImpact(await api<Impact>(`/api/builder/drafts/${draftId}/impact`)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };

  const publish = async () => {
    if (!setup || missing.length) return;
    setBusy(true); setError('');
    try {
      await api(`/api/builder/drafts/${draftId}/publish`, {
        method: 'POST', body: JSON.stringify({ revision: setup.draft.revision }),
      });
      await refresh();
      setImpact(null);
      setPhase('done');
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };

  return (
    <div className="la">
      <header className="la__top"><a href="/builder">Patform Builder</a><span>Set up a process</span></header>
      <main className="la__main">
        <a className="la__back" href="/builder/new">← Back to templates</a>
        {!setup ? <p role={error ? 'alert' : 'status'}>{error || 'Opening your process…'}</p> : <>
          <div className="la__intro">
            <span className="la__eyebrow">{setup.publishedAs !== null ? 'LIVE PROCESS' : setup.live ? 'CHANGES TO A LIVE PROCESS' : 'NEW PROCESS'}</span>
            <h1>{setup.draft.processName}</h1>
            <p>{setup.draft.blueprint.description || 'Review the form, choose the people, then publish it.'}</p>
            {phase !== 'done' && <a href={`/builder?draft=${draftId}`}>Open the full builder for changes</a>}
          </div>
          <nav className="la__steps" aria-label="Setup steps">
            {(['review', 'people', 'launch', 'done'] as Phase[]).map((step, index) => (
              <button key={step} type="button" disabled={step === 'done' && setup.publishedAs === null} aria-current={phase === step ? 'step' : undefined}
                onClick={() => setPhase(step)}>{index + 1}. {step === 'review' ? 'See the form' : step === 'people' ? 'Choose people' : step === 'launch' ? 'Check and publish' : 'Share it'}</button>
            ))}
          </nav>
          {error && <p className="la__error" role="alert">{error}</p>}
          {notice && <p className="la__notice" role="status">{notice}</p>}

          {phase === 'review' && <section className="la__panel" aria-labelledby="la-form-title">
            <h2 id="la-form-title">This is what someone will fill in</h2>
            <p>Use Next page to see every part of the form. Typing here does not submit anything.</p>
            <div className="la__preview"><FormPreview blueprint={setup.draft.blueprint} /></div>
            <div className="la__actions"><a href={`/builder?draft=${draftId}`}>Change the form in the builder</a><button type="button" onClick={() => setPhase('people')}>Looks right — choose people →</button></div>
          </section>}

          {phase === 'people' && <section className="la__panel" aria-labelledby="la-people-title">
            <h2 id="la-people-title">Who will decide and do the work?</h2>
            <p>Choose the people who hold each role. A person only sees and acts on records allowed by that role.</p>
            {setup.roles.length === 0 && <p>This process has no internal roles to assign.</p>}
            {[...setup.roles].sort((a, b) => Number(b.decides || b.doesWork || b.receivesUpdates) - Number(a.decides || a.doesWork || a.receivesUpdates)).map((role) => <div className="la__role" key={role.key}>
              <div><h3>{role.name}</h3><p>{role.decides ? 'Approves requests' : role.doesWork ? 'Completes a task' : role.receivesUpdates ? 'Receives reminders or overdue alerts' : role.capabilities?.includes('administer') ? 'Can manage this process and see its records' : 'Receives updates'}{role.decides || role.doesWork || role.receivesUpdates ? ' · required before publishing' : ' · optional'}</p></div>
              <div className="la__members">
                <div className="la__assigned">
                  {role.actorIds.length === 0 ? <span className="la__none">No one assigned yet</span> : role.actorIds.map((id) => {
                    const member = setup.members.find((item) => item.id === id);
                    return member && <span className="la__person" key={id}>{member.display_name} <small>{member.email}</small>
                      {member.provisioned_by !== 'scim' && <button type="button" aria-label={`Remove ${member.display_name} from ${role.name}`} title={setup.live && (role.decides || role.doesWork || role.receivesUpdates) && role.actorIds.length === 1 ? 'Add a replacement first' : undefined} disabled={busy || Boolean(setup.live && (role.decides || role.doesWork || role.receivesUpdates) && role.actorIds.length === 1)} onClick={() => void assign(role, member)}>×</button>}
                    </span>;
                  })}
                </div>
                <label className="la__choose" htmlFor={`la-person-${role.key}`}>Add someone in this workspace</label>
                <select id={`la-person-${role.key}`} value={chosen[role.key] ?? ''} disabled={busy} onChange={(event) => {
                  const member = setup.members.find((item) => item.id === event.target.value);
                  setChosen((current) => ({ ...current, [role.key]: '' }));
                  if (member) void assign(role, member);
                }}>
                  <option value="">Choose a person…</option>
                  {setup.members.filter((member) => role.eligibleActorIds.includes(member.id) && !role.actorIds.includes(member.id) && member.provisioned_by !== 'scim').map((member) => <option value={member.id} key={member.id}>{member.display_name} — {member.email}</option>)}
                </select>
              </div>
              {inviteRole === role.key ? <form className="la__invite" onSubmit={(event) => { event.preventDefault(); void invite(role); }}>
                <label htmlFor={`la-invite-${role.key}`}>Email to invite as {role.name}</label>
                <input id={`la-invite-${role.key}`} type="email" value={inviteEmail} onChange={(event) => setInviteEmail(event.target.value)} required />
                <button type="submit" disabled={busy}>Send invitation</button>
                <button type="button" onClick={() => { setInviteRole(''); setInviteEmail(''); }}>Cancel</button>
              </form> : <button type="button" className="la__textButton" onClick={() => setInviteRole(role.key)}>Invite someone new</button>}
            </div>)}
            {missing.length > 0 && <p className="la__warning" role="status">Choose someone for {missing.map((role) => role.name).join(', ')} before publishing. Invited people count when they join.</p>}
            <div className="la__actions"><button type="button" className="la__secondary" onClick={() => setPhase('review')}>← Form</button><button type="button" disabled={missing.length > 0} onClick={() => setPhase('launch')}>Continue to checks →</button></div>
          </section>}

          {phase === 'launch' && <section className="la__panel" aria-labelledby="la-launch-title">
            <h2 id="la-launch-title">Check before it goes live</h2>
            <p>{setup.draft.processName} starts with a form and has {setup.draft.blueprint.workflow.approvals?.length ?? 0} {setup.draft.blueprint.workflow.approvals?.length === 1 ? 'approval' : 'approvals'} and {setup.draft.blueprint.workflow.tasks?.length ?? 0} {setup.draft.blueprint.workflow.tasks?.length === 1 ? 'task' : 'tasks'}.</p>
            {missing.length > 0 && <p className="la__warning">Missing people: {missing.map((role) => role.name).join(', ')}. <button type="button" onClick={() => setPhase('people')}>Choose people</button></p>}
            <div className="la__check"><strong>Process checks</strong><span>{setup.draft.publishable ? 'No blocking errors' : 'Fix errors in the builder'}</span></div>
            {warnings.length > 0 && <details><summary>{warnings.length} warnings to review</summary><ul>{warnings.map((item, index) => <li key={index}>{item.message}</li>)}</ul></details>}
            <div className="la__check"><strong>Sample records</strong><span>{tests ? `${tests.passed} of ${tests.total} passed` : 'Not run yet'}</span><button type="button" disabled={busy || !setup.draft.publishable} onClick={() => void runTests()}>{busy ? 'Working…' : tests ? 'Run again' : 'Run sample records'}</button></div>
            {tests && tests.passed !== tests.total && <ul className="la__failures">{tests.results.filter((item) => !item.passed).map((item) => <li key={item.test}>{item.test}: {item.failures.join('; ')}</li>)}</ul>}
            {impact && <div className="la__impact"><h3>What publishing changes</h3><p>{impact.inFlight} existing records will stay on their current version. {impact.fields.added.length} fields will be added; {impact.fields.removed.length} removed.</p><p>The form becomes available to anyone with its link.</p>{impact.warnings.length > 0 && <ul>{impact.warnings.map((item, index) => <li key={index}>{item.message}</li>)}</ul>}</div>}
            <div className="la__actions"><button type="button" className="la__secondary" onClick={() => setPhase('people')}>← People</button>{!impact ? <button type="button" disabled={busy || !setup.draft.publishable || missing.length > 0 || !tests || tests.passed !== tests.total} onClick={() => void reviewPublish()}>Review launch →</button> : <button type="button" disabled={busy || missing.length > 0} onClick={() => void publish()}>Publish this process</button>}</div>
          </section>}

          {phase === 'done' && <section className="la__panel la__done" aria-labelledby="la-done-title">
            <span className="la__eyebrow">LIVE · VERSION {setup.live?.version}</span><h2 id="la-done-title">Your process is ready</h2>
            <p>Send this form link to someone who needs to make a request. When they submit it, the right people see their work in the console.</p>
            {formUrl && <div className="la__link"><a href={formUrl} target="_blank" rel="noreferrer">{formUrl}</a><button type="button" onClick={() => { void navigator.clipboard.writeText(formUrl).then(() => setNotice('Form link copied.')); }}>Copy link</button></div>}
            <div className="la__actions"><a className="la__actionLink" href={formUrl} target="_blank" rel="noreferrer">Try the form →</a><a href={`/console?process=${encodeURIComponent(setup.draft.processKey)}`}>Go to approvals and records</a><button type="button" className="la__secondary" onClick={() => setPhase('people')}>Manage people</button><a href={`/builder?process=${encodeURIComponent(setup.draft.processKey)}`}>Edit in builder</a></div>
          </section>}
        </>}
      </main>
    </div>
  );
}
