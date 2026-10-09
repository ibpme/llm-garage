import { Type } from "typebox";

// Schema
const QuestionOptionSchema = Type.Object({
  value: Type.String({ description: "Returned value" }),
  label: Type.String({ description: "Shown text" }),
  description: Type.Optional(Type.String({ description: "Optional detail" })),
});

const QuestionSchema = Type.Object({
  id: Type.String({ minLength: 1, description: "Unique ID" }),
  label: Type.Optional(Type.String({ description: "Short tab label" })),
  prompt: Type.String({ description: "Question text" }),
  options: Type.Array(QuestionOptionSchema),
  multiSelect: Type.Optional(Type.Boolean({ description: "Allow multiple" })),
});

export const QuestionnaireParams = Type.Object({
  questions: Type.Array(QuestionSchema, { minItems: 1 }),
});
