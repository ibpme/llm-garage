import assert from "node:assert/strict";
import { test } from "node:test";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderRun, stats } from "./rendering.ts";
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
  assert.equal(stats(details), "1.0s · 2 turns · 3 tool calls · last call: ↓ 2 input · ↑ 3 output · cached 4 · $0.0100");
});

test("Pi latest breakdown keeps zero counts and thousands separators", () => {
  assert.equal(stats({ ...pi, latestCallUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
    "1.0s · 2 turns · 3 tool calls · last call: ↓ 0 input · ↑ 0 output · cached 0");
  assert.equal(stats({ ...pi, latestCallUsage: { input: 1234, output: 56, cacheRead: 7000, cacheWrite: 890 } }),
    "1.0s · 2 turns · 3 tool calls · last call: ↓ 1,234 input · ↑ 56 output · cached 7,890");
});

test("Pi runs without a latest call do not fall back to cumulative totals", () => {
  for (const details of [{ ...pi, totalTokens: 999 }, { ...pi, totalTokens: 999, usagePartial: true }]) {
    const line = stats(details);
    assert.equal(line, "1.0s · 2 turns · 3 tool calls");
  }
});

test("Claude shows the latest call breakdown and never its cumulative total", () => {
  const claude = { ...pi, agent: "claude", latestCallUsage: { input: 2, output: 3, cacheRead: 1, cacheWrite: 3 }, totalTokens: 999 } as RunDetails;
  assert.equal(stats(claude), "1.0s · 2 turns · 3 tool calls · last call: ↓ 2 input · ↑ 3 output · cached 4");
  assert.equal(stats({ ...claude, usagePartial: true, costUsd: 0.01 }),
    "1.0s · 2 turns · 3 tool calls · last call: ↓ 2 input · ↑ 3 output · cached 4 · $0.0100");
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
