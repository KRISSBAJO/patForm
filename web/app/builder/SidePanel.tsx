'use client';

/**
 * The three things a builder wants beside the editor.
 *
 * Preview, because a form is a thing people look at and the editor shows it
 * as a list of settings. Versions, because "what changed, and who did it" is
 * the first question after something goes wrong. Tests, because the scenarios
 * were already being run and the result was hidden behind a modal that
 * covered the thing it was talking about.
 *
 * None of these is a second place to edit. The editor is the only place a
 * blueprint changes, which is why none of this can drift from it.
 */

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import {
  Field,
  FieldCell,
  FormHeader,
  accentStyle,
  formFont,
  formSize,
  formStyle,
  surfaceAttributes,
  FORM_FONTS,
  FORM_SIZES,
  FORM_STYLES,
  type PublicField,
  type PublicForm,
} from '../../components/form-surface';
import { DEFAULT_PER_STEP, layoutPages, type Layout } from '../../components/form-layout';
import { holds } from '../../components/conditions';
import './side.css';

// Structural, not imported: the builder owns the blueprint type, and importing
// it back the other way would make these two modules depend on each other.
interface Shape {
  name: string;
  data: { fields: PreviewField[] };
  experience?: {
    showProgress?: boolean;
    saveAndResume?: boolean;
    confirmation?: { message: string; showStatusLink?: boolean };
    branding?: PublicForm['branding'];
    layout?: Layout;
    pages?: {
      key: string;
      title: string;
      description?: string;
      visibleWhen?: unknown;
      sections?: {
        key: string;
        title?: string;
        description?: string;
        visibleWhen?: unknown;
        fields?: string[];
        widths?: Record<string, string>;
      }[];
    }[];
  };
}

interface PreviewField {
  key: string;
  type: string;
  label: string;
  help?: string;
  required?: boolean;
  choices?: { value: string; label: string }[];
  constraints?: Record<string, unknown>;
  fields?: PreviewField[];
  default?: unknown;
  setBy?: string;
}

function asPublic(field: PreviewField): PublicField {
  return {
    key: field.key,
    type: field.type,
    label: field.label,
    help: field.help,
    required: Boolean(field.required),
    choices: field.choices,
    constraints: field.constraints,
    default: field.default,
    fields: field.fields?.map(asPublic),
  };
}

/**
 * The draft, rendered as the respondent will see it.
 *
 * Live rather than a picture: the same components the public route uses, the
 * same stylesheet, and answers you can actually type — so conditional
 * questions appear and a field too narrow for its content is obvious here
 * rather than after publishing. Nothing is sent anywhere.
 */
