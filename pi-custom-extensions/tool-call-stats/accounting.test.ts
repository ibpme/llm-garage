import assert from "node:assert/strict";
import { test } from "node:test";
import { mergedIntervalDuration } from "./accounting.ts";

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
