import assert from "node:assert/strict";
import { test } from "node:test";
import { mergedIntervalDuration } from "./accounting.ts";

test("parallel tool durations are merged rather than double-counted", () => {
  assert.equal(mergedIntervalDuration([]), 0);
  assert.equal(mergedIntervalDuration([
    { startOffsetMs: 10, endOffsetMs: 30 },
    { startOffsetMs: 0, endOffsetMs: 20 },
    { startOffsetMs: 50, endOffsetMs: 40 },
    { startOffsetMs: 5, endOffsetMs: 8 },
  ]), 40);
  assert.equal(mergedIntervalDuration([
    { startOffsetMs: 0, endOffsetMs: 10 },
    { startOffsetMs: 10, endOffsetMs: 20 },
  ]), 20);
});