export function FormPreview({
  blueprint,
  onBranding,
  onLayout,
  previewKey,
  draftId,
  editHeaderRequest,
  hideDeviceSwitch = false,
}: {
  blueprint: Shape;
  /** Absent means read-only; the gallery's detail view passes nothing. */
  onBranding?: (next: NonNullable<PublicForm['branding']>) => void;
  /** How the pages are split for the respondent; undefined means as designed. */
  onLayout?: (next: Layout | undefined) => void;
  previewKey?: string;
  draftId?: string;
  editHeaderRequest?: number;
  /** The full-page preview has its own desktop/tablet/phone control, so this one steps aside. */
  hideDeviceSwitch?: boolean;
}) {
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const [editing, setEditing] = useState(false);
  const [device, setDevice] = useState<'desktop' | 'phone'>('desktop');
  const [pageIndex, setPageIndex] = useState(0);
  const previewRef = useRef<HTMLDivElement>(null);
  const settingsButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!editHeaderRequest) return;
    setEditing(true);
    previewRef.current?.closest('.sp__scroll')?.scrollTo({ top: 0 });
  }, [editHeaderRequest]);
  const closeSettings = useCallback(() => {
    setEditing(false);
    settingsButton.current?.focus();
  }, []);
  // Escape closes the drawer from anywhere on the page; it is not modal, so
  // the preview stays usable beside it, but it should still leave politely.
  useEffect(() => {
    if (!editing) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeSettings(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [editing, closeSettings]);
  const byKey = new Map(blueprint.data.fields.map((f) => [f.key, f]));
  const designed = (blueprint.experience?.pages ?? []).map((p) => ({
    ...p,
    sections: (p.sections ?? []).map((sec) => ({ ...sec, fields: sec.fields ?? [] })),
  }));
  // The same transform the server applies, so the preview shows the steps the
  // respondent will get and not the pages the designer drew.
  const pages = layoutPages(designed, blueprint.experience?.layout);
  const currentIndex = Math.min(pageIndex, Math.max(0, pages.length - 1));
  const currentPage = pages[currentIndex];
  const placed = new Set(pages.flatMap((p) => (p.sections ?? []).flatMap((s) => s.fields ?? [])));
  // Worked out by the runtime, never asked: a total of the line items, a
  // hidden value. They are not on a page by design, so they are not "missing".
  const AUTOMATIC = new Set(['calculated', 'hidden', 'content']);
  const computed = blueprint.data.fields.filter((f) => f.type === 'calculated');
  const unplaced = blueprint.data.fields.filter(
    (f) => (f.setBy ?? 'respondent') === 'respondent' && !AUTOMATIC.has(f.type) && !placed.has(f.key),
  );
  const teamFields = blueprint.data.fields.filter((f) => f.setBy === 'operator');
  const showPage = (index: number) => {
    setPageIndex(index);
    previewRef.current?.closest('.la__preview, .sp__scroll')?.scrollTo({ top: 0 });
  };

  return (
    <div className="sp__body">
      <div className="sp__bar">
        {!hideDeviceSwitch && (
          <div className="sp__seg" role="group" aria-label="Preview size">
            <button type="button" aria-pressed={device === 'desktop'} aria-label="Desktop" title="Desktop" onClick={() => setDevice('desktop')}><IconDesktop /></button>
            <button type="button" aria-pressed={device === 'phone'} aria-label="Phone" title="Phone" onClick={() => setDevice('phone')}><IconPhone /></button>
          </div>
        )}
        <p className="sp__barNote">As a respondent sees it. Nothing typed here is saved or sent.</p>
        <div className="sp__barRight">
          {previewKey && (
            <a className="sp__iconBtn" href={`/builder/preview?process=${encodeURIComponent(previewKey)}&v=draft`} title="Open full preview" aria-label="Open full preview">
              <IconExternal />
            </a>
          )}
          {onBranding && (
            <button
              type="button"
              ref={settingsButton}
              className="sp__settingsBtn"
              aria-expanded={editing}
              aria-controls="sp-settings"
              onClick={() => (editing ? closeSettings() : setEditing(true))}
            >
              <IconSliders />
              <span>Form settings</span>
            </button>
          )}
        </div>
      </div>

      {onBranding && editing && (
        <FormSettings
          branding={blueprint.experience?.branding}
          layout={blueprint.experience?.layout}
          designedPages={designed.length}
          onBranding={onBranding}
          onLayout={onLayout}
          draftId={draftId}
          onClose={closeSettings}
        />
      )}

      {/* The respondent's own controls; only the narrow builder side panel scales them. */}
      <div className={`sp__frame ${device === 'phone' ? 'sp__frame--phone' : ''}`} ref={previewRef}>
        <div className="fm" {...surfaceAttributes(blueprint.experience?.branding)} style={accentStyle(blueprint.experience?.branding?.accent)}>
          <div className="fm__shell">
            <FormHeader branding={blueprint.experience?.branding} fallbackName={blueprint.name} />

            {pages.length > 1 && (
              <div className="fm__progress" aria-label={`Step ${currentIndex + 1} of ${pages.length}`}>
                <div className="fm__progressBar"><span style={{ width: `${((currentIndex + 1) / pages.length) * 100}%` }} /></div>
                <span className="fm__progressText">Step {currentIndex + 1} of {pages.length}</span>
              </div>
            )}

            {currentPage && (
              <div className="fm__card" key={currentPage.key}>
                <h1 className="fm__title">{currentPage.title}</h1>
                {currentPage.description && <p className="fm__lede">{currentPage.description}</p>}

                {(currentPage.sections ?? []).map((section) => {
                  const fields = (section.fields ?? []).map((k) => byKey.get(k)).filter(Boolean) as PreviewField[];
                  if (!fields.length) return null;
                  // Shown and hidden as the live form does it, from the answers
                  // typed here, so a conditional section is seen only once its
                  // condition holds.
                  if (section.visibleWhen && !holds(section.visibleWhen, answers)) return null;
                  const Wrapper = section.title ? 'section' : 'div';
                  return (
                    <Wrapper className="fm__section" key={section.key} aria-labelledby={section.title ? `psec-${section.key}` : undefined}>
                      {section.title && <h2 className="fm__sectionTitle" id={`psec-${section.key}`}>{section.title}</h2>}
                      {section.description && <p className="fm__sectionLede">{section.description}</p>}
                      <div className="fm__grid">
                        {fields.map((f) => (
                          <FieldCell
                            section={{ key: section.key, fields: [], widths: section.widths }}
                            fieldKey={f.key}
                            key={f.key}
                          >
                            <Field
                              field={asPublic(f)}
                              value={answers[f.key]}
                              onChange={(v) => setAnswers((was) => ({ ...was, [f.key]: v }))}
                            />
                            {(f.key === 'receipt_reference' || f.key === 'invoice_evidence_reference') && (
                              <div className="fm__field" style={{ marginTop: 10 }}>
                                <label className="fm__label" htmlFor={`preview-upload-${f.key}`}>Or upload the document</label>
                                <input id={`preview-upload-${f.key}`} type="file" accept="application/pdf,image/png,image/jpeg" disabled />
                                <p className="fm__help">On the live form: PDF, PNG or JPEG, up to 5 MB. The document must pass a malware scan.</p>
                              </div>
                            )}
                          </FieldCell>
                        ))}
                      </div>
                    </Wrapper>
                  );
                })}
              </div>
            )}

            {pages.length > 1 && (
              <div className="fm__actions sp__pageActions">
                {currentIndex > 0 && <button type="button" className="fm__btn" onClick={() => showPage(currentIndex - 1)}>← Back</button>}
                {currentIndex < pages.length - 1
                  ? <button type="button" className="fm__btn fm__btn--primary" onClick={() => showPage(currentIndex + 1)}>Next page →</button>
                  : <span className="sp__previewEnd">End of preview · nothing is submitted here</span>}
              </div>
            )}

            {blueprint.experience?.branding?.footer && (
              <p className="fm__foot">{blueprint.experience.branding.footer}</p>
            )}
          </div>
        </div>
      </div>

      {/*
       * A field the form never asks is a question somebody wrote and nobody
       * will ever answer. The compiler allows it — an operator may set it —
       * so this is the only place it shows.
       */}
      {unplaced.length > 0 && (
        <p className="sp__warn">
          {unplaced.length} {unplaced.length === 1 ? 'question is' : 'questions are'} not on any page:{' '}
          {unplaced.map((f) => f.label).join(', ')}. Nobody filling this in will see{' '}
          {unplaced.length === 1 ? 'it' : 'them'}.
        </p>
      )}

      {computed.length > 0 && (
        <p className="sp__note">
          Worked out automatically from the answers: {computed.map((f) => f.label).join(', ')}.
        </p>
      )}

      {teamFields.length > 0 && (
        <p className="sp__operatorNote">
          After submission, your team fills in: {teamFields.map((f) => f.label).join(', ')}.
        </p>
      )}

      {!pages.length && <p className="sp__none">This process has no form pages yet, so there is nothing to show.</p>}
    </div>
  );
}

/**
 * The form's settings, in a drawer beside the thing they change.
 *
 * A drawer rather than a block above the preview: the old editor pushed the
 * form it was styling below the fold, so every choice meant scrolling to see
 * it. This sits to the side, the preview updates live, and it is not modal —
 * the preview stays usable while it is open. Escape closes it and puts focus
 * back on the button that opened it.
 *
 * The accent is checked here and again by the schema on save. This copy is
 * for the person typing; the one that matters is the server's, because a
 * colour that is not one would reach the page as a style attribute.
 */
function FormSettings({
  branding,
  layout,
  designedPages,
  onBranding,
  onLayout,
  draftId,
  onClose,
}: {
  branding?: PublicForm['branding'];
  layout?: Layout;
  designedPages: number;
  onBranding: (next: NonNullable<PublicForm['branding']>) => void;
  onLayout?: (next: Layout | undefined) => void;
  draftId?: string;
  onClose: () => void;
}) {
  const b = branding ?? {};
  const [uploading, setUploading] = useState<'logo' | 'banner' | null>(null);
  const [uploadError, setUploadError] = useState('');
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);

  const set = (k: keyof NonNullable<PublicForm['branding']>, v: string) => {
    const next = { ...b } as Record<string, string>;
    if (v.trim()) next[k] = v;
    else delete next[k];
    onBranding(next);
  };

  const accentOk = !b.accent || /^#[0-9a-fA-F]{6}$/.test(b.accent);
  const style = formStyle(b);
  const font = formFont(b);
  const size = formSize(b);
  const mode = layout?.mode ?? 'pages';
  const perStep = layout?.perStep ?? DEFAULT_PER_STEP;
  const setLayout = (nextMode: NonNullable<Layout['mode']>, nextPer?: number) => {
    if (!onLayout) return;
    if (nextMode === 'pages') onLayout(undefined);
    else if (nextMode === 'single') onLayout({ mode: 'single' });
    else onLayout({ mode: 'steps', perStep: Math.min(20, Math.max(1, Math.round(nextPer ?? perStep))) });
  };

  const upload = async (kind: 'logo' | 'banner', file?: File) => {
    if (!file || !draftId) return;
    setUploadError('');
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 3 * 1024 * 1024) {
      setUploadError('Choose a PNG, JPEG or WebP image up to 3 MB.');
      return;
    }
    setUploading(kind);
    try {
      const encoded = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
        reader.onerror = () => reject(new Error('The image could not be read.'));
        reader.readAsDataURL(file);
      });
      const response = await fetch(`/api/builder/drafts/${draftId}/brand-assets`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind, base64: encoded }),
      });
      const result = await response.json() as { url?: string; error?: string; reason?: string };
      if (!response.ok || !result.url) throw new Error(result.reason ?? result.error ?? 'The image could not be uploaded.');
      set(kind === 'logo' ? 'logoUrl' : 'bannerUrl', new URL(result.url, window.location.origin).href);
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : 'The image could not be uploaded.');
    } finally {
      setUploading(null);
    }
  };

  return (
    <aside className="sp__drawer" id="sp-settings" role="dialog" aria-labelledby="sp-settings-title">
      <header className="sp__drawerHead">
        <div>
          <span className="sp__drawerKicker">Preview</span>
          <h2 id="sp-settings-title" ref={heading} tabIndex={-1}>Form settings</h2>
        </div>
        <button type="button" className="sp__drawerClose" onClick={onClose} aria-label="Close form settings"><IconClose /></button>
      </header>

      <div className="sp__drawerBody">
        <section className="sp__group" aria-labelledby="sp-group-look">
          <h3 id="sp-group-look">Look</h3>

          <div className="sp__field">
            <label htmlFor="sp-look">Style</label>
            <select id="sp-look" className="sp__select" value={style} onChange={(e) => set('style', e.target.value)}>
              {FORM_STYLES.map((o) => <option key={o.key} value={o.key}>{o.name}</option>)}
            </select>
            <small>{FORM_STYLES.find((o) => o.key === style)?.says}</small>
          </div>

          <div className="sp__field">
            <label htmlFor="sp-font">Typeface</label>
            <select id="sp-font" className="sp__select" style={{ fontFamily: FONT_PREVIEW[font] }} value={font} onChange={(e) => set('font', e.target.value === 'default' ? '' : e.target.value)}>
              {FORM_FONTS.map((o) => <option key={o.key} value={o.key} style={{ fontFamily: FONT_PREVIEW[o.key] }}>{o.name}</option>)}
            </select>
            <small>{FORM_FONTS.find((o) => o.key === font)?.says}</small>
          </div>

          <div className="sp__field" id="sp-size" role="radiogroup" aria-labelledby="sp-size-label">
            <span id="sp-size-label" className="sp__fieldLabel">Text size</span>
            <div className="sp__segs">
              {FORM_SIZES.map((o) => (
                <label key={o.key} className="sp__segItem" data-size={o.key} data-on={size === o.key ? 'true' : undefined} title={o.name}>
                  <input type="radio" name="sp-size" value={o.key} checked={size === o.key} onChange={() => set('size', o.key === 'regular' ? '' : o.key)} aria-label={o.name} />
                  <span aria-hidden="true">{o.short}</span>
                </label>
              ))}
            </div>
            <small>{FORM_SIZES.find((o) => o.key === size)?.says} Questions, answers and buttons change; the header and page title do not.</small>
          </div>

          <div className="sp__field">
            <span id="sp-accent-label" className="sp__fieldLabel">Accent</span>
            <div className="sp__swatches" role="group" aria-labelledby="sp-accent-label">
              {ACCENTS.map((c) => (
                <button
                  key={c}
                  type="button"
                  className="sp__swatch"
                  style={{ '--sw': c } as CSSProperties}
                  aria-label={`Accent ${c}`}
                  aria-pressed={(b.accent ?? '#14663f').toLowerCase() === c}
                  onClick={() => set('accent', c === '#14663f' ? '' : c)}
                />
              ))}
              <label className="sp__swatch sp__swatch--custom" title="Custom colour">
                <input
                  type="color"
                  value={accentOk && b.accent ? b.accent : '#14663f'}
                  onChange={(e) => set('accent', e.target.value)}
                  aria-label="Custom accent colour"
                />
              </label>
              <input
                className="sp__hex"
                value={b.accent ?? ''}
                placeholder="#14663f"
                aria-label="Accent colour as hex"
                aria-invalid={accentOk ? undefined : true}
                onChange={(e) => set('accent', e.target.value)}
              />
            </div>
            {!accentOk && <small className="sp__bad">Six hex digits after a #, like #14663f.</small>}
          </div>
        </section>

        {onLayout && (
          <section className="sp__group" aria-labelledby="sp-group-steps">
            <h3 id="sp-group-steps">Steps</h3>
            <div className="sp__field">
              <label htmlFor="sp-layout">Split</label>
              <select id="sp-layout" className="sp__select" value={mode} onChange={(e) => setLayout(e.target.value as NonNullable<Layout['mode']>)}>
                <option value="pages">As designed · {designedPages} {designedPages === 1 ? 'page' : 'pages'}</option>
                <option value="single">One page</option>
                <option value="steps">Steps of a fixed size</option>
              </select>
              <small>
                {mode === 'pages'
                  ? 'The pages as they are set out in the form editor.'
                  : mode === 'single'
                    ? 'Everything at once. Short forms finish faster this way; long ones do not.'
                    : `About ${perStep} questions a step, with a progress bar. A long section carries on to the next step.`}
              </small>
            </div>
            {mode === 'steps' && (
              <div className="sp__field">
                <label htmlFor="sp-per-step">Per step</label>
                <input
                  id="sp-per-step"
                  className="sp__text sp__number"
                  type="number"
                  min={1}
                  max={20}
                  value={perStep}
                  onChange={(e) => setLayout('steps', Number(e.target.value))}
                />
              </div>
            )}
          </section>
        )}

        <section className="sp__group" aria-labelledby="sp-group-header">
          <h3 id="sp-group-header">Header</h3>
          <div className="sp__field">
            <label htmlFor="sp-title">Title</label>
            <input id="sp-title" className="sp__text" value={b.title ?? ''} placeholder="The process name" onChange={(e) => set('title', e.target.value)} />
          </div>
          <div className="sp__field">
            <label htmlFor="sp-tagline">Subtitle</label>
            <input id="sp-tagline" className="sp__text" value={b.tagline ?? ''} maxLength={200} placeholder="One line under the title" onChange={(e) => set('tagline', e.target.value)} />
          </div>
          <div className="sp__tiles">
            {(['logo', 'banner'] as const).map((kind) => {
              const url = kind === 'logo' ? b.logoUrl : b.bannerUrl;
              return (
                <div className="sp__tile" key={kind}>
                  <div><strong>{kind === 'logo' ? 'Logo' : 'Banner'}</strong><br /><small>{kind === 'logo' ? 'Square image' : 'Wide image'}</small></div>
                  {url && <div className={`sp__tileImage sp__tileImage--${kind}`}><img src={url} alt={`${kind} preview`} /></div>}
                  <div className="sp__tileActions">
                    <label className="sp__upload">
                      {uploading === kind ? 'Uploading…' : url ? 'Replace' : 'Upload'}
                      <input type="file" accept="image/png,image/jpeg,image/webp" disabled={!!uploading || !draftId} onChange={(event) => { void upload(kind, event.target.files?.[0]); event.target.value = ''; }} />
                    </label>
                    {url && <button type="button" onClick={() => set(kind === 'logo' ? 'logoUrl' : 'bannerUrl', '')}>Remove</button>}
                  </div>
                </div>
              );
            })}
          </div>
          {uploadError && <p className="sp__warn" role="alert">{uploadError}</p>}
          <div className="sp__field">
            <label htmlFor="sp-footer">Footer</label>
            <input id="sp-footer" className="sp__text" value={b.footer ?? ''} maxLength={300} placeholder="Small print under the form" onChange={(e) => set('footer', e.target.value)} />
          </div>
          <p className="sp__drawerNote">PNG, JPEG or WebP, 3 MB at most. Images are stored with this process.</p>
        </section>
      </div>
    </aside>
  );
}

