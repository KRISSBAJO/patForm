'use client';

import { useEffect, useState } from 'react';
import { MODULE_AREAS } from './module-shell';
import './home.css';

type HomeFeed = {
  approvals: { instanceId: string; reference: string; processName: string; summary: string; late: boolean }[];
  tasks: { instanceId: string; reference: string; processName: string; summary: string; late: boolean }[];
  actions?: { id: string; title: string; late: boolean }[];
  late: number;
  start: { processKey: string; name: string; publicId: string }[];
};

type Process = { process_key: string; name: string; open_records: number };

const moduleLinks = [
  { enabledBy: 'expenses', view: 'expenses' },
  { enabledBy: 'procurement', view: 'procurement' },
  { enabledBy: 'hr', view: 'hr' },
  { enabledBy: 'appraisals', view: 'appraisals' },
  { enabledBy: 'assets', view: 'operations' },
  { enabledBy: 'contracts', view: 'compliance' },
  { enabledBy: 'contracts', view: 'sign' },
  { enabledBy: 'meetings', view: 'meetings' },
] as const;

export function HomeView({
  name, workspace, modules, processes, canAdminister, onView, onProcess, onOpenRecord,
}: {
  name: string;
  workspace: string;
  modules: string[];
  processes: Process[];
  canAdminister: boolean;
  onView: (view: string) => void;
  onProcess: (key: string) => void;
  onOpenRecord: (id: string) => void;
}) {
  const [feed, setFeed] = useState<HomeFeed | null>(null);
  const [feedError, setFeedError] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/go', { credentials: 'same-origin', signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('Could not load your work');
        return response.json() as Promise<HomeFeed>;
      })
      .then((data) => setFeed(data))
      .catch(() => { if (!controller.signal.aborted) setFeedError(true); });
    return () => controller.abort();
  }, []);

  const firstName = name.trim().split(/\s+/)[0] || 'there';
  const waiting = feed ? [...feed.approvals, ...feed.tasks].sort((a, b) => Number(b.late) - Number(a.late)) : [];
  const actionCount = feed?.actions?.length ?? 0;
  const totalWaiting = waiting.length + actionCount;
  const enabled = moduleLinks.filter((item) => modules.includes(item.enabledBy));
  const recent = [...processes].sort((a, b) => b.open_records - a.open_records || a.name.localeCompare(b.name)).slice(0, 4);
  const starts = feed?.start.slice(0, 4) ?? [];

  return <div className="wh">
    <section className="wh__welcome" aria-labelledby="wh-title">
      <div className="wh__welcomeCopy">
        <span className="wh__eyebrow"><span className="wh__pulse" /> {workspace} · Your workspace</span>
        <h2 id="wh-title">Welcome back, <em>{firstName}.</em></h2>
        <p>One place to pick up your work, start a request and move between the parts of your workspace.</p>
        <div className="wh__welcomeActions">
          <button type="button" className="wh__primary" onClick={() => onView('work')}>Open my work <span aria-hidden="true">↗</span></button>
          <button type="button" className="wh__plain" onClick={() => onView('processes')}>Browse processes <span aria-hidden="true">→</span></button>
        </div>
      </div>
      <img src="/images/home-workspace-v1.webp" alt="" width="1536" height="1024" className="wh__art" />
      <span className="wh__heroFoot" aria-hidden="true">ONE WORKSPACE <span>✦</span> EVERY HANDOFF <span>✦</span> ONE HISTORY</span>
    </section>

    <div className="wh__overview">
      <section className="wh__attention" aria-labelledby="wh-attention-title">
        <div className="wh__sectionHead"><div><span className="wh__eyebrow">01 / YOUR NEXT STEP</span><h3 id="wh-attention-title">{feed ? totalWaiting ? `${totalWaiting} ${totalWaiting === 1 ? 'thing needs' : 'things need'} you` : 'You’re all caught up' : 'Your work, at a glance'}</h3></div><button type="button" onClick={() => onView(waiting.length ? 'work' : actionCount ? 'meetings' : 'work')}>{actionCount && !waiting.length ? 'Open meetings' : 'See my work'} <span aria-hidden="true">→</span></button></div>
        {feedError ? <p className="wh__quiet">Your work could not load right now. Open My work to try again.</p>
          : !feed ? <p className="wh__quiet">Gathering work from across your processes…</p>
          : waiting.length ? <div className="wh__attentionList">{waiting.slice(0, 3).map((item, index) => <button key={`${item.instanceId}-${index}`} type="button" onClick={() => onOpenRecord(item.instanceId)}><span className={`wh__itemDot${item.late ? ' wh__itemDot--late' : ''}`} /><span><strong>{item.summary || item.reference}</strong><small>{item.processName} · {item.reference}{item.late ? ' · Late' : ''}</small></span><span aria-hidden="true">↗</span></button>)}</div>
          : actionCount ? <div className="wh__attentionList">{feed.actions!.slice(0, 3).map((action) => <button key={action.id} type="button" onClick={() => onView('meetings')}><span className={`wh__itemDot${action.late ? ' wh__itemDot--late' : ''}`} /><span><strong>{action.title}</strong><small>Meeting action{action.late ? ' · Late' : ''}</small></span><span aria-hidden="true">↗</span></button>)}</div>
          : <p className="wh__quiet">No decisions or tasks are waiting. You can start a request or explore a module below.</p>}
      </section>
      <section className="wh__start" aria-labelledby="wh-start-title">
        <div className="wh__sectionHead"><div><span className="wh__eyebrow">02 / START SOMETHING</span><h3 id="wh-start-title">Open a form</h3></div></div>
        {starts.length ? <div className="wh__startList">{starts.map((item) => <a href={`/f/${encodeURIComponent(item.publicId)}`} key={item.publicId}><span className="wh__formMark" aria-hidden="true">✦</span><span>{item.name}</span><span aria-hidden="true">↗</span></a>)}</div>
          : <div className="wh__startEmpty"><p>{feed ? 'There are no forms you can start yet.' : 'Available forms will appear here.'}</p><a href="/builder/new">Explore templates <span aria-hidden="true">↗</span></a></div>}
      </section>
    </div>

    <section className="wh__modules" aria-labelledby="wh-modules-title">
      <div className="wh__sectionHead"><div><span className="wh__eyebrow">03 / YOUR TOOLS</span><h3 id="wh-modules-title">Explore your modules</h3><p>Go straight to the part of Patform you need.</p></div>{canAdminister && <button type="button" onClick={() => onView('modules')}>Manage modules <span aria-hidden="true">→</span></button>}</div>
      <div className="wh__moduleGrid">
        <button type="button" className="wh__module wh__module--forms" onClick={() => onView('processes')}><span className="wh__moduleIcon" aria-hidden="true">▤</span><strong>Forms & workflow</strong><small>Processes, records and approvals</small><span className="wh__moduleArrow" aria-hidden="true">↗</span></button>
        {enabled.map(({ view }) => { const area = MODULE_AREAS[view]; return <button type="button" className="wh__module" key={view} style={{ '--wh-accent': area.colour, '--wh-tint': area.tint } as React.CSSProperties} onClick={() => onView(view)}><span className="wh__moduleIcon" aria-hidden="true">{area.icon}</span><strong>{area.name}</strong><small>{area.blurb}</small><span className="wh__moduleArrow" aria-hidden="true">↗</span></button>; })}
      </div>
    </section>

    {recent.length > 0 && <section className="wh__processes" aria-labelledby="wh-processes-title"><div className="wh__sectionHead"><div><span className="wh__eyebrow">04 / PICK UP A PROCESS</span><h3 id="wh-processes-title">Your processes</h3></div><button type="button" onClick={() => onView('processes')}>View all <span aria-hidden="true">→</span></button></div><div className="wh__processGrid">{recent.map((process) => <button type="button" key={process.process_key} onClick={() => onProcess(process.process_key)}><span className="wh__processGlyph" aria-hidden="true">↗</span><strong>{process.name}</strong><small>{process.open_records ? `${process.open_records} open ${process.open_records === 1 ? 'record' : 'records'}` : 'Open overview'}</small></button>)}</div></section>}
  </div>;
}
