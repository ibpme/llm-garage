/**
 * Stylish Tools Extension
 *
 * Re-renders all built-in tools (bash, read, edit, write, grep, ls, find)
 * with a consistent look: compact borderless line while collapsed, a
 * bordered card revealing full detail once expanded (Ctrl+E). Execution is
 * always delegated to the original built-in implementation — only
 * renderCall/renderResult change.
 *
 * Design (see interview in chat history for the full rationale):
 * - Collapsed: single status line, colored/iconed by status. bash also
 *   tails its last few output lines while collapsed.
 * - Expanded: bordered card, header colored by status, full body content.
 * - Live duration ticks once a second while a call is running, for every
 *   tool (not just bash), via a shared per-call render state.
 * - Vivid color usage: tool label/args get accent/toolTitle, not just
 *   status.
 */
import {
  createBashTool,
  createBashToolDefinition,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
  keyHint,
  type BashToolDetails,
  type EditToolDetails,
  type ExtensionAPI,
  type FindToolDetails,
  type GrepToolDetails,
  type LsToolDetails,
  type ReadToolDetails,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

type BorderColor = "borderAccent" | "success" | "warning" | "error";
type Status = "running" | "success" | "error" | "aborted" | "timeout";

interface RenderState {
  startedAt?: number;
  endedAt?: number;
  interval?: NodeJS.Timeout;
  status: Status;
}

const TAIL_LINES = 4;
const EXPANDED_CAP = 40;

// ---------------------------------------------------------------------------
// Shared status/border/timer machinery
// ---------------------------------------------------------------------------

function getBorderColor(status: Status): BorderColor {
  switch (status) {
    case "success":
      return "success";
    case "error":
      return "error";
    case "aborted":
    case "timeout":
      return "warning";
    case "running":
    default:
      return "borderAccent";
  }
}

function getStatusIcon(status: Status): string {
  switch (status) {
    case "running":
      return "⟳";
    case "success":
      return "✓";
    case "error":
      return "✗";
    case "aborted":
      return "⏹";
    case "timeout":
      return "⏱";
  }
}

function getStatusColor(status: Status): "success" | "error" | "warning" | "muted" {
  switch (status) {
    case "success":
      return "muted";
    case "error":
      return "error";
    case "aborted":
    case "timeout":
      return "warning";
    case "running":
      return "warning";
  }
}

function styleBorder(theme: Theme, status: Status, text: string): string {
  return theme.fg(getBorderColor(status), text);
}

function formatDuration(state: RenderState, now = Date.now()): string {
  if (state.startedAt === undefined) return "";
  const end = state.endedAt ?? now;
  return `${((end - state.startedAt) / 1000).toFixed(2)}s`;
}

function ensureState(context: { state: unknown }): RenderState {
  const state = context.state as RenderState;
  state.status ??= "running";
  return state;
}

function updateRenderState(
  context: { state: unknown; executionStarted: boolean; invalidate: () => void },
  isPartial: boolean,
  isError: boolean,
  timers: Set<NodeJS.Timeout>,
): RenderState {
  const state = ensureState(context);

  if (context.executionStarted && state.startedAt === undefined) {
    state.startedAt = Date.now();
  }

  if (isPartial) {
    state.status = "running";
    if (!state.interval) {
      state.interval = setInterval(() => context.invalidate(), 1000);
      timers.add(state.interval);
    }
  } else {
    state.endedAt ??= Date.now();
    state.status = isError ? "error" : "success";
    if (state.interval) {
      clearInterval(state.interval);
      timers.delete(state.interval);
      state.interval = undefined;
    }
  }

  return state;
}

// bash-specific: refine error into aborted/timeout from the built-in's own
// footer text, same detection stylish-bash.ts used.
function refineBashStatus(state: RenderState, output: string, isError: boolean): void {
  if (!isError) return;
  if (/Command aborted\b/.test(output)) state.status = "aborted";
  else if (/Command timed out\b/.test(output)) state.status = "timeout";
}

// ---------------------------------------------------------------------------
// Rendering primitives
// ---------------------------------------------------------------------------

/** Plain lines, no border, no wrap — used for collapsed states. */
class PlainLines implements Component {
  constructor(private lines: string[]) {}
  render(width: number): string[] {
    return this.lines.map((line) => truncateToWidth(line, width, "", true));
  }
  invalidate(): void {}
}

function getInnerWidth(width: number): number {
  return Math.max(1, width - 4);
}

function renderTopBorder(width: number, theme: Theme, status: Status, label: string): string {
  const prefix = `╭─ ${label} `;
  const suffix = "╮";
  const fill = Math.max(0, width - visibleWidth(prefix) - visibleWidth(suffix));
  const line =
    styleBorder(theme, status, "╭─") +
    theme.fg("toolTitle", theme.bold(` ${label} `)) +
    styleBorder(theme, status, `${"─".repeat(fill)}${suffix}`);
  return truncateToWidth(line, width, "", true);
}

function renderBottomBorder(width: number, theme: Theme, status: Status): string {
  const line = `╰${"─".repeat(Math.max(0, width - 2))}╯`;
  return truncateToWidth(styleBorder(theme, status, line), width, "", true);
}

function renderFrameLine(content: string, width: number, theme: Theme, status: Status): string {
  const innerWidth = getInnerWidth(width);
  const clipped = truncateToWidth(content, innerWidth, "");
  const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)));
  const line =
    styleBorder(theme, status, "│") + " " + clipped + padding + " " + styleBorder(theme, status, "│");
  return truncateToWidth(line, width, "", true);
}

