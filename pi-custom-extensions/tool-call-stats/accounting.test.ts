import assert from "node:assert/strict";
import { test } from "node:test";
import type { PersistedCycle } from "./contracts.ts";
import { cycleTps, mergedIntervalDuration, sumUsage } from "./accounting.ts";

test("no tool intervals contribute zero wall time", () => {
  assert.equal(mergedIntervalDuration([]), 0);
});

test("overlapping parallel tools contribute their combined wall time only once", () => {
  assert.equal(mergedIntervalDuration([
    { startOffsetMs: 10, endOffsetMs: 30 },
    { startOffsetMs: 0, endOffsetMs: 20 },
    { startOffsetMs: 5, endOffsetMs: 8 },
  ]), 30);
});

test("reversed interval endpoints still contribute positive elapsed time", () => {
  assert.equal(mergedIntervalDuration([{ startOffsetMs: 50, endOffsetMs: 40 }]), 10);
});

test("gaps between tool intervals do not contribute to tool wall time", () => {
  assert.equal(mergedIntervalDuration([
    { startOffsetMs: 0, endOffsetMs: 30 },
    { startOffsetMs: 40, endOffsetMs: 50 },
  ]), 40);
});

test("adjacent tool intervals contribute their full wall time", () => {
  assert.equal(mergedIntervalDuration([
    { startOffsetMs: 0, endOffsetMs: 10 },
    { startOffsetMs: 10, endOffsetMs: 20 },
  ]), 20);
});

test("cycle throughput weights response output tokens by measured generation time", () => {
  const cycle = {
    version: 1, turnIndex: 0, startedAt: 0, providerAttempts: 2, outputTokens: 100,
    elapsedMs: 0, toolWallMs: 0, toolSumMs: 0, overheadMs: 0, tools: [],
    responses: [
      { outputTokens: 10, generationMs: 1000, ttftMs: 100 },
      { outputTokens: 30, generationMs: 3000, ttftMs: 200 },
    ],
  } as PersistedCycle;
  assert.equal(cycleTps(cycle), 10);
});

test("sumUsage ignores legacy cycles without usage and adds the rest", () => {
  const usage = { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, totalTokens: 18, costTotal: 0.5 };
  const base = { version: 1, turnIndex: 0, startedAt: 0, providerAttempts: 1, outputTokens: 5, elapsedMs: 0, toolWallMs: 0, toolSumMs: 0, overheadMs: 0, tools: [] } as const;
  const total = sumUsage([{ ...base, usage }, { ...base }, { ...base, usage }] as never);
  assert.deepEqual(total, { input: 20, output: 10, cacheRead: 4, cacheWrite: 2, totalTokens: 36, costTotal: 1 });
});

test("sumUsage totals reasoning tokens only from cycles that report them", () => {
  const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, costTotal: 0 };
  const base = { version: 1, turnIndex: 0, startedAt: 0, providerAttempts: 1, outputTokens: 1, elapsedMs: 0, toolWallMs: 0, toolSumMs: 0, overheadMs: 0, tools: [] } as const;
  assert.equal(sumUsage([{ ...base, usage }] as never).reasoning, undefined);
  assert.equal(sumUsage([{ ...base, usage: { ...usage, reasoning: 40 } }, { ...base, usage: { ...usage, reasoning: 2 } }] as never).reasoning, 42);
});
