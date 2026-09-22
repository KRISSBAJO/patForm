import type { Blueprint } from '../blueprint/index.js';
import { validateAnswers, type Answers } from '../blueprint/answers.js';
import { VALUE_KIND } from '../blueprint/data.js';
import { inTransaction, type Pool } from './db.js';
import { Engine, identityFor } from './engine.js';
import { require_, type Principal } from './policy.js';

/**
 * CSV import, §21's "CSV import/export" and §5.1's Connect row.
 *
 * The whole design is one sentence: **an import must not be able to create a
 * record a submission could not.** Every row goes through `validateAnswers`,
 * the same function the public form uses and the only implementation of the
 * blueprint's rules. An importer with its own idea of what is valid is a second
 * front door with a weaker lock, and the data it lets in is indistinguishable
 * afterwards from data that came through the real one.
 *
 * What that costs, and why it is worth it: a spreadsheet of a hundred rows
 * where four are wrong cannot be half-imported by default. Somebody fixes four
 * cells and runs it again, rather than hunting for which ninety-six landed.
 * `partial: true` is available for the case where that is genuinely wrong — a
 * migration from a system that is already switched off — and it is not the
 * default.
 */

export interface ImportRow {
  line: number;
  answers: Answers;
  problems: { field: string; message: string }[];
}

export interface ImportPlan {
  processKey: string;
  processName: string;
  /** Columns matched to fields, and what happened to the rest. */
  columns: { column: string; field: string | null; note: string }[];
  rows: ImportRow[];
  valid: number;
  invalid: number;
  /** Rows whose identity fields match a record that already exists. */
  duplicates: { line: number; existingReference: string }[];
}

export interface ImportResult extends ImportPlan {
  applied: boolean;
  created: { line: number; instanceId: string; reference: string }[];
  skipped: { line: number; reason: string }[];
}

/**
 * A CSV parser that handles quoting, because spreadsheets produce quoting.
 *
 * Written rather than depended on for the same reason as the SMTP client and
 * the PDF writer: the surface actually needed is small and well specified
 * (RFC 4180), and the failure mode of getting it wrong is visible immediately
 * rather than subtle.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;

  // A byte order mark from Excel is not part of the first column's name.
  if (text.charCodeAt(0) === 0xfeff) i = 1;

  while (i < text.length) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      quoted = true;
      i++;
      continue;
    }
    if (c === ',') {
      row.push(field);
      field = '';
      i++;
      continue;
    }
    if (c === '\r') {
      i++;
      continue;
    }
    if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i++;
      continue;
    }
    field += c;
    i++;
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

/**
 * Turns a cell into the type the field holds.
 *
 * A CSV has one type, and the blueprint has twenty-three. Everything a
 * spreadsheet exports arrives as text, so this is where "true" becomes a
 * boolean and "1,2" becomes a list — and where a cell that cannot become the
 * right type produces a problem rather than a silent null, because a null that
 * used to be data is worse than a refused row.
 */
function coerce(value: string, type: string): { ok: true; value: unknown } | { ok: false; why: string } {
  const text = value.trim();
  const kind = VALUE_KIND[type as keyof typeof VALUE_KIND];
  if (text === '') return { ok: true, value: undefined };

  switch (kind) {
    case 'number': {
      // Strip a currency symbol and thousands separators: a finance export
      // writes "£1,200.00" and refusing it teaches people to mangle their
      // spreadsheet rather than fixing anything.
      const cleaned = text.replace(/[^0-9.\-]/g, '');
      const n = Number(cleaned);
      if (!Number.isFinite(n)) return { ok: false, why: `"${text}" is not a number` };
      return { ok: true, value: n };
    }
    case 'boolean': {
      const yes = ['true', 'yes', 'y', '1', 'checked'];
      const no = ['false', 'no', 'n', '0', ''];
      if (yes.includes(text.toLowerCase())) return { ok: true, value: true };
      if (no.includes(text.toLowerCase())) return { ok: true, value: false };
      return { ok: false, why: `"${text}" is not yes or no` };
    }
    case 'date': {
      // ISO only. A bare "03/04/2026" is either March or April depending on
      // who exported it, and guessing would put a start date three weeks out
      // with no error anywhere.
      if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
        return { ok: false, why: `"${text}" is not a date — write it as YYYY-MM-DD` };
      }
      return { ok: true, value: text };
    }
    case 'list':
      return { ok: true, value: text.split(/[;|]/).map((s) => s.trim()).filter(Boolean) };
    default:
      return { ok: true, value: text };
  }
}

