import assert from "node:assert/strict";
import { test } from "node:test";
import { serializeContext } from "./context.ts";

test("context truncation keeps the first user goal and newest turns", () => {
  const text = serializeContext([
    { role: "user", text: "ORIGINAL GOAL" },
    ...Array.from({ length: 10 }, () => ({ role: "assistant" as const, text: "x".repeat(4000) })),
    { role: "user", text: "LATEST USER REQUEST" },
    { role: "assistant", text: "LATEST RESULT" },
  ]);
  assert.ok(text.includes("ORIGINAL GOAL"));
  assert.ok(text.includes("LATEST USER REQUEST"));
  assert.ok(text.includes("LATEST RESULT"));
  assert.ok(text.includes("truncated"));
  assert.ok(text.length <= 24_000);
});
