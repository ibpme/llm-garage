import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { Markdown, Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { oneLine, type RunDetails } from "./events.ts";

export function stats(details: RunDetails): string {
  return `${(details.durationMs / 1000).toFixed(1)}s · ${details.turns} turns · ${details.toolCalls} tool calls` +
    (details.totalTokens ? ` · ${details.totalTokens.toLocaleString("en-US")} tokens${details.usagePartial ? " (partial)" : ""}` : "") +
    (details.costUsd ? ` · $${details.costUsd.toFixed(4)}` : "");
}

export function renderRun(details: RunDetails, expanded: boolean, theme: Theme): Component {
  const running = details.status === "running";
  const tone = details.status === "success" ? "success" : details.status === "error" ? "error" : "warning";
  const icon = running ? "◌" : details.status === "success" ? "✓" : details.status === "aborted" ? "■" : "✗";
  const header = `${theme.fg(tone, `${icon} ${details.status}`)} ${theme.fg("dim", stats(details))}`;
  const activity = details.activity.slice(expanded ? 0 : -4);
  const children: Component[] = [new Text(header, 0, 0)];
  if (expanded) {
    children.push(new Text(theme.fg("dim", `cwd: ${details.cwd}${details.agent ? ` · ${details.agent}` : ""}${details.model ? ` · ${details.model}` : ""}`), 0, 0));
    children.push(new Text(theme.fg("accent", "Task"), 0, 0));
    children.push(new Markdown(details.task, 0, 0, getMarkdownTheme()));
  }
  if (running || expanded) {
    if (expanded && activity.length) children.push(new Text(theme.fg("accent", "Activity"), 0, 0));
    for (const line of activity) children.push(new Text(theme.fg("muted", line), 0, 0));
  }
  const output = running ? details.preview : details.result ?? "";
  if (output) {
    if (expanded) {
      children.push(new Text(theme.fg("accent", running ? "Live response" : "Final response"), 0, 0));
      children.push(new Markdown(output, 0, 0, getMarkdownTheme()));
    }
    else {
      const lines = output.split("\n").filter((line) => line.trim()).slice(running ? -3 : 0, running ? undefined : 3);
      children.push(new Text(theme.fg("toolOutput", lines.map((line) => oneLine(line, 240)).join("\n")), 0, 0));
    }
  }
  if ((Array.isArray(details.children) && details.children.length) || details.childrenOmitted)
    children.push(new Text(theme.fg("dim", "nested runs: see job logs"), 0, 0));
  if (expanded && details.jobDir) children.push(new Text(theme.fg("dim", `logs: ${details.jobDir}`), 0, 0));
  if (!expanded && !running) children.push(new Text(theme.fg("dim", "Expand for the full response and job files"), 0, 0));
  return {
    render(width) {
      if (width < 4) return children.flatMap((child) => child.render(width)).map((line) => truncateToWidth(line, width));
      return children.flatMap((child) => child.render(width - 2)).map((line) =>
        theme.fg("borderMuted", "│ ") + truncateToWidth(line, width - 2));
    },
    invalidate() { for (const child of children) child.invalidate(); },
  };
}
