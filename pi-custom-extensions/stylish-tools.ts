/**
 * Stylish Tools Extension
 *
 * Re-renders all built-in tools (bash, read, edit, write, grep, ls, find)
 * with a consistent look: no box-drawing anywhere. Collapsed is a plain
 * status line; expanded is a colored ● header + colored │ gutter per line
 * (no ╭─╮╰─╯ frame). Execution is always delegated to the original
 * built-in implementation — only renderCall/renderResult change.
 *
 * Design (see interview in chat history for the full rationale):
 * - Collapsed: single status line, colored/iconed by status, plus a
 *   per-tool preview of the output that mirrors pi's own stock caps —
 *   bash tails its last 5 lines, read previews 3, grep 15, ls/find 20,
 *   write 10 — so the minimal default doesn't hide signal.
 * - Expanded: borderless indicator block — a colored ● marks the header,
 *   a colored │ gutter marks each body/footer line, status-colored.
 *   Driven entirely by pi's own global "expand everything" toggle
 *   (Ctrl+O by default, see app.tools.expand in keybindings.md) — except
 *   edit, which (like pi's own edit tool) always shows its full diff and
 *   ignores collapse/expand state entirely.
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
import { type Component, Text, truncateToWidth } from "@earendil-works/pi-tui";

type IndicatorColor = "borderAccent" | "success" | "warning" | "error";
type Status = "running" | "success" | "error" | "aborted" | "timeout";

interface RenderState {
  startedAt?: number;
  endedAt?: number;
  interval?: NodeJS.Timeout;
  status: Status;
}

// Preview caps mirror pi's own stock per-tool defaults (see bash.ts's
// BASH_PREVIEW_LINES, grep/ls/find/write's `options.expanded ? ... : N`).
const BASH_TAIL_LINES = 5;
const READ_PREVIEW_LINES = 3;
const GREP_PREVIEW_LINES = 15;
const LS_PREVIEW_LINES = 20;
const FIND_PREVIEW_LINES = 20;
const WRITE_PREVIEW_LINES = 10;
const EXPANDED_CAP = 40;

// ---------------------------------------------------------------------------
// Shared status/indicator/timer machinery
// ---------------------------------------------------------------------------

function getIndicatorColor(status: Status): IndicatorColor {
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

/**
 * Borderless indicator block — used for the expanded state of every tool.
 * No box-drawing; a colored ● marks the header, a colored │ gutter marks
 * each body/footer line so the block still reads as one unit while
 * scrolling past it stays cheap (no corner/fill math, no frame padding).
 */
class IndicatorBlock implements Component {
  constructor(
    private label: string,
    private theme: Theme,
    private status: Status,
    private body: string[],
    private footer: string,
  ) {}

  render(width: number): string[] {
    const color = getIndicatorColor(this.status);
    const dot = this.theme.fg(color, "●");
    const guide = this.theme.fg(color, "│");
    const header = `${dot} ${this.theme.fg("toolTitle", this.theme.bold(this.label))}`;

    const lines = [
      header,
      ...this.body.map((line) => `${guide} ${line}`),
      `${guide} ${this.footer}`,
    ];
    return lines.map((line) => truncateToWidth(line, width, "", true));
  }

  invalidate(): void {}
}

function formatStatusLine(
  theme: Theme,
  status: Status,
  state: RenderState,
  extras: string[],
  expanded: boolean,
  now = Date.now(),
): string {
  const icon = getStatusIcon(status);
  const statusText = status === "success" ? "done" : status === "error" ? "failed" : status;
  const duration = formatDuration(state, now);

  const parts = [`${icon} ${statusText}`];
  if (duration) parts.push(duration);
  parts.push(...extras);
  if (!expanded && status !== "running") parts.push(keyHint("app.tools.expand", "expand"));

  return (
    theme.fg(getStatusColor(status), parts[0]) + theme.fg("muted", ` · ${parts.slice(1).join(" · ")}`)
  );
}

function capLines(lines: string[], theme: Theme, cap = EXPANDED_CAP): string[] {
  if (lines.length <= cap) return lines;
  return [...lines.slice(0, cap), theme.fg("muted", `… ${lines.length - cap} more lines`)];
}

