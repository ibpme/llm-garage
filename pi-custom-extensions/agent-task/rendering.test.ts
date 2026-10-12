import assert from "node:assert/strict";
import { test } from "node:test";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { keyLabel, renderRun, stats } from "./rendering.ts";
import type { RunDetails } from "./events.ts";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;

initTheme("dark");
for (const status of ["running", "success", "error", "aborted"] as const) {
  for (const expanded of [false, true]) test(`${status} ${expanded ? "expanded" : "compact"} rendering fits narrow and wide terminals`, () => {
    const details: RunDetails = { name: "review", task: "Review 中文 😀", cwd: "/tmp/project", model: "provider/model", status,
      activity: ["→ read 中文.ts", "→ bash " + "long command ".repeat(50)], preview: "Streaming 中文 😀 preview",
      result: "## Final answer\n\n- Checked 中文 😀\n- " + "long text ".repeat(30),
      turns: 2, toolCalls: 3, durationMs: 1000, totalTokens: 1000, costUsd: 0.01, jobDir: "/tmp/job" };
    const component = renderRun(details, expanded, theme);
    for (const width of [1, 2, 3, 4, 10, 40, 80, 120]) {
      const lines = component.render(width);
      assert.ok(lines.every((line) => visibleWidth(line) <= width), `overflow at ${width}`);
      component.invalidate();
    }
    const lines = component.render(120).join("\n");
    assert.match(lines, new RegExp(status));
    if (expanded) assert.match(lines, /logs: \/tmp\/job/);
  });
}

test("old saved results with nested children render top-level only with a notice", () => {
  const legacy = { name: "child", task: "Parent task", cwd: "/tmp", status: "success", activity: [], preview: "", turns: 1, toolCalls: 1, durationMs: 1000,
    result: "Parent final answer", depth: 1, maxDepth: 2, childrenOmitted: 3, displayTruncated: true,
    children: [{ name: "grandchild", toolCallId: "nested-1", task: "Grandchild unique task", status: "success", result: "Grandchild final response",
      children: [{ name: "great", toolCallId: "nested-2" }] }] } as unknown as RunDetails;
  for (const expanded of [false, true]) {
    const component = renderRun(legacy, expanded, theme);
    for (const width of [1, 4, 40, 120]) assert.ok(component.render(width).every((line) => visibleWidth(line) <= width));
    const output = component.render(120).join("\n");
    assert.match(output, /nested runs: see job logs/);
    assert.match(output, /Parent final answer|Parent task/);
    assert.doesNotMatch(output, /Grandchild|depth/);
  }
  for (const children of [undefined, [], "garbage", null] as unknown[]) {
    const output = renderRun({ ...legacy, children, childrenOmitted: undefined } as unknown as RunDetails, true, theme).render(120).join("\n");
    assert.doesNotMatch(output, /nested runs/);
  }
});

const pi = { name: "review", task: "task", cwd: "/tmp", agent: "pi", status: "success", activity: [], preview: "", result: "answer",
  turns: 2, toolCalls: 3, durationMs: 1000 } as RunDetails;

test("Pi shows the latest call breakdown and never the cumulative total when it exists", () => {
  const details = { ...pi, latestCallUsage: { input: 2, output: 3, cacheRead: 1, cacheWrite: 3 }, totalTokens: 999, costUsd: 0.01 };
  assert.equal(stats(details), "1.0s · 2 turns · 3 tool calls · last call: ↓ 2 input · ↑ 3 output · cached 4 · context 6 / unknown · $0.0100");
});

