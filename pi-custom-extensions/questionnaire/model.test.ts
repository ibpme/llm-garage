import assert from "node:assert/strict";
import { test } from "node:test";
import type { Answer, Question } from "./contracts.ts";
import { formatAnswers, parseAnswers, parseQuestions } from "./model.ts";

test("an empty questionnaire is rejected", () => {
  assert.equal(parseQuestions([]), undefined);
});

test("question options require string values", () => {
  assert.equal(parseQuestions([{ id: "q", prompt: "Pick", options: [{ value: 1, label: "One" }] }]), undefined);
});

test("questions without display settings receive a label and single-selection default", () => {
  assert.deepEqual(parseQuestions([{ id: "q", prompt: "Pick", options: [{ value: "one", label: "One" }] }]), [{
    id: "q", prompt: "Pick", label: "Q1", multiSelect: false,
    options: [{ value: "one", label: "One" }],
  }]);
});

test("malformed answer values are discarded without losing valid selections", () => {
  assert.deepEqual(parseAnswers([{
    id: "q", values: [{ value: "one", label: "One", wasCustom: false, index: 1 }, null],
  }]), [{ id: "q", values: [{ value: "one", label: "One", wasCustom: false, index: 1 }] }]);
});

test("formatted answers identify the question and the selected option", () => {
  const questions: Question[] = [{
    id: "q", label: "Q1", prompt: "Pick", multiSelect: false,
    options: [{ value: "one", label: "One" }],
  }];
  const answers: Answer[] = [{
    id: "q", values: [{ value: "one", label: "One", wasCustom: false, index: 1 }],
  }];
  assert.equal(formatAnswers(questions, answers), 'Q1: 1. One [value: "one"]');
});