/** First-N-line preview for the collapsed state, dimmed. */
function buildPreview(theme: Theme, lines: string[], limit = READ_PREVIEW_LINES): string[] {
  if (lines.length === 0) return [];
  return lines.slice(0, limit).map((l) => theme.fg("dim", l));
}

function colorDiffLine(theme: Theme, line: string): string {
  if (line.startsWith("+") && !line.startsWith("+++")) return theme.fg("toolDiffAdded", line);
  if (line.startsWith("-") && !line.startsWith("---")) return theme.fg("toolDiffRemoved", line);
  return theme.fg("toolDiffContext", line);
}

function getTextOutput(result: { content: Array<{ type: string; text?: string }> }): string {
  const texts = result.content.filter((c) => c.type === "text").map((c) => c.text ?? "");
  return texts.join("\n");
}

function countNonEmptyLines(text: string): number {
  return text.split("\n").filter((l) => l.trim().length > 0).length;
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
      const text = theme.fg("toolTitle", theme.bold("$ bash ")) + theme.fg("accent", command);
      // Full command, wrapped across lines rather than hard-truncated — a
      // long command shouldn't lose its tail end just to fit one line.
      return new Text(text, 0, 0);
    },

    renderResult(result, options, theme, context) {
      const expanded = options.expanded;

      const output = getTextOutput(result);
      const state = updateRenderState(context, options.isPartial, context.isError, timers);
      refineBashStatus(state, output, context.isError);
      const status = state.status;
      const details = result.details as BashToolDetails | undefined;
      const outputLines = output.split("\n").filter((_, i, arr) => !(arr.length === 1 && arr[0] === ""));
      const lineCount = output ? outputLines.length : 0;

      const extras = [lineCount === 0 ? "no output" : `${lineCount} line${lineCount === 1 ? "" : "s"}`];
      if (details?.truncation?.truncated || details?.fullOutputPath) extras.push("truncated");

      if (!expanded) {
        const statusLine = formatStatusLine(theme, status, state, extras, expanded);
        if (lineCount === 0) return new PlainLines([statusLine]);
        const tail = outputLines.slice(-BASH_TAIL_LINES).map((l) => theme.fg("dim", l));
        return new PlainLines([statusLine, ...tail]);
      }

      const body = capLines(outputLines.length ? outputLines : [theme.fg("dim", "(no output)")], theme);
      const footer = formatStatusLine(theme, status, state, extras, expanded);
      return new IndicatorBlock("bash", theme, status, body, footer);
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
      const expanded = options.expanded;

      const state = updateRenderState(context, options.isPartial, context.isError, timers);
      const status = state.status;
      const details = result.details as ReadToolDetails | undefined;
      const content = result.content[0];

      if (content?.type === "image") {
        const line = formatStatusLine(theme, status, state, ["image"], expanded);
        return expanded
          ? new IndicatorBlock("read", theme, status, [theme.fg("dim", "(image content)")], line)
          : new PlainLines([line]);
      }

      const text = content?.type === "text" ? content.text : "";
      const lines = text ? text.split("\n") : [];
      const extras = [`${lines.length} line${lines.length === 1 ? "" : "s"}`];
      if (details?.truncation?.truncated) extras.push(`truncated of ${details.truncation.totalLines}`);

      const statusLine = formatStatusLine(theme, status, state, extras, expanded);
      if (!expanded) return new PlainLines([statusLine, ...buildPreview(theme, lines)]);

      const body = capLines(lines.map((l) => theme.fg("toolOutput", l)), theme);
      return new IndicatorBlock("read", theme, status, body, statusLine);
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

      // Matches pi's own edit tool: the diff always renders in full,
      // regardless of collapse/expand state (Ctrl+O has no effect here).
      if (context.isError) {
        const errText = content?.type === "text" ? content.text.split("\n")[0] : "error";
        const statusLine = formatStatusLine(theme, status, state, [errText], true);
        return new IndicatorBlock(
          "edit",
          theme,
          status,
          [theme.fg("error", content?.type === "text" ? content.text : errText)],
          statusLine,
        );
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
      const body = capLines(
        diffLines.map((line) => colorDiffLine(theme, line)),
        theme,
      );
      return new IndicatorBlock("edit", theme, status, body, statusLine);
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
      const expanded = options.expanded;

      const state = updateRenderState(context, options.isPartial, context.isError, timers);
      const status = state.status;
      const content = result.content[0];

      if (context.isError) {
        const errText = content?.type === "text" ? content.text.split("\n")[0] : "error";
        const statusLine = formatStatusLine(theme, status, state, [errText], expanded);
        return new PlainLines([statusLine]);
      }

      const writtenContent = String((context.args as { content?: string } | undefined)?.content ?? "");
      const lines = writtenContent ? writtenContent.split("\n") : [];
      const statusLine = formatStatusLine(theme, status, state, [`${lines.length} lines`], expanded);

      if (!expanded) return new PlainLines([statusLine, ...buildPreview(theme, lines, WRITE_PREVIEW_LINES)]);

      const body = capLines(lines.map((l) => theme.fg("toolOutput", l)), theme);
      return new IndicatorBlock("write", theme, status, body, statusLine);
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
      const expanded = options.expanded;

      const state = updateRenderState(context, options.isPartial, context.isError, timers);
      const status = state.status;
      const details = result.details as GrepToolDetails | undefined;
      const text = getTextOutput(result);
      const noMatches = text.trim() === "No matches found";
      const lines = noMatches ? [] : text.split("\n");
      const matchCount = noMatches ? 0 : countNonEmptyLines(text);

      const extras = [`${matchCount} match${matchCount === 1 ? "" : "es"}`];
      if (details?.matchLimitReached) extras.push("limit reached");

      const statusLine = formatStatusLine(theme, status, state, extras, expanded);
      if (!expanded) return new PlainLines([statusLine, ...buildPreview(theme, lines, GREP_PREVIEW_LINES)]);

      const body = capLines(
        noMatches ? [theme.fg("dim", "(no matches)")] : lines.map((l) => theme.fg("toolOutput", l)),
        theme,
      );
      return new IndicatorBlock("grep", theme, status, body, statusLine);
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
      const line = theme.fg("toolTitle", theme.bold("▸ ls ")) + theme.fg("accent", String(args.path ?? "."));
      return new PlainLines([line]);
    },

    renderResult(result, options, theme, context) {
      const expanded = options.expanded;

      const state = updateRenderState(context, options.isPartial, context.isError, timers);
      const status = state.status;
      const details = result.details as LsToolDetails | undefined;
      const text = getTextOutput(result);
      const empty = text.trim() === "(empty directory)";
      const lines = empty ? [] : text.split("\n");
      const entryCount = empty ? 0 : countNonEmptyLines(text);

      const extras = [`${entryCount} entr${entryCount === 1 ? "y" : "ies"}`];
      if (details?.entryLimitReached) extras.push("limit reached");

      const statusLine = formatStatusLine(theme, status, state, extras, expanded);
      if (!expanded) return new PlainLines([statusLine, ...buildPreview(theme, lines, LS_PREVIEW_LINES)]);

      const body = capLines(
        empty ? [theme.fg("dim", "(empty directory)")] : lines.map((l) => theme.fg("toolOutput", l)),
        theme,
      );
      return new IndicatorBlock("ls", theme, status, body, statusLine);
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
      const expanded = options.expanded;

      const state = updateRenderState(context, options.isPartial, context.isError, timers);
      const status = state.status;
      const details = result.details as FindToolDetails | undefined;
      const text = getTextOutput(result);
      const noResults = text.trim() === "No files found matching pattern";
      const lines = noResults ? [] : text.split("\n");
      const resultCount = noResults ? 0 : countNonEmptyLines(text);

      const extras = [`${resultCount} result${resultCount === 1 ? "" : "s"}`];
      if (details?.resultLimitReached) extras.push("limit reached");

      const statusLine = formatStatusLine(theme, status, state, extras, expanded);
      if (!expanded) return new PlainLines([statusLine, ...buildPreview(theme, lines, FIND_PREVIEW_LINES)]);

      const body = capLines(
        noResults ? [theme.fg("dim", "(no results)")] : lines.map((l) => theme.fg("toolOutput", l)),
        theme,
      );
      return new IndicatorBlock("find", theme, status, body, statusLine);
    },
  });

  pi.on("session_shutdown", async () => {
    for (const timer of timers) clearInterval(timer);
    timers.clear();
  });
}
