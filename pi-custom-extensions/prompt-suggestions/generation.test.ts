import assert from "node:assert/strict";
import { test } from "node:test";
import { buildUserPrompt, validateSuggestion } from "./generation.ts";

test("suggestions normalize labels and wrapping quotes", () => {
  assert.equal(validateSuggestion('Suggestion: "Run the tests."', null), "Run the tests.");
});

for (const [name, value] of [
  ["non-text responses", null],
  ["empty responses", ""],
  ["the no-suggestion sentinel", "NO_SUGGESTION"],
  ["assistant-voiced offers", "Would you like me to run tests?"],
  ["responses longer than 240 characters", "x".repeat(241)],
  ["embedded control characters", "Run\u0000tests"],
] as const) {
  test(`suggestions reject ${name}`, () => {
    assert.equal(validateSuggestion(value, null), null);
  });
}

test("suggestions do not repeat the previous suggestion", () => {
  assert.equal(validateSuggestion("Run the tests.", "Run the tests."), null);
});

test("the generation prompt includes the supplied conversation", () => {
  assert.ok(buildUserPrompt("Latest turn").includes("<conversation>\nLatest turn\n</conversation>"));
});
