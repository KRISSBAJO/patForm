import { zodToJsonSchema } from 'zod-to-json-schema';
import { extractJson, type Provider } from '../ai/provider.js';
import { Proposal } from './plan.js';
import type { Asker, PlanContext } from '../runtime/copilot.js';

/**
 * Turning a question into a plan.
 *
 * The prompt is short on purpose. Everything that constrains the output is in
 * the schema, which the model is handed and which the runtime re-validates —
 * a rule stated in prose is a suggestion, and a rule stated in Zod is a rule.
 *
 * The context is the process *schema*, never its contents. The model is told
 * which states and fields exist; it is not shown a single answer. That is what
 * keeps a respondent's free-text from reaching it in the planning step, which
 * matters because the plan decides what gets read next.
 */

export const COPILOT_PROMPT_VERSION = 'copilot-plan@1';

const SYSTEM = `You turn an operator's question about live records into a query plan.

You do not write SQL and you cannot read the database. You emit a plan; a
compiler decides whether it may run, resolves every key against the process
definition, and refuses anything it does not recognise.

Rules:
- Use only the state keys, field keys, task keys, approval keys and email
  template keys given to you. Never invent one. If the question needs
  something that does not exist, say so in "reading" and emit the closest
  plan you can that does compile.
- "Overdue", "late" and "past due" mean the { "kind": "overdue", "is": true }
  filter. It uses the SLA declared on each state; do not try to express it as
  an hours comparison unless the operator names a number of hours.
- Fields marked restricted cannot be filtered on. If the question asks you to,
  say why in "reading" and leave that filter out.
- Only add "action" when the operator asked for something to be DONE. A
  question that merely asks what is true gets a query and no action.
- A reminder can only name an existing email template. You cannot write the
  message; the template decides the wording and who receives it.
- "assign" hands an open task to someone: "to" is the email address the
  operator gave, or "role:<role key>". Never guess an address; if the
  operator did not give one, say so in "reading" and leave the action out.
- "change_state" moves records to a state using the process's own manual
  steps. Use it only when the operator asked to move, close or advance
  records, and only with a state key given to you.
- "set_answer" sets one field to one value. Use it only when the operator
  gave the exact value; never infer or invent one. Dates are YYYY-MM-DD,
  numbers are numbers, yes/no is true or false. For a multi-choice field,
  "mode": "add" or "remove" with one option's value adds or removes just that
  option; "mode": "set" with a list replaces the whole answer.
- "reading" is one sentence, in plain words, telling the operator what you
  understood. It is shown to them before anything runs, so it should name the
  filters in their language, not yours.`;

function userTurn(question: string, context: PlanContext): string {
  const line = <T,>(items: T[], f: (item: T) => string) => items.map(f).join('\n') || '  (none)';
  return `Process: ${context.processName} (${context.processKey})

States:
${line(context.states, (s) => `  ${s.key} — ${s.name} (${s.type}${s.slaHours ? `, late after ${s.slaHours}h` : ''})`)}

Fields:
${line(context.fields, (f) => `  ${f.key} — ${f.label} (${f.type}, ${f.classification})`)}

Tasks:
${line(context.tasks, (t) => `  ${t.key} — ${t.name}`)}

Approvals:
${line(context.approvals, (a) => `  ${a.key} — ${a.name}`)}

Email templates:
${line(context.templates, (t) => `  ${t.key} — ${t.name}, to ${t.to}`)}

The operator asks:
${JSON.stringify(question)}

Return one JSON object matching the schema. Nothing else.`;
}

/**
 * Wraps one of the blueprint generation providers as an Asker.
 *
 * Reuses `src/ai` rather than adding a second provider abstraction: the two
 * jobs differ in the schema they target, not in how a model is called.
 */
export function askerFor(provider: Provider): Asker {
  return {
    name: provider.name,
    model: provider.model,
    promptVersion: COPILOT_PROMPT_VERSION,

    async propose(question, context) {
      const schema = zodToJsonSchema(Proposal, { target: 'openApi3' }) as Record<string, unknown>;
      const out = await provider.generate({
        // `description` is what the provider logs as the customer's words. The
        // question is exactly that, and it is untrusted in the same way.
        description: question,
        system: SYSTEM,
        user: userTurn(question, context),
        schema,
      });

      if (out.meta.refusal) throw new Error(`the model declined: ${out.meta.refusal}`);

      const raw = out.parsed ?? extractJson(out.text);
      if (!raw) throw new Error('the model did not return JSON');

      // Re-validated here and again in the runtime. Structured output is a
      // request, not a guarantee, and §7.3 is explicit that model output is
      // untrusted input.
      const parsed = Proposal.safeParse(raw);
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        throw new Error(`the plan did not match the schema at ${first?.path.join('.') || '(root)'}: ${first?.message}`);
      }

      return { proposal: parsed.data, inputTokens: out.meta.inputTokens, outputTokens: out.meta.outputTokens };
    },
  };
}