/** How each typeface shows in its own menu, so the choice can be seen before it is made. */
const FONT_PREVIEW: Record<string, string> = {
  default: 'inherit',
  system: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  serif: '"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif',
  grotesque: '"Helvetica Neue", Helvetica, Arial, sans-serif',
  friendly: '"Trebuchet MS", "Segoe UI", Verdana, sans-serif',
};

/** Accents that keep white text readable on a button. The first is the platform's own. */
const ACCENTS = ['#14663f', '#1d4ed8', '#6d28d9', '#b91c1c', '#c2410c', '#0f766e', '#1c2723'];

// Small line icons for the preview bar. Decorative: every control that uses
// one also has a text name.
const ICON = { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };
function IconDesktop() { return <svg {...ICON}><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></svg>; }
function IconPhone() { return <svg {...ICON}><rect x="7" y="2.5" width="10" height="19" rx="2" /><path d="M11 18h2" /></svg>; }
function IconExternal() { return <svg {...ICON}><path d="M14 4h6v6M20 4l-9 9M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5" /></svg>; }
function IconSliders() { return <svg {...ICON}><path d="M4 7h10M18 7h2M4 17h4M12 17h8" /><circle cx="16" cy="7" r="2" /><circle cx="10" cy="17" r="2" /></svg>; }
function IconClose() { return <svg {...ICON}><path d="M6 6l12 12M18 6L6 18" /></svg>; }