export async function planImport(
  pool: Pool,
  args: { principal: Principal; processKey: string; csv: string },
): Promise<ImportPlan> {
  return inTransaction(pool, async (client) => {
    if (args.principal.kind !== 'actor') throw new Error('importing is for signed-in members');
    const tenantId = args.principal.tenantId;

    const { rows: versions } = await client.query<{ blueprint: Blueprint }>(
      `select blueprint from process_version
        where tenant_id = $1 and process_key = $2 order by version desc limit 1`,
      [tenantId, args.processKey],
    );
    if (!versions[0]) throw new Error(`no published process "${args.processKey}"`);
    const bp = versions[0].blueprint;

    // `edit`, not `submit`. A respondent submits one form about themselves; an
    // import creates records about other people in bulk, which is an operator's
    // act and belongs behind an operator's capability.
    await require_(
      client,
      { principal: args.principal, action: 'edit', tenantId, processKey: args.processKey, blueprint: bp },
      pool,
    );

    const table = parseCsv(args.csv);
    if (!table.length) throw new Error('that file has no rows');

    const header = table[0]!.map((h) => h.trim());
    const fieldByKey = new Map(bp.data.fields.map((f) => [f.key, f]));
    const fieldByLabel = new Map(bp.data.fields.map((f) => [f.label.toLowerCase(), f]));

    const columns = header.map((column) => {
      const byKey = fieldByKey.get(column);
      if (byKey) return { column, field: byKey.key, note: 'matched by key' };
      const byLabel = fieldByLabel.get(column.toLowerCase());
      if (byLabel) return { column, field: byLabel.key, note: 'matched by label' };
      // Ignored rather than refused: a spreadsheet carries a "Notes" column
      // somebody keeps for themselves, and refusing the file over it would be
      // pedantry. Saying so is what stops a mistyped header being silent.
      return { column, field: null, note: 'no field with this name — ignored' };
    });

    const rows: ImportRow[] = [];
    for (let r = 1; r < table.length; r++) {
      const cells = table[r]!;
      const answers: Answers = {};
      const problems: { field: string; message: string }[] = [];

      for (const [c, column] of columns.entries()) {
        if (!column.field) continue;
        const field = fieldByKey.get(column.field)!;
        const coerced = coerce(cells[c] ?? '', field.type);
        if (!coerced.ok) {
          problems.push({ field: field.key, message: coerced.why });
          continue;
        }
        if (coerced.value !== undefined) answers[field.key] = coerced.value as Answers[string];
      }

      // The same validation the form runs. Not a similar one.
      for (const problem of validateAnswers(bp, answers)) {
        problems.push({ field: problem.field, message: problem.message });
      }

      rows.push({ line: r + 1, answers, problems });
    }

    // Duplicates, by the identity the blueprint declares — the same check a
    // second submission would meet.
    const duplicates: { line: number; existingReference: string }[] = [];
    const identity = bp.data.identity ?? [];
    if (identity.length) {
      for (const row of rows) {
        if (identity.some((k) => row.answers[k] === undefined)) continue;
        // The engine's own computation, not a second one that happens to
        // agree today.
        const key = identityFor(bp, row.answers);
        if (!key) continue;
        const { rows: existing } = await client.query<{ id: string }>(
          'select id from instance where tenant_id = $1 and process_key = $2 and identity_key = $3',
          [tenantId, args.processKey, key],
        );
        if (existing[0]) duplicates.push({ line: row.line, existingReference: existing[0].id.slice(0, 8).toUpperCase() });
      }
    }

    return {
      processKey: args.processKey,
      processName: bp.name,
      columns,
      rows,
      valid: rows.filter((r) => !r.problems.length).length,
      invalid: rows.filter((r) => r.problems.length).length,
      duplicates,
    };
  });
}

export async function applyImport(
  pool: Pool,
  args: { principal: Principal; processKey: string; csv: string; partial?: boolean; now?: Date },
): Promise<ImportResult> {
  const plan = await planImport(pool, { principal: args.principal, processKey: args.processKey, csv: args.csv });
  const now = args.now ?? new Date();

  /*
   * All or nothing, unless asked otherwise.
   *
   * A hundred-row spreadsheet with four bad rows should not become
   * ninety-six records and a puzzle. Refusing the file means somebody fixes
   * four cells and runs it again; importing most of it means they have to work
   * out which ninety-six landed before they dare retry.
   */
  if (plan.invalid > 0 && !args.partial) {
    return {
      ...plan,
      applied: false,
      created: [],
      skipped: plan.rows.filter((r) => r.problems.length).map((r) => ({ line: r.line, reason: 'row has problems' })),
    };
  }

  if (args.principal.kind !== 'actor') throw new Error('importing is for signed-in members');
  const engine = new Engine(pool);
  const { rows: versions } = await pool.query<{ id: string; tenant_id: string; process_key: string; version: number; blueprint: Blueprint }>(
    `select id, tenant_id, process_key, version, blueprint from process_version
      where tenant_id = $1 and process_key = $2 order by version desc limit 1`,
    [args.principal.tenantId, args.processKey],
  );
  const version = versions[0]!;

  const duplicateLines = new Set(plan.duplicates.map((d) => d.line));
  const created: ImportResult['created'] = [];
  const skipped: ImportResult['skipped'] = [];

  for (const row of plan.rows) {
    if (row.problems.length) {
      skipped.push({ line: row.line, reason: row.problems[0]!.message });
      continue;
    }
    if (duplicateLines.has(row.line)) {
      skipped.push({ line: row.line, reason: 'a record with this identity already exists' });
      continue;
    }
    // Through the engine's own submit, so the workflow starts, the receipt is
    // queued and the audit trail begins exactly as it would for a form.
    const outcome = await engine.submit({ version, answers: row.answers, now });
    if (outcome.duplicate) {
      skipped.push({ line: row.line, reason: 'duplicate, detected at submission' });
      continue;
    }
    created.push({
      line: row.line,
      instanceId: outcome.instanceId,
      reference: outcome.instanceId.slice(0, 8).toUpperCase(),
    });
  }

  return { ...plan, applied: true, created, skipped };
}
