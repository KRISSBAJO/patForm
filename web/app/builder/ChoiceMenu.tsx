'use client';

import { useEffect, useId, useRef, useState } from 'react';

export interface ChoiceMenuGroup {
  label: string;
  options: { value: string; label: string; detail?: string }[];
}

export function ChoiceMenu({ label, value, groups, onChange, searchable = false }: {
  label: string;
  value: string;
  groups: ChoiceMenuGroup[];
  onChange: (value: string) => void;
  searchable?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [above, setAbove] = useState(false);
  const [query, setQuery] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const menuId = useId();
  const selected = groups.flatMap(group => group.options).find(option => option.value === value);
  const visible = groups.map(group => ({
    ...group,
    options: group.options.filter(option => `${option.label} ${option.detail ?? ''}`.toLowerCase().includes(query.toLowerCase())),
  })).filter(group => group.options.length);
  const toggle = () => {
    if (!open) {
      const bounds = root.current?.getBoundingClientRect();
      setAbove(Boolean(bounds && window.innerHeight - bounds.bottom < 360 && bounds.top > 360));
    }
    setOpen(!open);
  };

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', closeOutside);
    return () => document.removeEventListener('pointerdown', closeOutside);
  }, [open]);

  useEffect(() => {
    if (open && searchable) search.current?.focus();
    if (!open) setQuery('');
  }, [open, searchable]);

  return <div className="bd__choice" ref={root} onKeyDown={event => {
    if (event.key === 'Escape' && open) {
      event.preventDefault();
      setOpen(false);
      root.current?.querySelector<HTMLButtonElement>('.bd__choiceTrigger')?.focus();
    }
  }}>
    <button type="button" className="bd__choiceTrigger" aria-label={`${label}: ${selected?.label ?? value}`} aria-expanded={open} aria-controls={menuId} onClick={toggle}>
      <span>{selected?.label ?? value}</span>
      <svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="m5 7 5 5 5-5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>
    </button>
    {open && <div id={menuId} className={`bd__choicePanel${above ? ' bd__choicePanel--above' : ''}`} aria-label={`${label} options`}>
      {searchable && <div className="bd__choiceSearch"><svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.5" stroke="currentColor" strokeWidth="1.5" /><path d="m13 13 4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg><input ref={search} aria-label={`Find ${label.toLowerCase()}`} value={query} placeholder="Find a field type…" onChange={event => setQuery(event.target.value)} /></div>}
      <div className="bd__choiceList">
        {visible.map(group => <div className="bd__choiceGroup" key={group.label}>
          <div className="bd__choiceGroupName">{group.label}</div>
          {group.options.map(option => <button type="button" key={option.value} className="bd__choiceOption" aria-pressed={value === option.value} onClick={() => { onChange(option.value); setOpen(false); }}>
            <span><strong>{option.label}</strong>{option.detail && <small>{option.detail}</small>}</span>
            {value === option.value && <svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="m4 10 4 4 8-8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>}
          </button>)}
        </div>)}
        {!visible.length && <p className="bd__choiceEmpty">No matching field types</p>}
      </div>
    </div>}
  </div>;
}