// --------------------------------------------------------------- versions

export interface VersionRow {
  version: number;
  publishedAt: string;
  publishedBy: string;
  records: number;
  changes: string[];
}

export function Versions({
  processKey,
  load,
}: {
  processKey: string;
  load: (processKey: string) => Promise<VersionRow[]>;
}) {
  const [rows, setRows] = useState<VersionRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      setRows(await load(processKey));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [load, processKey]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (error) return <p className="sp__warn">{error}</p>;
  if (!rows) return <p className="sp__none">Reading the history…</p>;
  if (!rows.length) {
    return (
      <div className="sp__body">
        <p className="sp__none">
          Nothing published yet. The first publish becomes version 1, and every one after it is kept — a published
          version can never be edited, only replaced by a later one.
        </p>
      </div>
    );
  }

  return (
    <div className="sp__body">
      <p className="sp__note">
        Records keep running under the version they started on. That is why old versions stay: they are still in use.
      </p>
      <ol className="sp__versions">
        {rows.map((row) => (
          <li className="sp__version" key={row.version}>
            <header className="sp__versionHead">
              <strong>v{row.version}</strong>
              <span className="sp__versionWhen">{when(row.publishedAt)}</span>
            </header>
            <p className="sp__versionWho">
              by {row.publishedBy} · {row.records} {row.records === 1 ? 'record' : 'records'} started here
            </p>
            <ul className="sp__changes">
              {row.changes.map((c, i) => (
                <li key={i}>{c}</li>
              ))}
            </ul>
          </li>
        ))}
      </ol>
    </div>
  );
}

