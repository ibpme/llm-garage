import type { Answer, AnswerValue, Question, QuestionOption } from "./contracts.ts";

export function parseQuestions(value: unknown): Question[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;

  const questions: Question[] = [];
  for (let i = 0; i < value.length; i++) {
    const candidate = value[i];
    if (!candidate || typeof candidate !== "object") return undefined;

    const raw = candidate as Record<string, unknown>;
    if (
      typeof raw.id !== "string" ||
      raw.id.length === 0 ||
      typeof raw.prompt !== "string" ||
      !Array.isArray(raw.options)
    ) {
      return undefined;
    }

    const options: QuestionOption[] = [];
    for (const option of raw.options) {
      if (!option || typeof option !== "object") return undefined;
      const optionRaw = option as Record<string, unknown>;
      if (
        typeof optionRaw.value !== "string" ||
        typeof optionRaw.label !== "string" ||
        (optionRaw.description !== undefined &&
          typeof optionRaw.description !== "string")
      ) {
        return undefined;
      }
      options.push({
        value: optionRaw.value,
        label: optionRaw.label,
        ...(optionRaw.description === undefined
          ? {}
          : { description: optionRaw.description }),
      });
    }

    questions.push({
      id: raw.id,
      label:
        typeof raw.label === "string" && raw.label.length > 0
          ? raw.label
          : `Q${i + 1}`,
      prompt: raw.prompt,
      options,
      multiSelect: raw.multiSelect === true,
    });
  }

  return questions;
}

export function parseAnswers(value: unknown): Answer[] {
  if (!Array.isArray(value)) return [];

  const answers: Answer[] = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object") continue;
    const raw = candidate as Record<string, unknown>;
    if (typeof raw.id !== "string" || !Array.isArray(raw.values)) continue;

    const values: AnswerValue[] = [];
    for (const answerValue of raw.values) {
      if (!answerValue || typeof answerValue !== "object") continue;
      const answerRaw = answerValue as Record<string, unknown>;
      if (
        typeof answerRaw.value !== "string" ||
        typeof answerRaw.label !== "string" ||
        typeof answerRaw.wasCustom !== "boolean"
      ) {
        continue;
      }
      values.push({
        value: answerRaw.value,
        label: answerRaw.label,
        wasCustom: answerRaw.wasCustom,
        ...(typeof answerRaw.index === "number"
          ? { index: answerRaw.index }
          : {}),
      });
    }
    if (values.length > 0) answers.push({ id: raw.id, values });
  }

  return answers;
}

export function formatAnswers(questions: Question[], answers: Answer[]): string {
  return answers
    .map((answer) => {
      const questionLabel =
        questions.find((question) => question.id === answer.id)?.label ||
        answer.id;
      const values = answer.values.map((value) => {
        if (value.wasCustom) {
          return `(wrote) ${value.label} [value: ${JSON.stringify(value.value)}]`;
        }
        return `${value.index}. ${value.label} [value: ${JSON.stringify(value.value)}]`;
      });
      return `${questionLabel}: ${values.join(", ")}`;
    })
    .join("\n");
}
