import type { Blueprint } from '../blueprint/index.js';
import type { Diagnostic } from '../compiler/diagnostics.js';

/** Checks promises in the request that the blueprint schema cannot infer. */
export function qualityDiagnostics(bp: Blueprint, description: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  /*
   * A scored quiz is a form that ASKS questions and marks them. A description
   * that records assessment results — "pre-training score", "pass/fail
   * result", "passing score" — mentions scores and assessments without wanting
   * a single question written, and this rule used to demand quiz questions of
   * it anyway, an error no model could repair. So the rule now needs the
   * description to ask for questions: a count of them, an answer key, or
   * multiple choice.
   */
  const scoredQuiz = /\b(quiz|exam|test|assessment)s?\b/i.test(description) &&
    /\b(scor\w*|grad\w*|correct answers?|percent\w*)\b/i.test(description) &&
    /\b(\d{1,2}|two|three|four|five|six|seven|eight|nine|ten|twelve|fifteen|twenty)[ -]+(?:multiple[ -]choice\s+|short\s+)?questions?\b|\banswer keys?\b|\bcorrect answers?\b|\bmultiple[ -]choice\b/i.test(description);
  if (!scoredQuiz) return diagnostics;

  const permitsRetakes = bp.intent.assumptions?.some(({ statement }) =>
    /\b(retakes?|repeat attempts?|multiple times|each submission is a separate record)\b/i.test(statement));
  if (permitsRetakes && bp.data.identity?.length) {
    diagnostics.push({ code: 'AIQ007', severity: 'error', at: 'data.identity',
      message: 'The quiz says participants may retake it, but its identity fields discard a repeat submission.',
      fix: 'Clear data.identity for independent attempts, or explicitly change the quiz policy and duplicate scenario to one attempt per identity.' });
  }

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

  const placeholders = questions.filter(({ field }) =>
    /^\s*(?:question|item)\s*\d+\s*$/i.test(field.label) ||
    (field.choices?.length === 4 && field.choices.every((choice) => /^[A-D]$/i.test(choice.label.trim()))));
  if (placeholders.length) {
    diagnostics.push({ code: 'AIQ008', severity: 'error', at: `data.fields[${placeholders[0]!.index}]`,
      message: `${placeholders.length} assessment question(s) still use placeholder wording or A–D instead of real answer choices.`,
      fix: 'Write the full subject-specific question and four meaningful answer labels for every placeholder. Each must have one correctValue.' });
  }

  const requestedCount = description.match(/\b(\d{1,2})[ -]+(?:multiple[ -]choice\s+)?questions?\b/i);
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
    if (/\b(?:missed|incorrect|wrong)\b.{0,90}\bexplanations?\b|\bexplanations?\b.{0,90}\b(?:missed|incorrect|wrong)\b/i.test(description) &&
      !field.answerExplanation) {
      diagnostics.push({ code: 'AIQ009', severity: 'error', at: `data.fields[${index}].answerExplanation`,
        message: `Quiz question "${field.label}" has no explanation for an incorrect answer.`,
        fix: 'Set answerExplanation to a brief reason the keyed answer is correct.' });
    }
  }

  if (/\b(?:percentage|score)\b.{0,60}\bgrade\b|\bgrade\b.{0,60}\b(?:percentage|score)\b/i.test(description) &&
    !bp.experience.quizResult?.showLetterGrade) {
    diagnostics.push({ code: 'AIQ010', severity: 'error', at: 'experience.quizResult',
      message: 'The request asks for a grade, but the result screen is not set to show one.',
      fix: 'Set experience.quizResult.showLetterGrade to true. The server calculates A–F from the final percentage.' });
  }

  for (const { field, index } of bp.data.fields.map((field, index) => ({ field, index }))) {
    if ((/^(score|percentage|percent|grade|missed_questions|answer_review)$/.test(field.key) &&
      (field.type === 'calculated' || field.setBy === 'system')) ||
      (/^q\d+_correct_answer$/.test(field.key) && field.type === 'hidden')) {
      diagnostics.push({ code: 'AIQ004', severity: 'error', at: `data.fields[${index}]`,
        message: `"${field.label}" is a placeholder for a quiz result the runtime already calculates.`,
        fix: 'Remove this field and its references. Put correctValue and answerExplanation on each real question; the runtime produces the score, percentage, grade and missed-answer review.' });
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