test("Pi latest breakdown keeps zero counts and thousands separators", () => {
  assert.equal(stats({ ...pi, latestCallUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
    "1.0s · 2 turns · 3 tool calls · last call: ↓ 0 input · ↑ 0 output · cached 0 · context 0 / unknown");
  assert.equal(stats({ ...pi, latestCallUsage: { input: 1234, output: 56, cacheRead: 7000, cacheWrite: 890 } }),
    "1.0s · 2 turns · 3 tool calls · last call: ↓ 1,234 input · ↑ 56 output · cached 7,890 · context 9.1k / unknown");
});

test("Pi runs without a latest call do not fall back to cumulative totals", () => {
  for (const details of [{ ...pi, totalTokens: 999 }, { ...pi, totalTokens: 999, usagePartial: true }]) {
    const line = stats(details);
    assert.equal(line, "1.0s · 2 turns · 3 tool calls");
  }
});

test("Claude shows the latest call breakdown and never its cumulative total", () => {
  const claude = { ...pi, agent: "claude", latestCallUsage: { input: 2, output: 3, cacheRead: 1, cacheWrite: 3 }, totalTokens: 999 } as RunDetails;
  assert.equal(stats(claude), "1.0s · 2 turns · 3 tool calls · last call: ↓ 2 input · ↑ 3 output · cached 4 · context 6 / unknown");
  assert.equal(stats({ ...claude, usagePartial: true, costUsd: 0.01 }),
    "1.0s · 2 turns · 3 tool calls · last call: ↓ 2 input · ↑ 3 output · cached 4 · context 6 / unknown · $0.0100");
});

test("Claude runs without a completed call show no tokens, not terminal or streamed totals", () => {
  const claude = { ...pi, agent: "claude", totalTokens: 10 } as RunDetails;
  assert.equal(stats(claude), "1.0s · 2 turns · 3 tool calls");
  assert.equal(stats({ ...claude, usagePartial: true }), "1.0s · 2 turns · 3 tool calls");
});

test("legacy results without an agent discriminator keep their saved total", () => {
  const legacy = { ...pi, agent: undefined, totalTokens: 1234 } as RunDetails;
  assert.equal(stats(legacy), "1.0s · 2 turns · 3 tool calls · 1,234 tokens");
});

for (const status of ["running", "error"] as const) for (const expanded of [false, true]) test(`Pi ${status} ${expanded ? "expanded" : "compact"} latest-call rendering fits every width`, () => {
  const details = { ...pi, status, name: "review 中文", task: "Review 中文 😀", model: "provider/model", jobDir: "/tmp/job",
    activity: ["→ read 中文.ts"], preview: "Streaming 中文 😀", result: "## Final\n\n- " + "long text ".repeat(30),
    latestCallUsage: { input: 1234567, output: 89, cacheRead: 4, cacheWrite: 5 }, totalTokens: 999, costUsd: 0.01 } as RunDetails;
  const component = renderRun(details, expanded, theme);
  for (const width of [1, 2, 3, 4, 10, 40, 80, 120]) {
    assert.ok(component.render(width).every((line) => visibleWidth(line) <= width), `overflow at ${width}`);
    component.invalidate();
  }
  assert.match(component.render(120).join("\n"), /last call: ↓ 1,234,567 input · ↑ 89 output · cached 9/);
});

test("verified capacity adds a compact context segment after the last-call breakdown", () => {
  assert.equal(stats({ ...pi, latestCallUsage: { input: 1234, output: 56, cacheRead: 7000, cacheWrite: 890 }, contextWindow: 200_000, costUsd: 0.01 }),
    "1.0s · 2 turns · 3 tool calls · last call: ↓ 1,234 input · ↑ 56 output · cached 7,890 · context 9.1k / 200k · 4% · $0.0100");
});

const tagged = { fg: (color: string, text: string) => `[${color}:${text}]`, bold: (text: string) => text } as unknown as Theme;
const headerOf = (details: RunDetails) => renderRun(details, false, tagged).render(200).join("\n");

test("context segment keeps its own tone while the rest of the stats stay dim", () => {
  const base = { ...pi, latestCallUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, costUsd: 0.01 };
  const at = (input: number, contextWindow?: number) => headerOf({ ...base, latestCallUsage: { input, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow } as RunDetails);
  assert.match(at(139_999, 200_000), /\[dim:context 140k \/ 200k · 69%\]/);
  assert.match(at(140_000, 200_000), /\[warning:context 140k \/ 200k · 70%\]/);
  assert.match(at(179_999, 200_000), /\[warning:context 180k \/ 200k · 89%\]/);
  assert.match(at(180_000, 200_000), /\[error:context 180k \/ 200k · 90%\]/);
  assert.match(at(999_999), /\[dim:context 1M \/ unknown\]/);
  assert.doesNotMatch(at(999_999), /\[(warning|error):context/);
  const omitted = headerOf({ ...base, latestCallUsage: undefined, contextWindow: 200_000 } as RunDetails);
  assert.match(omitted, /\[dim:1\.0s\]/);
  assert.doesNotMatch(omitted, /context/);
});

test("warning and error tones ignore the cumulative total and the cost segment", () => {
  const details = { ...pi, latestCallUsage: { input: 1, output: 999_999, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_000_000, totalTokens: 1_000_000, costUsd: 0.5 } as RunDetails;
  const header = headerOf(details);
  assert.match(header, /\[dim:context 1 \/ 1M · 0%\]/);
  assert.match(header, /\[dim:\$0\.5000\]/);
  assert.doesNotMatch(header, /\[(warning|error):/);
});

for (const expanded of [false, true]) test(`context segment with verified capacity fits every width (${expanded ? "expanded" : "compact"})`, () => {
  const details = { ...pi, status: "success", name: "review 中文", task: "Review 中文 😀", model: "provider/model", jobDir: "/tmp/job",
    activity: ["→ read 中文.ts"], preview: "Streaming 中文 😀", result: "## Final\n\n- " + "long text ".repeat(30),
    latestCallUsage: { input: 1234567, output: 89, cacheRead: 4, cacheWrite: 5 }, contextWindow: 1_000_000, costUsd: 0.01 } as RunDetails;
  const component = renderRun(details, expanded, theme);
  for (const width of [1, 2, 3, 4, 10, 40, 80, 120]) {
    assert.ok(component.render(width).every((line) => visibleWidth(line) <= width), `overflow at ${width}`);
    component.invalidate();
  }
  assert.match(component.render(200).join("\n"), /context 1.2M \/ 1M · 123%/);
});

test("running foreground runs show the send-to-background hint once accepted, and only then", () => {
  assert.equal(keyLabel("shift+up"), "Shift+↑");
  assert.equal(keyLabel("ctrl+alt+b"), "Ctrl+Alt+B");
  const base: RunDetails = { name: "review", task: "Review", cwd: "/tmp", status: "running", activity: [], preview: "",
    turns: 0, toolCalls: 0, durationMs: 0, jobDir: "/tmp/job" };
  const text = (details: RunDetails, hint?: string) => renderRun(details, false, theme, hint).render(120).join("\n");
  assert.match(text(base, "Shift+↑"), /Shift\+↑ or \/agents → b: send to background/);
  assert.doesNotMatch(text({ ...base, jobDir: undefined }, "Shift+↑"), /send to background/, "not before the launch is acknowledged");
  assert.doesNotMatch(text({ ...base, status: "success", result: "done" }, "Shift+↑"), /send to background/);
  assert.doesNotMatch(text(base), /send to background/, "no hint when the shortcut is disabled");
  for (const width of [1, 10, 40]) assert.ok(renderRun(base, false, theme, "Shift+↑").render(width).every((line) => visibleWidth(line) <= width));
});
