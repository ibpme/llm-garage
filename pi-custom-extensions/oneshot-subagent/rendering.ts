import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { Markdown, Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { contextSegment, type Tone } from "./context-usage.ts";
import { oneLine, type RunDetails } from "./events.ts";

const count = (value: number) => value.toLocaleString("en-US");

interface Segment { text: string; tone?: Tone }

// Segments default to dim; only the context segment carries its own warning or error tone.
function segments(details: RunDetails): Segment[] {
  const latest = details.latestCallUsage;
  // Pi and Claude show only the latest completed call; cumulative totals are accounting metadata.
  // Legacy results without an agent discriminator keep their saved total.
  const cumulative = !latest && details.agent === undefined && details.totalTokens
    ? `${count(details.totalTokens)} tokens${details.usagePartial ? " (partial)" : ""}` : undefined;
  const lastCall = latest
    ? `last call: ↓ ${count(latest.input)} input · ↑ ${count(latest.output)} output · cached ${count(latest.cacheRead + latest.cacheWrite)}`
    : undefined;
  const context = contextSegment(details);
  return [
    { text: `${(details.durationMs / 1000).toFixed(1)}s` },
    { text: `${details.turns} turns` },
    { text: `${details.toolCalls} tool calls` },
    ...(lastCall ? [{ text: lastCall }] : []),
    ...(context ? [context] : []),
    ...(cumulative ? [{ text: cumulative }] : []),
    ...(details.costUsd ? [{ text: `$${details.costUsd.toFixed(4)}` }] : []),
  ];
}

export function stats(details: RunDetails): string {
  return segments(details).map((segment) => segment.text).join(" · ");
}

function statsLine(details: RunDetails, theme: Theme): string {
  return segments(details).map((segment) => theme.fg(segment.tone ?? "dim", segment.text)).join(theme.fg("dim", " · "));
}

/** Formats a Pi key ID for display, e.g. `shift+up` as `Shift+↑`. */
export function keyLabel(key: string): string {
  const arrows: Record<string, string> = { up: "↑", down: "↓", left: "←", right: "→" };
  return key.split("+").map((part) => arrows[part] ?? part.charAt(0).toUpperCase() + part.slice(1)).join("+");
}

/** backgroundHint: shortcut label shown while an accepted foreground run can be sent to the background. */
export function renderRun(details: RunDetails, expanded: boolean, theme: Theme, backgroundHint?: string): Component {
  const running = details.status === "running";
  const tone = details.status === "success" ? "success" : details.status === "error" ? "error" : "warning";
  const icon = running ? "◌" : details.status === "success" ? "✓" : details.status === "aborted" ? "■" : "✗";
  const header = `${theme.fg(tone, `${icon} ${details.status}`)} ${statsLine(details, theme)}`;
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
  // jobDir is set once the launch is acknowledged, which is when the run becomes eligible.
  if (running && backgroundHint && details.jobDir)
    children.push(new Text(theme.fg("dim", `${backgroundHint} or /agents → b: send to background`), 0, 0));
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