function when(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString(undefined, {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
}

// ------------------------------------------------------------------ tests

export interface ScenarioResult {
  process: string;
  test: string;
  kind: string;
  passed: boolean;
  failures: string[];
}

export function TestsPanel({
  tests,
  busy,
  publishable,
  onRun,
}: {
  tests: { results: ScenarioResult[]; passed: number; total: number } | null;
  busy: boolean;
  publishable: boolean;
  onRun: () => void;
}) {
  return (
    <div className="sp__body">
      <p className="sp__note">
        Each scenario runs against the real engine in a scratch workspace — the same policy checks, the same
        transitions, the same effects. Nothing here is simulated.
      </p>

      <button type="button" className="bd__btn" onClick={onRun} disabled={busy || !publishable}>
        {busy ? 'Running…' : tests ? 'Run again' : 'Run the scenarios'}
      </button>
      {!publishable && <p className="sp__warn">Fix the errors first — a blueprint that does not compile cannot run.</p>}

      {tests && (
        <>
          <p className={tests.passed === tests.total ? 'sp__pass' : 'sp__fail'}>
            {tests.passed} of {tests.total} passed
          </p>
          {!tests.total && <p className="sp__none">This blueprint declares no scenarios, so nothing was proved.</p>}
          {tests.results.map((r) => (
            <article className={`sp__test sp__test--${r.passed ? 'ok' : 'bad'}`} key={r.test}>
              <header>
                <strong>{r.test}</strong>
                <span>{r.kind}</span>
                <span className="sp__testMark">{r.passed ? 'passed' : 'failed'}</span>
              </header>
              {r.failures.map((f, i) => (
                <p key={i}>{f}</p>
              ))}
            </article>
          ))}
        </>
      )}
    </div>
  );
}
