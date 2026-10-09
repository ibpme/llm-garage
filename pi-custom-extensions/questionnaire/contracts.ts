

// Types
export type QuestionOption = {
  value: string;
  label: string;
  description?: string;
};

export type RenderOption = QuestionOption & {
  isOther?: boolean;
  isDone?: boolean;
  isSelected?: boolean;
};

// Type aliases, not interfaces: pi's JSON-typed `details` rejects interfaces, which lack an index signature.
export type Question = {
  id: string;
  label: string;
  prompt: string;
  options: QuestionOption[];
  multiSelect: boolean;
};

export type AnswerValue = {
  value: string;
  label: string;
  wasCustom: boolean;
  index?: number;
};

export type Answer = {
  id: string;
  values: AnswerValue[];
};

export type QuestionnaireResult = {
  questions: Question[];
  answers: Answer[];
  cancelled: boolean;
};

export interface ReanswerCandidate {
  resultEntryId: string;
  toolCallId: string;
  questions: Question[];
  previousAnswers: Answer[];
}

export interface ReanswerMessageDetails {
  toolCallId: string;
  result: QuestionnaireResult;
}
