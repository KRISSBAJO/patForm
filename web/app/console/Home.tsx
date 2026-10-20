'use client';

import { useEffect, useState } from 'react';
import { CONSOLE_MODULES, moduleIsEnabled, type ConsoleModule } from './module-catalog';
import './home.css';

type HomeFeed = {
  approvals: { instanceId: string; reference: string; processName: string; summary: string; late: boolean }[];
  tasks: { instanceId: string; reference: string; processName: string; summary: string; late: boolean }[];
  actions?: { id: string; title: string; late: boolean }[];
  late: number;
  start: { processKey: string; name: string; publicId: string }[];
};

export function HomeView({
  name, workspace, modules, onView, onSelectModule, onOpenRecord,
}: {
  name: string;
  workspace: string;
  modules: string[];
  onView: (view: string) => void;
  onSelectModule: (module: ConsoleModule) => void;
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
  const enabledCount = CONSOLE_MODULES.filter((module) => moduleIsEnabled(module, modules)).length;

  return <div className="wh">
    <section className="wh__welcome" aria-labelledby="wh-title">
      <div className="wh__welcomeCopy">
        <span className="wh__eyebrow"><span className="wh__pulse" /> {workspace} · Your workspace</span>
        <h2 id="wh-title">Welcome back, <em>{firstName}.</em></h2>
        <p>Your place to enter every part of Patform. Choose a module, then carry on where you left off.</p>
        <div className="wh__welcomeActions">
          <button type="button" className="wh__primary" onClick={() => document.getElementById('wh-modules')?.scrollIntoView({ behavior: 'smooth' })}>Explore modules <span aria-hidden="true">↓</span></button>
        </div>
      </div>
      <img src="/images/home-workspace-v1.webp" alt="" width="1536" height="1024" className="wh__art" />
      <span className="wh__heroFoot" aria-hidden="true">ONE WORKSPACE <span>✦</span> EVERY HANDOFF <span>✦</span> ONE HISTORY</span>
    </section>

    <section className="wh__modules" id="wh-modules" aria-labelledby="wh-modules-title">
      <div className="wh__sectionHead"><div><span className="wh__eyebrow">YOUR WORKSPACE</span><h3 id="wh-modules-title">Where would you like to go?</h3><p>{enabledCount} ready to use · Choose any module to open it or switch it on.</p></div></div>
      <div className="wh__moduleGrid">
        {CONSOLE_MODULES.map((module) => { const enabled = moduleIsEnabled(module, modules); return <button type="button" className={`wh__module${enabled ? '' : ' wh__module--inactive'}`} key={module.id} style={{ '--wh-accent': module.area.colour, '--wh-tint': module.area.tint } as React.CSSProperties} onClick={() => onSelectModule(module)}><span className="wh__moduleIcon" aria-hidden="true">{module.area.icon}</span><strong>{module.name}</strong><small>{module.blurb}</small><span className="wh__moduleState">{enabled ? 'Open module' : 'Switch on'}</span><span className="wh__moduleArrow" aria-hidden="true">↗</span></button>; })}
      </div>
    </section>

    <section className="wh__shared" aria-labelledby="wh-shared-title">
      <div className="wh__sectionHead"><div><span className="wh__eyebrow">THE SPACE BEHIND THE WORK</span><h3 id="wh-shared-title">Shared across every module</h3><p>Set up your workspace once. The same people, access and connections follow you throughout.</p></div></div>
      <div className="wh__sharedGrid">
        <button type="button" onClick={() => onView('modules')}><span aria-hidden="true">◫</span><strong>Modules & workspace</strong><small>Choose what is active and set your workspace defaults.</small><b aria-hidden="true">↗</b></button>
        <button type="button" onClick={() => onView('organisation')}><span aria-hidden="true">♙</span><strong>Organisation & authority</strong><small>Manage the people and authority used across modules.</small><b aria-hidden="true">↗</b></button>
        <button type="button" onClick={() => onView('integrations')}><span aria-hidden="true">⌁</span><strong>Integrations</strong><small>Connect the services your team uses.</small><b aria-hidden="true">↗</b></button>
      </div>
    </section>

    <div className="wh__overview wh__overview--single">
      <section className="wh__attention" aria-labelledby="wh-attention-title">
        <div className="wh__sectionHead"><div><span className="wh__eyebrow">PICK UP WHERE YOU LEFT OFF</span><h3 id="wh-attention-title">{feed ? totalWaiting ? `${totalWaiting} ${totalWaiting === 1 ? 'thing needs' : 'things need'} you` : 'You’re all caught up' : 'Your work, at a glance'}</h3></div></div>
        {feedError ? <p className="wh__quiet">Your work could not load right now. Open My work to try again.</p>
          : !feed ? <p className="wh__quiet">Gathering work from across your processes…</p>
          : waiting.length ? <div className="wh__attentionList">{waiting.slice(0, 3).map((item, index) => <button key={`${item.instanceId}-${index}`} type="button" onClick={() => onOpenRecord(item.instanceId)}><span className={`wh__itemDot${item.late ? ' wh__itemDot--late' : ''}`} /><span><strong>{item.summary || item.reference}</strong><small>{item.processName} · {item.reference}{item.late ? ' · Late' : ''}</small></span><span aria-hidden="true">↗</span></button>)}</div>
          : actionCount ? <div className="wh__attentionList">{feed.actions!.slice(0, 3).map((action) => <button key={action.id} type="button" onClick={() => onView('meetings')}><span className={`wh__itemDot${action.late ? ' wh__itemDot--late' : ''}`} /><span><strong>{action.title}</strong><small>Meeting action{action.late ? ' · Late' : ''}</small></span><span aria-hidden="true">↗</span></button>)}</div>
          : <p className="wh__quiet">Nothing needs your decision right now. Choose a module above whenever you’re ready.</p>}
      </section>
    </div>
  </div>;
}
