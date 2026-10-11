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

for (const status of ["running", "success", "error", "aborted"] as const) {
  test(`expanded parent renders ${status} grandchild task, activity, response and logs without backgrounds`, () => {
    const details: RunDetails = { name: "child", task: "Child task", cwd: "/tmp", status: "running", activity: [], preview: "", turns: 0, toolCalls: 1, durationMs: 0,
      children: [{ name: "grandchild", toolCallId: "nested-1", task: "Grandchild unique task 中文 😀", cwd: "/tmp", status,
        activity: ["→ read grandchild.ts"], preview: "Grandchild live response", result: "Grandchild final response",
        depth: 2, maxDepth: 2, turns: 1, toolCalls: 1, durationMs: 1000, jobDir: "/tmp/grandchild-job" }] };
    const expanded = renderRun(details, true, theme);
    for (const width of [1, 2, 3, 4, 10, 40, 80, 120]) assert.ok(expanded.render(width).every((line) => visibleWidth(line) <= width));
    const output = expanded.render(120).join("\n");
    assert.match(output, /Subagent · grandchild/);
    assert.match(output, /Grandchild unique task/);
    assert.match(output, /→ read grandchild.ts/);
    assert.match(output, /depth 2\/2/);
    assert.match(output, status === "running" ? /Grandchild live response/ : /Grandchild final response/);
    assert.match(output, /logs: \/tmp\/grandchild-job/);
    assert.match(output, /│ │/);
    assert.ok(!/\x1b\[(?:4\d|48)[;m]/.test(output));
    const collapsed = renderRun(details, false, theme).render(120).join("\n");
    assert.match(collapsed, /1 nested subagent/);
    assert.ok(!collapsed.includes("Grandchild unique task"));
  });
}
