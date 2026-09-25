import type { Field } from '../blueprint/index.js';

export interface QuizResult {
  correct: number;
  total: number;
  percentage: number;
  grade?: string;
  missed: { question: string; correctAnswer: string; explanation?: string }[];
}

/** Score only declared answer keys, after submission has passed validation. */
export function scoreQuiz(fields: Field[], answers: Record<string, unknown>, showLetterGrade = false): QuizResult | undefined {
  const questions = fields.filter((field) => field.correctValue !== undefined);
  if (!questions.length) return undefined;
  let correct = 0;
  const missed: QuizResult['missed'] = [];
  for (const question of questions) {
    if (answers[question.key] === question.correctValue) {
      correct++;
    } else {
      missed.push({
        question: question.label,
        correctAnswer: question.choices?.find((choice) => choice.value === question.correctValue)?.label ?? '',
        ...(question.answerExplanation ? { explanation: question.answerExplanation } : {}),
      });
    }
  }
  const percentage = Math.round((100 * correct) / questions.length);
  const grade = percentage >= 90 ? 'A' : percentage >= 80 ? 'B' : percentage >= 70 ? 'C' : percentage >= 60 ? 'D' : 'F';
  return { correct, total: questions.length, percentage, ...(showLetterGrade ? { grade } : {}), missed };
}