/** Bordered card — used for the expanded state of every tool. */
class Card implements Component {
  constructor(
    private label: string,
    private theme: Theme,
    private status: Status,
    private body: string[],
    private footer: string,
  ) {}

  render(width: number): string[] {
    const lines = [
      renderTopBorder(width, this.theme, this.status, this.label),
      ...this.body.map((line) => renderFrameLine(line, width, this.theme, this.status)),
      renderFrameLine(this.footer, width, this.theme, this.status),
      renderBottomBorder(width, this.theme, this.status),
    ];
    return lines;
  }

  invalidate(): void {}
}

function formatStatusLine(
  theme: Theme,
  status: Status,
  state: RenderState,
  extras: string[],
  showExpandHint: boolean,
  now = Date.now(),
): string {
  const icon = getStatusIcon(status);
  const statusText = status === "success" ? "done" : status === "error" ? "failed" : status;
  const duration = formatDuration(state, now);

  const parts = [`${icon} ${statusText}`];
  if (duration) parts.push(duration);
  parts.push(...extras);
  if (showExpandHint && status !== "running") parts.push(keyHint("app.tools.expand", "expand"));

  return (
    theme.fg(getStatusColor(status), parts[0]) + theme.fg("muted", ` · ${parts.slice(1).join(" · ")}`)
  );
}

function capLines(lines: string[], theme: Theme, cap = EXPANDED_CAP): string[] {
  if (lines.length <= cap) return lines;
  return [...lines.slice(0, cap), theme.fg("muted", `… ${lines.length - cap} more lines`)];
}

function getTextOutput(result: { content: Array<{ type: string; text?: string }> }): string {
  const texts = result.content.filter((c) => c.type === "text").map((c) => c.text ?? "");
  return texts.join("\n");
}

function countNonEmptyLines(text: string): number {
  return text.split("\n").filter((l) => l.trim().length > 0).length;
}

