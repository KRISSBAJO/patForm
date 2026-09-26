/**
 * How a form's pages reach the respondent.
 *
 * A blueprint's pages are how the designer grouped the questions. The
 * experience's `layout` says how to show them: as designed, as one long page,
 * or in steps of a fixed size. This turns the one into the other, once, on
 * the server and in the builder's preview alike.
 *
 * This file exists twice, byte for byte: `src/blueprint/layout.ts` and
 * `web/components/form-layout.ts`. The web app cannot import from `src`, and
 * a preview that lays pages out differently from the server is a preview that
 * lies. A test keeps the two copies identical; change both or neither.
 */

export interface LayoutSection {
  key: string;
  title?: string;
  description?: string;
  visibleWhen?: unknown;
  widths?: Record<string, string>;
  fields: unknown[];
}

export interface LayoutPage<S extends LayoutSection = LayoutSection> {
  key: string;
  title: string;
  description?: string;
  visibleWhen?: unknown;
  sections: S[];
}

export interface Layout {
  mode?: 'pages' | 'single' | 'steps';
  /** Questions per step when `mode` is `steps`. */
  perStep?: number;
}

export const DEFAULT_PER_STEP = 6;

/** Both conditions, when a page's condition has to travel with its sections. */
function both(a: unknown, b: unknown): unknown {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return { op: 'and', operands: [a, b] };
}

export function layoutPages<S extends LayoutSection, P extends LayoutPage<S>>(pages: P[], layout?: Layout): P[] {
  const mode = layout?.mode ?? 'pages';
  if (mode === 'pages' || pages.length === 0) return pages;

  if (mode === 'single') {
    // One page. The first page's heading stays the heading; every later
    // page's title becomes the title of its first section, so the reader
    // still sees where one part ends and the next begins.
    const first = pages[0]!;
    const sections = pages.flatMap((page, i) =>
      page.sections.map((section, j) => ({
        ...section,
        title: i > 0 && j === 0 ? (section.title ? `${page.title} · ${section.title}` : page.title) : section.title,
        visibleWhen: both(page.visibleWhen, section.visibleWhen),
      })),
    );
    return [{ ...first, key: 'all', visibleWhen: undefined, sections } as P];
  }

  // Steps of a fixed size. Sections are cut where the count says, and a cut
  // section keeps its title only on its first part, so a step never opens
  // with a heading repeated from the step before.
  const size = Math.max(1, Math.floor(layout?.perStep ?? DEFAULT_PER_STEP));
  const steps: P[] = [];
  let current: P | undefined;
  let count = 0;
  const open = (page: P): P => {
    const step = { ...page, key: `step_${steps.length + 1}`, visibleWhen: undefined, sections: [] } as unknown as P;
    steps.push(step);
    count = 0;
    return step;
  };
  for (const page of pages) {
    for (const section of page.sections) {
      let offset = 0;
      let part = 0;
      while (offset < section.fields.length) {
        if (!current || count >= size) current = open(page);
        const room = size - count;
        const fields = section.fields.slice(offset, offset + room);
        current.sections.push({
          ...section,
          key: part === 0 ? section.key : `${section.key}_${part + 1}`,
          title: part === 0 ? section.title : undefined,
          description: part === 0 ? section.description : undefined,
          visibleWhen: both(page.visibleWhen, section.visibleWhen),
          fields,
        } as S);
        count += fields.length;
        offset += fields.length;
        part++;
      }
    }
  }
  // A step that starts on a later page takes that page's title, which is
  // what `open` did; the description belongs to the first step only.
  return steps.map((step, i) => (i === 0 ? step : { ...step, description: undefined }));
}
