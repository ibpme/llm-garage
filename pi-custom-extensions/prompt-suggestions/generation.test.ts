import assert from "node:assert/strict";
import { test } from "node:test";
import { buildUserPrompt, validateSuggestion } from "./generation.ts";

test("suggestions normalize harmless formatting and reject invalid replies", () => {
  assert.equal(validateSuggestion('Suggestion: "Run the tests."', null), "Run the tests.");
  for (const value of [null, "", "NO_SUGGESTION", "Would you like me to run tests?", "x".repeat(241), "Run\u0000tests"]) {
    assert.equal(validateSuggestion(value, null), null);
  }
  assert.equal(validateSuggestion("Run the tests.", "Run the tests."), null);
  assert.ok(buildUserPrompt("Latest turn").includes("Latest turn"));
});