function callLine(theme: Theme, icon: string, label: string, args: string): PlainLines {
  const text =
    theme.fg("toolTitle", theme.bold(`${icon} ${label} `)) + theme.fg("accent", args);
  return new PlainLines([text]);
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  const cwd = process.cwd();
  const timers = new Set<NodeJS.Timeout>();

  // --- bash ------------------------------------------------------------
  const bashTool = createBashTool(cwd);
  const bashMetadata = createBashToolDefinition(cwd);

  pi.registerTool({
    name: "bash",
    label: bashMetadata.label,
    description: bashMetadata.description,
    promptSnippet: bashMetadata.promptSnippet,
    promptGuidelines: bashMetadata.promptGuidelines,
    parameters: bashMetadata.parameters,
    renderShell: "self",

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return bashTool.execute(toolCallId, params, signal, onUpdate);
    },

    renderCall(args, theme, context) {
      ensureState(context);
      const command = String(args.command ?? "");
      const cmd = command.length > 100 ? `${command.slice(0, 97)}...` : command;
      return callLine(theme, "$", "bash", cmd);
    },

    renderResult(result, options, theme, context) {
      const output = getTextOutput(result);
      const state = updateRenderState(context, options.isPartial, context.isError, timers);
      refineBashStatus(state, output, context.isError);
      const status = state.status;
      const details = result.details as BashToolDetails | undefined;
      const outputLines = output.split("\n").filter((_, i, arr) => !(arr.length === 1 && arr[0] === ""));
      const lineCount = output ? outputLines.length : 0;

      const extras = [lineCount === 0 ? "no output" : `${lineCount} line${lineCount === 1 ? "" : "s"}`];
      if (details?.truncation?.truncated || details?.fullOutputPath) extras.push("truncated");

      if (!options.expanded) {
        const statusLine = formatStatusLine(theme, status, state, extras, true);
        if (lineCount === 0) return new PlainLines([statusLine]);
        const tail = outputLines.slice(-TAIL_LINES).map((l) => theme.fg("dim", l));
        return new PlainLines([statusLine, ...tail]);
      }

      const body = capLines(
        outputLines.length ? outputLines : [theme.fg("dim", "(no output)")],
        theme,
      );
      const footer = formatStatusLine(theme, status, state, extras, true);
      return new Card("bash", theme, status, body, footer);
    },
  });

  // --- read --------------------------------------------------------------
  const readTool = createReadTool(cwd);
  pi.registerTool({
    name: "read",
    label: "read",
    description: readTool.description,
    parameters: readTool.parameters,
    renderShell: "self",

    async execute(toolCallId, params, signal, onUpdate) {
      return readTool.execute(toolCallId, params, signal, onUpdate);
    },

    renderCall(args, theme, context) {
      ensureState(context);
      const extra: string[] = [];
      if (args.offset) extra.push(`offset=${args.offset}`);
      if (args.limit) extra.push(`limit=${args.limit}`);
      const suffix = extra.length ? theme.fg("dim", ` (${extra.join(", ")})`) : "";
      const line =
        theme.fg("toolTitle", theme.bold("▸ read ")) + theme.fg("accent", String(args.path ?? "")) + suffix;
      return new PlainLines([line]);
    },

    renderResult(result, options, theme, context) {
      const state = updateRenderState(context, options.isPartial, context.isError, timers);
      const status = state.status;
      const details = result.details as ReadToolDetails | undefined;
      const content = result.content[0];

      if (content?.type === "image") {
        const line = formatStatusLine(theme, status, state, ["image"], true);
        return options.expanded
          ? new Card("read", theme, status, [theme.fg("dim", "(image content)")], line)
          : new PlainLines([line]);
      }

      const text = content?.type === "text" ? content.text : "";
      const lineCount = text ? text.split("\n").length : 0;
      const extras = [`${lineCount} line${lineCount === 1 ? "" : "s"}`];
      if (details?.truncation?.truncated) extras.push(`truncated of ${details.truncation.totalLines}`);

      const statusLine = formatStatusLine(theme, status, state, extras, true);
      if (!options.expanded) return new PlainLines([statusLine]);

      const body = capLines(text ? text.split("\n").map((l) => theme.fg("toolOutput", l)) : [], theme);
      return new Card("read", theme, status, body, statusLine);
    },
  });

  // --- edit ----------------------------------------------------------------
  const editTool = createEditTool(cwd);
  pi.registerTool({
    name: "edit",
    label: "edit",
    description: editTool.description,
    parameters: editTool.parameters,
    renderShell: "self",

    async execute(toolCallId, params, signal, onUpdate) {
      return editTool.execute(toolCallId, params, signal, onUpdate);
    },

    renderCall(args, theme, context) {
      ensureState(context);
      const editCount = Array.isArray(args.edits) ? args.edits.length : 1;
      const suffix = editCount > 1 ? theme.fg("dim", ` (${editCount} edits)`) : "";
      const line =
        theme.fg("toolTitle", theme.bold("✎ edit ")) + theme.fg("accent", String(args.path ?? "")) + suffix;
      return new PlainLines([line]);
    },

    renderResult(result, options, theme, context) {
      const state = updateRenderState(context, options.isPartial, context.isError, timers);
      const status = state.status;
      const details = result.details as EditToolDetails | undefined;
      const content = result.content[0];

      if (context.isError) {
        const errText = content?.type === "text" ? content.text.split("\n")[0] : "error";
        const statusLine = formatStatusLine(theme, status, state, [errText], true);
        return options.expanded
          ? new Card("edit", theme, status, [theme.fg("error", content?.type === "text" ? content.text : errText)], statusLine)
          : new PlainLines([statusLine]);
      }

      const diffLines = details?.diff ? details.diff.split("\n") : [];
      let additions = 0;
      let removals = 0;
      for (const line of diffLines) {
        if (line.startsWith("+") && !line.startsWith("+++")) additions++;
        if (line.startsWith("-") && !line.startsWith("---")) removals++;
      }
      const diffStat = theme.fg("success", `+${additions}`) + theme.fg("dim", "/") + theme.fg("error", `-${removals}`);

      const statusLine = formatStatusLine(theme, status, state, [diffStat], true);
      if (!options.expanded) return new PlainLines([statusLine]);

      const body = capLines(
        diffLines.map((line) => {
          if (line.startsWith("+") && !line.startsWith("+++")) return theme.fg("toolDiffAdded", line);
          if (line.startsWith("-") && !line.startsWith("---")) return theme.fg("toolDiffRemoved", line);
          return theme.fg("toolDiffContext", line);
        }),
        theme,
      );
      return new Card("edit", theme, status, body, statusLine);
    },
  });

  // --- write -----------------------------------------------------------
  const writeTool = createWriteTool(cwd);
  pi.registerTool({
    name: "write",
    label: "write",
    description: writeTool.description,
    parameters: writeTool.parameters,
    renderShell: "self",

    async execute(toolCallId, params, signal, onUpdate) {
      return writeTool.execute(toolCallId, params, signal, onUpdate);
    },

    renderCall(args, theme, context) {
      ensureState(context);
      const lineCount = String(args.content ?? "").split("\n").length;
      const line =
        theme.fg("toolTitle", theme.bold("✎ write ")) +
        theme.fg("accent", String(args.path ?? "")) +
        theme.fg("dim", ` (${lineCount} lines)`);
      return new PlainLines([line]);
    },

    renderResult(result, options, theme, context) {
      const state = updateRenderState(context, options.isPartial, context.isError, timers);
      const status = state.status;
      const content = result.content[0];

      if (context.isError) {
        const errText = content?.type === "text" ? content.text.split("\n")[0] : "error";
        const statusLine = formatStatusLine(theme, status, state, [errText], true);
        return new PlainLines([statusLine]);
      }

      const statusLine = formatStatusLine(theme, status, state, [], true);
      return new PlainLines([statusLine]);
    },
  });

  // --- grep --------------------------------------------------------------
  const grepTool = createGrepTool(cwd);
  pi.registerTool({
    name: "grep",
    label: "grep",
    description: grepTool.description,
    parameters: grepTool.parameters,
    renderShell: "self",

    async execute(toolCallId, params, signal, onUpdate) {
      return grepTool.execute(toolCallId, params, signal, onUpdate);
    },

    renderCall(args, theme, context) {
      ensureState(context);
      const path = args.path ? theme.fg("dim", ` in ${args.path}`) : "";
      const line =
        theme.fg("toolTitle", theme.bold("⌕ grep ")) + theme.fg("accent", String(args.pattern ?? "")) + path;
      return new PlainLines([line]);
    },

    renderResult(result, options, theme, context) {
      const state = updateRenderState(context, options.isPartial, context.isError, timers);
      const status = state.status;
      const details = result.details as GrepToolDetails | undefined;
      const text = getTextOutput(result);
      const noMatches = text.trim() === "No matches found";
      const matchCount = noMatches ? 0 : countNonEmptyLines(text);

      const extras = [`${matchCount} match${matchCount === 1 ? "" : "es"}`];
      if (details?.matchLimitReached) extras.push("limit reached");

      const statusLine = formatStatusLine(theme, status, state, extras, true);
      if (!options.expanded) return new PlainLines([statusLine]);

      const body = capLines(
        noMatches ? [theme.fg("dim", "(no matches)")] : text.split("\n").map((l) => theme.fg("toolOutput", l)),
        theme,
      );
      return new Card("grep", theme, status, body, statusLine);
    },
  });

  // --- ls ------------------------------------------------------------------
  const lsTool = createLsTool(cwd);
  pi.registerTool({
    name: "ls",
    label: "ls",
    description: lsTool.description,
    parameters: lsTool.parameters,
    renderShell: "self",

    async execute(toolCallId, params, signal, onUpdate) {
      return lsTool.execute(toolCallId, params, signal, onUpdate);
    },

    renderCall(args, theme, context) {
      ensureState(context);
      const line =
        theme.fg("toolTitle", theme.bold("▸ ls ")) + theme.fg("accent", String(args.path ?? "."));
      return new PlainLines([line]);
    },

    renderResult(result, options, theme, context) {
      const state = updateRenderState(context, options.isPartial, context.isError, timers);
      const status = state.status;
      const details = result.details as LsToolDetails | undefined;
      const text = getTextOutput(result);
      const empty = text.trim() === "(empty directory)";
      const entryCount = empty ? 0 : countNonEmptyLines(text);

      const extras = [`${entryCount} entr${entryCount === 1 ? "y" : "ies"}`];
      if (details?.entryLimitReached) extras.push("limit reached");

      const statusLine = formatStatusLine(theme, status, state, extras, true);
      if (!options.expanded) return new PlainLines([statusLine]);

      const body = capLines(
        empty ? [theme.fg("dim", "(empty directory)")] : text.split("\n").map((l) => theme.fg("toolOutput", l)),
        theme,
      );
      return new Card("ls", theme, status, body, statusLine);
    },
  });

  // --- find ----------------------------------------------------------------
  const findTool = createFindTool(cwd);
  pi.registerTool({
    name: "find",
    label: "find",
    description: findTool.description,
    parameters: findTool.parameters,
    renderShell: "self",

    async execute(toolCallId, params, signal, onUpdate) {
      return findTool.execute(toolCallId, params, signal, onUpdate);
    },

    renderCall(args, theme, context) {
      ensureState(context);
      const path = args.path ? theme.fg("dim", ` in ${args.path}`) : "";
      const line =
        theme.fg("toolTitle", theme.bold("⌕ find ")) + theme.fg("accent", String(args.pattern ?? "")) + path;
      return new PlainLines([line]);
    },

    renderResult(result, options, theme, context) {
      const state = updateRenderState(context, options.isPartial, context.isError, timers);
      const status = state.status;
      const details = result.details as FindToolDetails | undefined;
      const text = getTextOutput(result);
      const noResults = text.trim() === "No files found matching pattern";
      const resultCount = noResults ? 0 : countNonEmptyLines(text);

      const extras = [`${resultCount} result${resultCount === 1 ? "" : "s"}`];
      if (details?.resultLimitReached) extras.push("limit reached");

      const statusLine = formatStatusLine(theme, status, state, extras, true);
      if (!options.expanded) return new PlainLines([statusLine]);

      const body = capLines(
        noResults ? [theme.fg("dim", "(no results)")] : text.split("\n").map((l) => theme.fg("toolOutput", l)),
        theme,
      );
      return new Card("find", theme, status, body, statusLine);
    },
  });

  pi.on("session_shutdown", async () => {
    for (const timer of timers) clearInterval(timer);
    timers.clear();
  });
}
