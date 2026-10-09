import assert from "node:assert/strict";
import { test } from "node:test";
import { formatAnswers, parseAnswers, parseQuestions } from "./model.ts";

test("question parsing validates input and supplies defaults", () => {
  assert.equal(parseQuestions([]), undefined);
  assert.equal(parseQuestions([{ id: "q", prompt: "Pick", options: [{ value: 1, label: "One" }] }]), undefined);
  const questions = parseQuestions([{ id: "q", prompt: "Pick", options: [{ value: "one", label: "One" }] }])!;
  assert.equal(questions[0].label, "Q1");
  assert.equal(questions[0].multiSelect, false);
  const answers = parseAnswers([{
    id: "q", values: [
      { value: "one", label: "One", wasCustom: false, index: 1 }, null,
    ]
  }]);
  assert.equal(answers[0].values.length, 1);
  assert.equal(formatAnswers(questions, answers), 'Q1: 1. One [value: "one"]');
});
