import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveBackend } from "./backend.ts";

const parent = { model: { id: "parent-model", provider: "parent-provider" }, thinkingLevel: "high" };
test("Pi inherits existing defaults and effort aliases thinking", () => {
  assert.deepEqual(resolveBackend({}, parent), { agent: "pi", model: "parent-model", provider: "parent-provider", thinking: "high", effort: undefined });
  assert.equal(resolveBackend({ effort: "max" }, parent).thinking, "max");
  assert.equal(resolveBackend({ model: "sonnet:low" }, parent).thinking, undefined);
  assert.throws(() => resolveBackend({ provider: "provider" }), /explicit model/);
});
test("Claude does not inherit Pi model/provider/thinking and ignores provider even without model", () => {
  assert.deepEqual(resolveBackend({ agent: "claude", provider: "ignored" }, parent), { agent: "claude", model: undefined, provider: undefined, thinking: undefined, effort: undefined });
});
test("Claude model suffix is separated from effort with explicit level taking precedence", () => {
  for (const effort of ["low", "medium", "high", "xhigh", "max"] as const) {
    const resolved = resolveBackend({ agent: "claude", model: `sonnet:${effort}` });
    assert.equal(resolved.model, "sonnet");
    assert.equal(resolved.effort, effort);
    assert.equal(resolveBackend({ agent: "claude", thinking: effort }).effort, effort);
  }
  assert.equal(resolveBackend({ agent: "claude", model: "opus:low", effort: "high" }).effort, "high");
  assert.equal(resolveBackend({ agent: "claude", model: "claude-sonnet-4-6", effort: "medium" }).model, "claude-sonnet-4-6");
});
test("ambiguous aliases and inexact Claude reasoning levels are rejected", () => {
  assert.throws(() => resolveBackend({ thinking: "low", effort: "high" }), /must agree/);
  for (const thinking of ["off", "minimal"]) {
    assert.throws(() => resolveBackend({ agent: "claude", thinking }), /no exact equivalent/);
    assert.throws(() => resolveBackend({ agent: "claude", model: `sonnet:${thinking}` }), /no exact equivalent/);
  }
});
