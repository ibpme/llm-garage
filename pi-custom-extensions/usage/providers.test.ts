import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCodex, parseOpenCodeGo, safeText, verifyAppRegistration, windowDuration } from "./providers.ts";
import { countdown, formatUsage, renderUsage, usageBar } from "./formatting.ts";

test("OpenCode Go preserves percentages, reset times, and rate-limited windows", () => {
  const report = parseOpenCodeGo({ usage: {
    rolling: { status: "ok", percent: 0, resetsAt: "2030-01-01T00:00:00Z" },
    weekly: { status: "rate-limited", percent: 100, resetsAt: "invalid" },
    monthly: { status: "ok", percent: 32.55, resetsAt: "2030-02-01T00:00:00Z" },
  } });
  assert.equal(report.windows[0].usedPercent, 0);
  assert.equal(report.windows[0].resetsAt, Date.parse("2030-01-01T00:00:00Z"));
  assert.equal(report.windows[1].status, "rate-limited");
  assert.equal(report.windows[1].resetsAt, undefined);
  assert.equal(report.windows[2].usedPercent, 32.55);
});

test("OpenCode Go missing/unknown statuses are unavailable, never fabricated zeroes", () => {
  const report = parseOpenCodeGo({ usage: { rolling: { status: "new-status", percent: 0 } } });
  assert.ok(report.windows.every((window) => window.usedPercent === undefined && window.note));
  assert.throws(() => parseOpenCodeGo({}), /unrecognized/);
});

test("malformed percentages cannot appear as valid quota", () => {
  for (const used of [-1, 101, NaN, Infinity, "5", null]) {
    const go = parseOpenCodeGo({ usage: { rolling: { status: "ok", percent: used } } });
    assert.equal(go.windows[0].usedPercent, undefined);
    const codex = parseCodex({ rate_limit: { primary_window: { used_percent: used } } });
    assert.equal(codex.windows[0].usedPercent, undefined);
  }
});

test("Codex uses returned window durations and epoch-second resets, not fixed labels", () => {
  const report = parseCodex({
    plan_type: "plus", rate_limit: {
      primary_window: { used_percent: 25, limit_window_seconds: 10800, reset_at: 1893456000 },
      secondary_window: { used_percent: 80, limit_window_seconds: 604800, reset_at: 1894060800 },
    },
    code_review_rate_limit: { primary_window: { used_percent: 5, limit_window_seconds: 604800 } },
    credits: { balance: "12.50" },
  });
  assert.deepEqual(report.windows.map((row) => row.label), ["3h", "7d", "Code review · 7d"]);
  assert.equal(report.windows[0].resetsAt, 1893456000000);
  assert.equal(report.plan, "plus");
  assert.match(report.notes[0], /12.50/);
});

test("Codex allows an absent secondary window, rejects absent quota data", () => {
  assert.equal(parseCodex({ rate_limit: { primary_window: { used_percent: 0 }, secondary_window: null } }).windows.length, 1);
  for (const data of [null, {}, { rate_limit: {} }]) assert.throws(() => parseCodex(data), /no recognizable/);
});

test("Codex invalid reset timestamps are unavailable and server block flags remain visible", () => {
  for (const reset_at of [-1, Infinity, 1.5, 8.64e12 + 1, "1000"]) {
    const report = parseCodex({ rate_limit: { allowed: false, primary_window: { used_percent: 20, reset_at } } });
    assert.equal(report.windows[0].resetsAt, undefined);
    assert.match(report.notes[0], /not allowed/);
  }
});

test("native companion app registration must be complete and uniquely match", () => {
  verifyAppRegistration({ items: [{ id: "other" }, { id: "pi-app" }] }, "pi-app");
  for (const payload of [
    {}, { items: [] }, { items: [{ id: "other" }] },
    { items: [{ id: "pi-app" }, { id: "pi-app" }] },
    { items: [{ id: "pi-app" }], next_cursor: "next" },
    { items: [{ id: "pi-app" }, {}] },
    { items: [{ id: "pi-app" }, { id: "" }] },
    { items: Array.from({ length: 129 }, (_, index) => ({ id: String(index) })) },
  ]) assert.throws(() => verifyAppRegistration(payload, "pi-app"), /registration/);
});

test("duration and countdown formatting handle boundaries", () => {
  assert.equal(windowDuration(18000, "Primary"), "5h");
  assert.equal(windowDuration(604800, "Primary"), "7d");
  assert.equal(windowDuration(90, "Primary"), "90s");
  assert.equal(windowDuration(null, "Primary"), "Primary");
  assert.equal(countdown(0), "reset time passed");
  assert.equal(countdown(1), "1m");
  assert.equal(countdown(3_599_999), "1h");
  assert.equal(countdown(90_000_000), "1d 1h");
});

test("report distinguishes account usage, unavailable values, remaining percentages, and stale resets", () => {
  const report = parseOpenCodeGo({ usage: { rolling: { status: "rate-limited", percent: 100, resetsAt: "2030-01-01T00:00:00Z" } } });
  const text = formatUsage([report], Date.parse("2030-01-02T00:00:00Z"));
  assert.match(text, /100% used · 0% left/);
  assert.match(text, /rate limited/);
  assert.match(text, /reset time passed/);
  assert.match(formatUsage([{ ...report, windows: [{ label: "Weekly", note: "Usage unavailable (missing or unknown window status)." }] }]), /Weekly +Usage unavailable/);
  assert.match(formatUsage([]), /No supported providers/);
});

test("usage bars keep a fixed width and take color from severity", () => {
  const tagged = { fg: (color: string, text: string) => `<${color}>${text}</>`, bold: (text: string) => text };
  assert.match(usageBar(10, tagged), /^<success>█▊<\/>/);
  assert.match(usageBar(70, tagged), /^<warning>/);
  assert.match(usageBar(90, tagged), /^<error>/);
  for (const used of [0, 0.5, 33.3, 99.9, 100]) {
    assert.equal(usageBar(used, { fg: (_c, text) => text, bold: (text) => text }).length, 18);
  }
});

test("styled report wraps long notes to the viewport and keeps one line per quota window", () => {
  const report = parseCodex({ plan_type: "plus", rate_limit: { primary_window: { used_percent: 42, limit_window_seconds: 18000 } } });
  const styled = { fg: (_color: string, text: string) => `\u001b[31m${text}\u001b[0m`, bold: (text: string) => text };
  const lines = renderUsage([{ ...report, notes: ["word ".repeat(60).trim()] }], { theme: styled, width: 80, now: 0 });
  assert.ok(lines.every((line) => line.replace(/\u001b\[[0-9;]*m/g, "").length <= 80));
  assert.equal(lines.filter((line) => line.includes("5h")).length, 1);
  assert.ok(lines.filter((line) => line.includes("ℹ") || line.startsWith("    ")).length >= 2);
  assert.match(lines.join("\n"), /\u001b\[31m/);
});

test("remote text cannot inject terminal escape sequences, newlines, or bidi controls", () => {
  assert.equal(safeText("pl\x1bus\n\u202e"), "plus");
  assert.equal(safeText("a".repeat(101))?.length, 100);
});
