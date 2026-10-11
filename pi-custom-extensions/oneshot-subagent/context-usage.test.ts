import assert from "node:assert/strict";
import { test } from "node:test";
import { contextSegment, formatTokens } from "./context-usage.ts";
import type { LatestCallUsage } from "./events.ts";

const call = (input: number, output = 0, cacheRead = 0, cacheWrite = 0): LatestCallUsage => ({ input, output, cacheRead, cacheWrite });

test("snapshot is the latest call's input plus cache reads and writes, never output", () => {
  assert.deepEqual(contextSegment({ latestCallUsage: call(10_000, 999_999, 20_000, 4_200), contextWindow: 200_000 }),
    { text: "context 34.2k / 200k · 17%", tone: "dim" });
});

test("no completed call omits the segment entirely", () => {
  assert.equal(contextSegment({ contextWindow: 200_000 }), undefined);
});

test("a completed call with zero usage is a real zero snapshot, not missing", () => {
  assert.deepEqual(contextSegment({ latestCallUsage: call(0), contextWindow: 200_000 }),
    { text: "context 0 / 200k · 0%", tone: "dim" });
});

test("unverified capacity shows unknown without a percentage or warning, however large the snapshot", () => {
  assert.deepEqual(contextSegment({ latestCallUsage: call(34_200) }), { text: "context 34.2k / unknown", tone: "dim" });
  assert.deepEqual(contextSegment({ latestCallUsage: call(999_999) }), { text: "context 1M / unknown", tone: "dim" });
  for (const contextWindow of [0, -1, Number.NaN, Number.POSITIVE_INFINITY])
    assert.deepEqual(contextSegment({ latestCallUsage: call(34_200), contextWindow }), { text: "context 34.2k / unknown", tone: "dim" }, String(contextWindow));
});

test("warning begins at exactly 70% and error at exactly 90% of verified capacity", () => {
  const at = (used: number) => contextSegment({ latestCallUsage: call(used), contextWindow: 200_000 });
  assert.deepEqual(at(139_999), { text: "context 140k / 200k · 69%", tone: "dim" });
  assert.deepEqual(at(140_000), { text: "context 140k / 200k · 70%", tone: "warning" });
  assert.deepEqual(at(179_999), { text: "context 180k / 200k · 89%", tone: "warning" });
  assert.deepEqual(at(180_000), { text: "context 180k / 200k · 90%", tone: "error" });
  assert.deepEqual(at(250_000), { text: "context 250k / 200k · 125%", tone: "error" });
});

test("the snapshot sums input and both cache kinds when deciding the tone", () => {
  const split = contextSegment({ latestCallUsage: call(100_000, 0, 30_000, 10_000), contextWindow: 200_000 });
  assert.deepEqual(split, { text: "context 140k / 200k · 70%", tone: "warning" });
});

test("formatTokens uses compact units with one decimal and drops a trailing .0", () => {
  const cases: Array<[number, string]> = [[0, "0"], [999, "999"], [1_000, "1k"], [1_234, "1.2k"], [34_213, "34.2k"],
    [200_000, "200k"], [999_949, "999.9k"], [999_950, "1M"], [1_234_567, "1.2M"], [1_500_000, "1.5M"]];
  for (const [value, text] of cases) assert.equal(formatTokens(value), text, String(value));
});
