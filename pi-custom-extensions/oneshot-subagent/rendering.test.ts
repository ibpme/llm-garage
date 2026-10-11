import assert from "node:assert/strict";
import { test } from "node:test";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderRun } from "./rendering.ts";
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
