import type { Blueprint } from '../blueprint/index.js';
import type { Diagnostic } from '../compiler/diagnostics.js';

/** Checks promises in the request that the blueprint schema cannot infer. */
export function qualityDiagnostics(bp: Blueprint, description: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const scoredQuiz = /\b(quiz|exam|test)\b/i.test(description) &&
    /\b(scor\w*|grad\w*|correct answers?|percent\w*)\b/i.test(description);
  if (!scoredQuiz) return diagnostics;

  const questions = bp.data.fields.map((field, index) => ({ field, index })).filter(({ field }) =>
    (field.type === 'single_choice' || field.type === 'dropdown') &&
    (field.setBy ?? 'respondent') === 'respondent' &&
    (/^\s*\d+[.)\s]/.test(field.label) || /^q\d+(?:_|$)/i.test(field.key) || field.label.includes('?')),
  );
  if (!questions.length) {
    diagnostics.push({ code: 'AIQ001', severity: 'error', at: 'data.fields',
      message: 'The requested scored quiz has no answerable choice questions.',
      fix: 'Add the requested single-choice questions, each with its choices and correctValue.' });
    return diagnostics;
  }

  const requestedCount = description.match(/\b(\d{1,2})\s+(?:multiple[ -]choice\s+)?questions?\b/i);
  if (requestedCount && questions.length !== Number(requestedCount[1])) {
    diagnostics.push({ code: 'AIQ002', severity: 'error', at: 'data.fields',
      message: `The request asks for ${requestedCount[1]} quiz questions, but the draft has ${questions.length}.`,
      fix: `Create exactly ${requestedCount[1]} questions and update the sample scenarios.` });
  }
  const optionCount = description.match(/\b(?:each\s+question|questions?)\b[^.!?]{0,100}?\b(four|4)\s+(?:answer\s+)?options?\b/i);
  if (optionCount) {
    for (const { field, index } of questions) {
      if (field.choices?.length !== 4) {
        diagnostics.push({ code: 'AIQ006', severity: 'error', at: `data.fields[${index}].choices`,
          message: `"${field.label}" has ${field.choices?.length ?? 0} options; the request specifies four per question.`,
          fix: 'Give this question exactly four distinct choices and mark its correct answer.' });
      }
    }
  }
  for (const { field, index } of questions) {
    if (field.correctValue === undefined) {
      diagnostics.push({ code: 'AIQ003', severity: 'error', at: `data.fields[${index}].correctValue`,
        message: `Quiz question "${field.label}" has no correct answer.`,
        fix: 'Set correctValue to the value of exactly one choice. Do not guess from a sample submission.' });
    }
  }

  for (const { field, index } of bp.data.fields.map((field, index) => ({ field, index }))) {
    if (/^(score|percentage|percent|missed_questions|answer_review)$/.test(field.key) &&
      (field.type === 'calculated' || field.setBy === 'system')) {
      diagnostics.push({ code: 'AIQ004', severity: 'error', at: `data.fields[${index}]`,
        message: `"${field.label}" is a placeholder for a quiz result the runtime already calculates.`,
        fix: 'Remove the placeholder field and its references. The answer keys produce the score, percentage and missed-answer review after submission.' });
    }
  }

  const initial = bp.workflow.states.find((state) => state.type === 'initial');
  const completion = bp.intent.completionState;
  for (const [index, transition] of bp.workflow.transitions.entries()) {
    if (transition.trigger.on !== 'submission' || transition.from !== initial?.key) continue;
    const next = bp.workflow.states.find((state) => state.key === transition.to);
    if (!next || next.type === 'terminal') continue;
    const exits = bp.workflow.transitions.filter((item) => item.from === next.key);
    if (exits.length === 1 && exits[0]!.trigger.on === 'record_updated' && exits[0]!.to === completion) {
      diagnostics.push({ code: 'AIQ005', severity: 'error', at: `workflow.transitions[${index}]`,
        message: `The quiz enters "${next.name}" but waits for a later edit before showing results.`,
        fix: 'Move directly from submission to the success state. Quiz scoring happens automatically after a valid submission.' });
    }
  }
  return diagnostics;
}
