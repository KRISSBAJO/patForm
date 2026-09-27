'use client';
import { useEffect, useState } from 'react';
export type JobProgress={kind?:string;updatedAt?:string;total?:number;completed?:number;passed?:number;name?:string;step?:number;stepTotal?:number};
export type ProgressJob={id:string;status:string;stage:string;created_at?:string;started_at?:string;heartbeat_at?:string;note?:string;progress?:JobProgress|null};
const duration=(seconds:number)=>`${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`;
export function RepairProgress({job,automatic,onCheck}:{job:ProgressJob;automatic:boolean;onCheck:()=>Promise<void>}) {
  const [now,setNow]=useState(Date.now());
  const [checking,setChecking]=useState(false);
  const [updates,setUpdates]=useState<{label:string;at:number}[]>([]);
  useEffect(()=>{const timer=window.setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[]);
  const progress=job.progress;
  const label=progress?.kind==='tests' ? `${progress.name??'Scenario'}${progress.step?` · step ${progress.step} of ${progress.stepTotal}`:''}${progress.completed===progress.total?' · complete':''}` : job.note??(job.status==='queued'?'Waiting for a worker':job.stage==='generating'?'Preparing the requested changes':'Checking the draft');
  useEffect(()=>{setUpdates(was=>was.at(-1)?.label===label?was:[...was,{label,at:Date.now()}].slice(-5));},[label]);
  const started=Date.parse(job.started_at??job.created_at??'');
  const elapsed=Number.isFinite(started)?Math.max(0,Math.floor((now-started)/1000)):null;
  const updated=Date.parse(progress?.updatedAt??'');
  const silence=Number.isFinite(updated)?Math.max(0,Math.floor((now-updated)/1000)):null;
  const heartbeat=Date.parse(job.heartbeat_at??'');
  const disconnected=job.status==='running'&&Number.isFinite(heartbeat)&&now-heartbeat>90000;
  const slow=(elapsed??0)>=180;
  const tests=progress?.kind==='tests'&&!!progress.total;
  return <section className="repair-progress">
    <div className="repair-progress__heading"><div><span className="repair-progress__badge"><span/> {job.status==='queued'?'Queued':disconnected?'Waiting for the worker':'In progress'}</span><h2>{job.status==='queued'?'Your draft is in the queue':tests?'Testing your workflow':job.stage==='generating'?'Preparing your changes':automatic?'Checking and repairing your draft':'Reviewing the proposed changes'}</h2><p>{job.status==='queued'?'Work will begin when a worker is available.':'Progress below comes from the worker processing this draft.'}</p></div><div className="repair-progress__clock" aria-live="off"><span>{job.status==='queued'?'Waiting':'Elapsed'}</span><strong>{elapsed===null?'—':duration(elapsed)}</strong></div></div>
    <div className="repair-progress__current"><span className="repair-progress__pulse" aria-hidden="true"/><div><span>Current activity</span><strong>{label}</strong>{tests&&<small>{progress.completed??0} of {progress.total} scenarios checked · {progress.passed??0} passed{silence!==null?` · updated ${silence}s ago`:''}</small>}</div></div>
    {tests&&<progress max={progress.total} value={progress.completed??0} aria-label="Scenarios checked"/>}
    {slow&&<div className="repair-progress__delay" role="status"><strong>{disconnected?'The worker has stopped reporting.':silence!==null&&silence>90?'No new test progress recently.':'This is taking longer than expected.'}</strong><p>{disconnected?'This run may have been interrupted. The queue can recover interrupted work.':tests?'Each scenario checks your approvals and actions. The counters above update as checks finish; the current check may take longer.':'The run is still pending. Elapsed time does not indicate completion.'} You can leave and return to this page. A pending run is not a verified repair.</p></div>}
    <div className="repair-progress__updates"><h3>Recent updates</h3><ol>{updates.map((event,index)=><li key={`${event.at}-${index}`}><span aria-hidden="true"/><p>{event.label}</p><time>{new Date(event.at).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'})}</time></li>)}</ol></div>
    <div className="repair-progress__footer"><span>Checked drafts are saved privately. Publishing is a separate step.</span><button disabled={checking} onClick={async()=>{setChecking(true);try{await onCheck();}finally{setChecking(false);}}}>{checking?'Checking…':'Check status'}</button></div>
  </section>;
}
