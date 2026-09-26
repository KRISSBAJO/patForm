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

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Field,
  FieldCell,
  FormHeader,
  accentStyle,
  formStyle,
  FORM_STYLES,
  type PublicField,
  type PublicForm,
} from '../../components/form-surface';
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
    pages?: {
      key: string;
      title: string;
      description?: string;
      sections?: {
        key: string;
        title?: string;
        description?: string;
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
  previewKey,
  draftId,
  editHeaderRequest,
  hideDeviceSwitch = false,
}: {
  blueprint: Shape;
  /** Absent means read-only; the gallery's detail view passes nothing. */
  onBranding?: (next: NonNullable<PublicForm['branding']>) => void;
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
  useEffect(() => {
    if (!editHeaderRequest) return;
    setEditing(true);
    previewRef.current?.closest('.sp__scroll')?.scrollTo({ top: 0 });
  }, [editHeaderRequest]);
  const byKey = new Map(blueprint.data.fields.map((f) => [f.key, f]));
  const pages = blueprint.experience?.pages ?? [];
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
      <p className="sp__note">
        The live form, as somebody outside your workspace sees it. Type in it if you like — nothing is saved and
        nothing is sent.
      </p>

      {!hideDeviceSwitch && (
        <div className="sp__deviceSwitch" role="group" aria-label="Preview size">
          <button type="button" aria-pressed={device === 'desktop'} onClick={() => setDevice('desktop')}>Desktop</button>
          <button type="button" aria-pressed={device === 'phone'} onClick={() => setDevice('phone')}>Phone</button>
        </div>
      )}

      {previewKey && <a className="sp__fullPreview" href={`/builder/preview?process=${encodeURIComponent(previewKey)}&v=draft`}>Open full preview ↗</a>}

      {onBranding && (
        <button type="button" className="sp__link" onClick={() => setEditing((was) => !was)} aria-expanded={editing}>
          {editing ? 'Close form header settings' : 'Edit form header'}
        </button>
      )}

      {onBranding && editing && (
        <BrandingEditor branding={blueprint.experience?.branding} onChange={onBranding} draftId={draftId} />
      )}

      {/* The respondent's own controls; only the narrow builder side panel scales them. */}
      <div className={`sp__frame ${device === 'phone' ? 'sp__frame--phone' : ''}`} ref={previewRef}>
        <div className="fm" data-style={formStyle(blueprint.experience?.branding)} style={accentStyle(blueprint.experience?.branding?.accent)}>
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
                  return (
                    <section className="fm__section" key={section.key}>
                      {section.title && <h2 className="fm__sectionTitle">{section.title}</h2>}
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
                    </section>
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
 * The header, edited beside the thing it changes.
 *
 * It lives here rather than in a tab of its own because every one of these
 * six values is a judgement about how the form looks, and judging it from a
 * list of text boxes is exactly how the form ended up looking like nothing.
 *
 * The accent is checked here and again by the schema on save. This copy is
 * for the person typing; the one that matters is the server's, because a
 * colour that is not one would reach the page as a style attribute.
 */
function BrandingEditor({
  branding,
  onChange,
  draftId,
}: {
  branding?: PublicForm['branding'];
  onChange: (next: NonNullable<PublicForm['branding']>) => void;
  draftId?: string;
}) {
  const b = branding ?? {};
  const [uploading, setUploading] = useState<'logo' | 'banner' | null>(null);
  const [uploadError, setUploadError] = useState('');
  const set = (k: keyof NonNullable<PublicForm['branding']>, v: string) => {
    const next = { ...b } as Record<string, string>;
    if (v.trim()) next[k] = v;
    else delete next[k];
    onChange(next);
  };

  const accentOk = !b.accent || /^#[0-9a-fA-F]{6}$/.test(b.accent);
  const current = formStyle(b);

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
    <div className="sp__brand">
      <fieldset className="sp__styles">
        <legend>How the form looks</legend>
        {FORM_STYLES.map((style) => (
          <label key={style.key} className="sp__style" data-style={style.key} data-on={current === style.key ? 'true' : undefined}>
            <input
              type="radio"
              name="form-style"
              value={style.key}
              checked={current === style.key}
              onChange={() => set('style', style.key)}
            />
            {/* A thumbnail of the look: one label, one field, one button. */}
            <span className="sp__styleThumb" aria-hidden="true">
              <i className="sp__styleLabel" />
              <i className="sp__styleInput" />
              <i className="sp__styleBtn" />
            </span>
            <span className="sp__styleName">{style.name}</span>
            <span className="sp__styleSays">{style.says}</span>
          </label>
        ))}
      </fieldset>
      <div className="sp__brandHeading"><strong>Form appearance</strong><span>Make the form recognizable to your organization.</span></div>
      <label className="sp__brandRow">
        <span>Form title</span>
        <input
          className="sp__brandInput"
          value={b.title ?? ''}
          placeholder="the process name"
          onChange={(e) => set('title', e.target.value)}
        />
      </label>

      <label className="sp__brandRow">
        <span>Subtitle</span>
        <input
          className="sp__brandInput"
          value={b.tagline ?? ''}
          maxLength={200}
          onChange={(e) => set('tagline', e.target.value)}
        />
      </label>

      <div className="sp__assets">
        {(['logo', 'banner'] as const).map((kind) => {
          const url = kind === 'logo' ? b.logoUrl : b.bannerUrl;
          return <div className="sp__asset" key={kind}>
            <div className="sp__assetTop"><strong>{kind === 'logo' ? 'Logo' : 'Banner'}</strong><small>{kind === 'logo' ? 'Square image recommended' : 'Wide image recommended'}</small></div>
            {url && <div className={`sp__assetImage sp__assetImage--${kind}`}><img src={url} alt={`${kind} preview`} /></div>}
            <div className="sp__assetActions"><label className="sp__uploadButton">{uploading === kind ? 'Uploading…' : url ? 'Replace image' : 'Upload image'}<input type="file" accept="image/png,image/jpeg,image/webp" disabled={!!uploading || !draftId} onChange={(event) => { void upload(kind, event.target.files?.[0]); event.target.value = ''; }} /></label>{url && <button type="button" onClick={() => set(kind === 'logo' ? 'logoUrl' : 'bannerUrl', '')}>Remove</button>}</div>
          </div>;
        })}
      </div>
      {uploadError && <p className="sp__warn" role="alert">{uploadError}</p>}

      <label className="sp__brandRow">
        <span>Accent color</span>
        <span className="sp__brandColour">
          <input
            type="color"
            className="sp__brandSwatch"
            value={accentOk && b.accent ? b.accent : '#14663f'}
            onChange={(e) => set('accent', e.target.value)}
            aria-label="Pick the colour"
          />
          <input
            className="sp__brandInput sp__brandHex"
            value={b.accent ?? ''}
            placeholder="#14663f"
            aria-invalid={accentOk ? undefined : true}
            onChange={(e) => set('accent', e.target.value)}
          />
        </span>
      </label>
      {!accentOk && <p className="sp__warn">A colour has to be six hex digits after a #, like #14663f.</p>}

      <label className="sp__brandRow">
        <span>Footer note</span>
        <input
          className="sp__brandInput"
          value={b.footer ?? ''}
          maxLength={300}
          onChange={(e) => set('footer', e.target.value)}
        />
      </label>

      <p className="sp__brandNote">PNG, JPEG or WebP · 3 MB maximum. Images are stored with this process.</p>
    </div>
  );
}

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
