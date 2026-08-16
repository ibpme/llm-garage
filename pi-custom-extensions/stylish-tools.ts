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
 *
 * Composability with other extensions (e.g. ssh.ts):
 * - read/write/edit/bash's *execute* consults a shared, mutable
 *   operations-override registry (see `setOperationsOverride` /
 *   `clearOperationsOverride`) instead of hard-coding local operations.
 *   Another extension can redirect a built-in tool's I/O (to run over
 *   SSH, a container, etc.) without ever calling registerTool() for
 *   these names itself — avoiding the "first registration per name
 *   wins" shadowing that pi's extension loader does across extensions.
 * - The per-tool factories (createStylishReadTool, ...WriteTool,
 *   ...EditTool, ...BashTool) are exported so another extension can
 *   register *differently-named* tools (e.g. "read_remote") that reuse
 *   the exact same rendering, with their own dynamic operations source
 *   and an optional tag shown next to the label/status line.
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
  defineTool,
  keyHint,
  type BashOperations,
  type BashToolDetails,
  type EditOperations,
  type EditToolDetails,
  type ExtensionAPI,
  type FindOperations,
  type FindToolDetails,
  type GrepOperations,
  type GrepToolDetails,
  type LsOperations,
  type LsToolDetails,
  type ReadOperations,
  type ReadToolDetails,
  type Theme,
  type WriteOperations,
} from "@earendil-works/pi-coding-agent";
import { type Component, Text, truncateToWidth } from "@earendil-works/pi-tui";

export type IndicatorColor = "borderAccent" | "success" | "warning" | "error";
export type Status = "running" | "success" | "error" | "aborted" | "timeout";

export interface RenderState {
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

export function getIndicatorColor(status: Status): IndicatorColor {
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

export function getStatusIcon(status: Status): string {
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

export function getStatusColor(status: Status): "success" | "error" | "warning" | "muted" {
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

export function formatDuration(state: RenderState, now = Date.now()): string {
  if (state.startedAt === undefined) return "";
  const end = state.endedAt ?? now;
  return `${((end - state.startedAt) / 1000).toFixed(2)}s`;
}

export function ensureState(context: { state: unknown }): RenderState {
  const state = context.state as RenderState;
  state.status ??= "running";
  return state;
}

export function updateRenderState(
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
export function refineBashStatus(state: RenderState, output: string, isError: boolean): void {
  if (!isError) return;
  if (/Command aborted\b/.test(output)) state.status = "aborted";
  else if (/Command timed out\b/.test(output)) state.status = "timeout";
}

// ---------------------------------------------------------------------------
// Rendering primitives
// ---------------------------------------------------------------------------

/** Plain lines, no border, no wrap — used for collapsed states. */
export class PlainLines implements Component {
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
export class IndicatorBlock implements Component {
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

export function formatStatusLine(
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

export function capLines(lines: string[], theme: Theme, cap = EXPANDED_CAP): string[] {
  if (lines.length <= cap) return lines;
  return [...lines.slice(0, cap), theme.fg("muted", `… ${lines.length - cap} more lines`)];
}

/** First-N-line preview for the collapsed state, dimmed. */
export function buildPreview(theme: Theme, lines: string[], limit = READ_PREVIEW_LINES): string[] {
  if (lines.length === 0) return [];
  return lines.slice(0, limit).map((l) => theme.fg("dim", l));
}

export function colorDiffLine(theme: Theme, line: string): string {
  if (line.startsWith("+") && !line.startsWith("+++")) return theme.fg("toolDiffAdded", line);
  if (line.startsWith("-") && !line.startsWith("---")) return theme.fg("toolDiffRemoved", line);
  return theme.fg("toolDiffContext", line);
}

export function getTextOutput(result: { content: Array<{ type: string; text?: string }> }): string {
  const texts = result.content.filter((c) => c.type === "text").map((c) => c.text ?? "");
  return texts.join("\n");
}

export function countNonEmptyLines(text: string): number {
  return text.split("\n").filter((l) => l.trim().length > 0).length;
}

/** Notice appended after a label/path when operations are overridden, e.g. " (remote) user@host". */
function renderTag(theme: Theme, tag: string | undefined): string {
  return tag ? ` ${theme.fg("warning", "(remote)")}${theme.fg("dim", ` ${tag}`)}` : "";
}

/** Label suffix used in the expanded IndicatorBlock header when overridden. */
function tagLabel(baseLabel: string, tag: string | undefined): string {
  return tag ? `${baseLabel} (remote)` : baseLabel;
}

// ---------------------------------------------------------------------------
// Skill-read detection — pi has no dedicated "load skill" tool; per
// dist/core/skills.js's formatSkillsForPrompt, the model is instructed to
// `read` a skill's SKILL.md (or, for ~/.pi/agent/skills & .pi/skills, a root
// .md file directly under a skills/ dir) itself. We just recognize that
// shape of a read call and style it distinctly.
// ---------------------------------------------------------------------------

const SKILL_MD_RE = /(?:^|\/)SKILL\.md$/i;
const SKILL_ROOT_MD_RE = /(?:^|\/)skills\/[^/]+\.md$/i;

function isSkillPath(path: string): boolean {
  return SKILL_MD_RE.test(path) || SKILL_ROOT_MD_RE.test(path);
}

function skillNameFromPath(path: string): string {
  const parts = path.split("/");
  const base = parts[parts.length - 1] ?? path;
  if (/^SKILL\.md$/i.test(base)) return parts[parts.length - 2] ?? base;
  return base.replace(/\.md$/i, "");
}

// ---------------------------------------------------------------------------
// Operations-override registry — how other extensions redirect read/write/
// edit/bash without registering their own tool of the same name.
// ---------------------------------------------------------------------------

export interface OperationsOverride {
  read?: ReadOperations;
  write?: WriteOperations;
  edit?: EditOperations;
  bash?: BashOperations;
  grep?: GrepOperations;
  ls?: LsOperations;
  find?: FindOperations;
  /** Short label shown next to the tool header/status line while active, e.g. "ssh:user@host". */
  tag?: string;
}

/**
 * Stored on globalThis, not a plain module variable: pi loads each
 * extension file through its own independent jiti import graph
 * (moduleCache: false), so another extension's own
 * `import ... from "./stylish-tools.ts"` gets a *different* copy of this
 * module than the one pi actually invoked as the "stylish-tools"
 * extension (the one whose read/write/edit/bash tools are live). A plain
 * module-level `let` would mean setOperationsOverride() from that other
 * copy silently mutates state nobody reads. Symbol.for is the one thing
 * every copy of this module actually shares.
 */
const OPERATIONS_OVERRIDE_GLOBAL_KEY = Symbol.for("llm-garage.pi-custom-extensions.stylish-tools.operations-override");

function readOperationsOverride(): OperationsOverride {
  return (
    ((globalThis as Record<symbol, unknown>)[OPERATIONS_OVERRIDE_GLOBAL_KEY] as OperationsOverride | undefined) ?? {}
  );
}

/** Redirect read/write/edit/bash's I/O. Pass only the ops you want to override. */
export function setOperationsOverride(next: OperationsOverride): void {
  (globalThis as Record<symbol, unknown>)[OPERATIONS_OVERRIDE_GLOBAL_KEY] = next;
}

export function clearOperationsOverride(): void {
  (globalThis as Record<symbol, unknown>)[OPERATIONS_OVERRIDE_GLOBAL_KEY] = {};
}

export function getOperationsOverride(): OperationsOverride {
  return readOperationsOverride();
}

// ---------------------------------------------------------------------------
// Per-tool factories — reused both for the base "read"/"write"/"edit"/"bash"
// registrations below and by other extensions that want the same styling
// under a different tool name (e.g. ssh.ts's "read_remote").
// ---------------------------------------------------------------------------

export interface StylishToolOptions<Ops> {
  /** Tool name as seen by the LLM. Defaults to the built-in's own name. */
  name?: string;
  /** Appended to the description shown to the LLM. */
  extraDescription?: string;
  /** Dynamic operations source. Defaults to the shared operationsOverride registry. */
  getOperations?: () => Ops | undefined;
  /** Dynamic short tag shown next to the label/status when operations are overridden. */
  getTag?: () => string | undefined;
  /**
   * If set, execute() throws this instead of silently falling back to the
   * local tool when getOperations() returns undefined. For a tool whose
   * whole point is to run elsewhere (e.g. a "*_remote" name), running
   * against local files under that name with no indication would be a
   * worse failure mode than a clear error.
   */
  requireOperationsError?: string;
}

export function createStylishBashTool(
  cwd: string,
  timers: Set<NodeJS.Timeout>,
  opts: StylishToolOptions<BashOperations> = {},
) {
  const localTool = createBashTool(cwd);
  const metadata = createBashToolDefinition(cwd);
  const getOps = opts.getOperations ?? (() => readOperationsOverride().bash);
  const getTag = opts.getTag ?? (() => readOperationsOverride().tag);

  return defineTool({
    name: opts.name ?? "bash",
    label: metadata.label,
    description: opts.extraDescription ? `${metadata.description}\n\n${opts.extraDescription}` : metadata.description,
    promptSnippet: metadata.promptSnippet,
    promptGuidelines: metadata.promptGuidelines,
    parameters: metadata.parameters,
    renderShell: "self",

    async execute(toolCallId, params, signal, onUpdate) {
      const ops = getOps();
      if (!ops) {
        if (opts.requireOperationsError) throw new Error(opts.requireOperationsError);
        return localTool.execute(toolCallId, params, signal, onUpdate);
      }
      return createBashTool(cwd, { operations: ops }).execute(toolCallId, params, signal, onUpdate);
    },

    renderCall(args, theme, context) {
      ensureState(context);
      const command = String(args.command ?? "");
      const tag = renderTag(theme, getTag());
      const text = theme.fg("toolTitle", theme.bold("$ bash ")) + theme.fg("accent", command) + tag;
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

      const tag = getTag();
      const extras = [lineCount === 0 ? "no output" : `${lineCount} line${lineCount === 1 ? "" : "s"}`];
      if (details?.truncation?.truncated || details?.fullOutputPath) extras.push("truncated");
      if (tag) extras.unshift("remote");

      if (!expanded) {
        const statusLine = formatStatusLine(theme, status, state, extras, expanded);
        if (lineCount === 0) return new PlainLines([statusLine]);
        const tail = outputLines.slice(-BASH_TAIL_LINES).map((l) => theme.fg("dim", l));
        return new PlainLines([statusLine, ...tail]);
      }

      const body = capLines(outputLines.length ? outputLines : [theme.fg("dim", "(no output)")], theme);
      const footer = formatStatusLine(theme, status, state, extras, expanded);
      return new IndicatorBlock(tagLabel("bash", tag), theme, status, body, footer);
    },
  });
}

export function createStylishReadTool(cwd: string, timers: Set<NodeJS.Timeout>, opts: StylishToolOptions<ReadOperations> = {}) {
  const localTool = createReadTool(cwd);
  const getOps = opts.getOperations ?? (() => readOperationsOverride().read);
  const getTag = opts.getTag ?? (() => readOperationsOverride().tag);

  return defineTool({
    name: opts.name ?? "read",
    label: "read",
    description: opts.extraDescription ? `${localTool.description}\n\n${opts.extraDescription}` : localTool.description,
    parameters: localTool.parameters,
    renderShell: "self",

    async execute(toolCallId, params, signal, onUpdate) {
      const ops = getOps();
      if (!ops) {
        if (opts.requireOperationsError) throw new Error(opts.requireOperationsError);
        return localTool.execute(toolCallId, params, signal, onUpdate);
      }
      return createReadTool(cwd, { operations: ops }).execute(toolCallId, params, signal, onUpdate);
    },

    renderCall(args, theme, context) {
      ensureState(context);
      const extra: string[] = [];
      if (args.offset) extra.push(`offset=${args.offset}`);
      if (args.limit) extra.push(`limit=${args.limit}`);
      const suffix = extra.length ? theme.fg("dim", ` (${extra.join(", ")})`) : "";
      const tag = renderTag(theme, getTag());
      const path = String(args.path ?? "");
      const skill = isSkillPath(path);
      const prefix = skill ? "✦ skill " : "▸ read ";
      const line =
        theme.fg("toolTitle", theme.bold(prefix)) +
        (skill
          ? theme.fg("mdLink", skillNameFromPath(path)) + theme.fg("dim", ` ${path}`)
          : theme.fg("accent", path)) +
        suffix +
        tag;
      return new PlainLines([line]);
    },

    renderResult(result, options, theme, context) {
      const expanded = options.expanded;

      const state = updateRenderState(context, options.isPartial, context.isError, timers);
      const status = state.status;
      const details = result.details as ReadToolDetails | undefined;
      const content = result.content[0];
      const tag = getTag();
      const skill = isSkillPath(String(context.args?.path ?? ""));

      if (content?.type === "image") {
        const extras = tag ? ["remote", "image"] : ["image"];
        const line = formatStatusLine(theme, status, state, extras, expanded);
        return expanded
          ? new IndicatorBlock(tagLabel("read", tag), theme, status, [theme.fg("dim", "(image content)")], line)
          : new PlainLines([line]);
      }

      const text = content?.type === "text" ? content.text : "";
      const lines = text ? text.split("\n") : [];
      const extras = [`${lines.length} line${lines.length === 1 ? "" : "s"}`];
      if (details?.truncation?.truncated) extras.push(`truncated of ${details.truncation.totalLines}`);
      if (skill) extras.unshift("skill");
      if (tag) extras.unshift("remote");

      const statusLine = formatStatusLine(theme, status, state, extras, expanded);
      if (!expanded) return new PlainLines([statusLine, ...buildPreview(theme, lines)]);

      const body = capLines(lines.map((l) => theme.fg("toolOutput", l)), theme);
      return new IndicatorBlock(tagLabel(skill ? "skill" : "read", tag), theme, status, body, statusLine);
    },
  });
}

export function createStylishEditTool(cwd: string, timers: Set<NodeJS.Timeout>, opts: StylishToolOptions<EditOperations> = {}) {
  const localTool = createEditTool(cwd);
  const getOps = opts.getOperations ?? (() => readOperationsOverride().edit);
  const getTag = opts.getTag ?? (() => readOperationsOverride().tag);

  return defineTool({
    name: opts.name ?? "edit",
    label: "edit",
    description: opts.extraDescription ? `${localTool.description}\n\n${opts.extraDescription}` : localTool.description,
    parameters: localTool.parameters,
    renderShell: "self",

    async execute(toolCallId, params, signal, onUpdate) {
      const ops = getOps();
      if (!ops) {
        if (opts.requireOperationsError) throw new Error(opts.requireOperationsError);
        return localTool.execute(toolCallId, params, signal, onUpdate);
      }
      return createEditTool(cwd, { operations: ops }).execute(toolCallId, params, signal, onUpdate);
    },

    renderCall(args, theme, context) {
      ensureState(context);
      const editCount = Array.isArray(args.edits) ? args.edits.length : 1;
      const suffix = editCount > 1 ? theme.fg("dim", ` (${editCount} edits)`) : "";
      const tag = renderTag(theme, getTag());
      const line =
        theme.fg("toolTitle", theme.bold("✎ edit ")) + theme.fg("accent", String(args.path ?? "")) + suffix + tag;
      return new PlainLines([line]);
    },

    renderResult(result, options, theme, context) {
      const state = updateRenderState(context, options.isPartial, context.isError, timers);
      const status = state.status;
      const details = result.details as EditToolDetails | undefined;
      const content = result.content[0];
      const tag = getTag();

      // Matches pi's own edit tool: the diff always renders in full,
      // regardless of collapse/expand state (Ctrl+O has no effect here).
      if (context.isError) {
        const errText = content?.type === "text" ? content.text.split("\n")[0] : "error";
        const extras = tag ? ["remote", errText] : [errText];
        const statusLine = formatStatusLine(theme, status, state, extras, true);
        return new IndicatorBlock(
          tagLabel("edit", tag),
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

      const extras = tag ? ["remote", diffStat] : [diffStat];
      const statusLine = formatStatusLine(theme, status, state, extras, true);
      const body = capLines(
        diffLines.map((line) => colorDiffLine(theme, line)),
        theme,
      );
      return new IndicatorBlock(tagLabel("edit", tag), theme, status, body, statusLine);
    },
  });
}

export function createStylishWriteTool(cwd: string, timers: Set<NodeJS.Timeout>, opts: StylishToolOptions<WriteOperations> = {}) {
  const localTool = createWriteTool(cwd);
  const getOps = opts.getOperations ?? (() => readOperationsOverride().write);
  const getTag = opts.getTag ?? (() => readOperationsOverride().tag);

  return defineTool({
    name: opts.name ?? "write",
    label: "write",
    description: opts.extraDescription ? `${localTool.description}\n\n${opts.extraDescription}` : localTool.description,
    parameters: localTool.parameters,
    renderShell: "self",

    async execute(toolCallId, params, signal, onUpdate) {
      const ops = getOps();
      if (!ops) {
        if (opts.requireOperationsError) throw new Error(opts.requireOperationsError);
        return localTool.execute(toolCallId, params, signal, onUpdate);
      }
      return createWriteTool(cwd, { operations: ops }).execute(toolCallId, params, signal, onUpdate);
    },

    renderCall(args, theme, context) {
      ensureState(context);
      const lineCount = String(args.content ?? "").split("\n").length;
      const tag = renderTag(theme, getTag());
      const line =
        theme.fg("toolTitle", theme.bold("✎ write ")) +
        theme.fg("accent", String(args.path ?? "")) +
        theme.fg("dim", ` (${lineCount} lines)`) +
        tag;
      return new PlainLines([line]);
    },

    renderResult(result, options, theme, context) {
      const expanded = options.expanded;

      const state = updateRenderState(context, options.isPartial, context.isError, timers);
      const status = state.status;
      const content = result.content[0];
      const tag = getTag();

      if (context.isError) {
        const errText = content?.type === "text" ? content.text.split("\n")[0] : "error";
        const extras = tag ? ["remote", errText] : [errText];
        const statusLine = formatStatusLine(theme, status, state, extras, expanded);
        return new PlainLines([statusLine]);
      }

      const writtenContent = String((context.args as { content?: string } | undefined)?.content ?? "");
      const lines = writtenContent ? writtenContent.split("\n") : [];
      const extras = tag ? ["remote", `${lines.length} lines`] : [`${lines.length} lines`];
      const statusLine = formatStatusLine(theme, status, state, extras, expanded);

      if (!expanded) return new PlainLines([statusLine, ...buildPreview(theme, lines, WRITE_PREVIEW_LINES)]);

      const body = capLines(lines.map((l) => theme.fg("toolOutput", l)), theme);
      return new IndicatorBlock(tagLabel("write", tag), theme, status, body, statusLine);
    },
  });
}

export function createStylishGrepTool(cwd: string, timers: Set<NodeJS.Timeout>, opts: StylishToolOptions<GrepOperations> = {}) {
  const localTool = createGrepTool(cwd);
  const getOps = opts.getOperations ?? (() => readOperationsOverride().grep);
  const getTag = opts.getTag ?? (() => readOperationsOverride().tag);

  return defineTool({
    name: opts.name ?? "grep",
    label: "grep",
    description: opts.extraDescription ? `${localTool.description}\n\n${opts.extraDescription}` : localTool.description,
    parameters: localTool.parameters,
    renderShell: "self",

    async execute(toolCallId, params, signal, onUpdate) {
      const ops = getOps();
      if (!ops) {
        if (opts.requireOperationsError) throw new Error(opts.requireOperationsError);
        return localTool.execute(toolCallId, params, signal, onUpdate);
      }
      return createGrepTool(cwd, { operations: ops }).execute(toolCallId, params, signal, onUpdate);
    },

    renderCall(args, theme, context) {
      ensureState(context);
      const path = args.path ? theme.fg("dim", ` in ${args.path}`) : "";
      const tag = renderTag(theme, getTag());
      const line =
        theme.fg("toolTitle", theme.bold("⌕ grep ")) + theme.fg("accent", String(args.pattern ?? "")) + path + tag;
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
      const tag = getTag();

      const extras = [`${matchCount} match${matchCount === 1 ? "" : "es"}`];
      if (details?.matchLimitReached) extras.push("limit reached");
      if (tag) extras.unshift("remote");

      const statusLine = formatStatusLine(theme, status, state, extras, expanded);
      if (!expanded) return new PlainLines([statusLine, ...buildPreview(theme, lines, GREP_PREVIEW_LINES)]);

      const body = capLines(
        noMatches ? [theme.fg("dim", "(no matches)")] : lines.map((l) => theme.fg("toolOutput", l)),
        theme,
      );
      return new IndicatorBlock(tagLabel("grep", tag), theme, status, body, statusLine);
    },
  });
}

export function createStylishLsTool(cwd: string, timers: Set<NodeJS.Timeout>, opts: StylishToolOptions<LsOperations> = {}) {
  const localTool = createLsTool(cwd);
  const getOps = opts.getOperations ?? (() => readOperationsOverride().ls);
  const getTag = opts.getTag ?? (() => readOperationsOverride().tag);

  return defineTool({
    name: opts.name ?? "ls",
    label: "ls",
    description: opts.extraDescription ? `${localTool.description}\n\n${opts.extraDescription}` : localTool.description,
    parameters: localTool.parameters,
    renderShell: "self",

    async execute(toolCallId, params, signal, onUpdate) {
      const ops = getOps();
      if (!ops) {
        if (opts.requireOperationsError) throw new Error(opts.requireOperationsError);
        return localTool.execute(toolCallId, params, signal, onUpdate);
      }
      return createLsTool(cwd, { operations: ops }).execute(toolCallId, params, signal, onUpdate);
    },

    renderCall(args, theme, context) {
      ensureState(context);
      const tag = renderTag(theme, getTag());
      const line = theme.fg("toolTitle", theme.bold("▸ ls ")) + theme.fg("accent", String(args.path ?? ".")) + tag;
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
      const tag = getTag();

      const extras = [`${entryCount} entr${entryCount === 1 ? "y" : "ies"}`];
      if (details?.entryLimitReached) extras.push("limit reached");
      if (tag) extras.unshift("remote");

      const statusLine = formatStatusLine(theme, status, state, extras, expanded);
      if (!expanded) return new PlainLines([statusLine, ...buildPreview(theme, lines, LS_PREVIEW_LINES)]);

      const body = capLines(
        empty ? [theme.fg("dim", "(empty directory)")] : lines.map((l) => theme.fg("toolOutput", l)),
        theme,
      );
      return new IndicatorBlock(tagLabel("ls", tag), theme, status, body, statusLine);
    },
  });
}

export function createStylishFindTool(cwd: string, timers: Set<NodeJS.Timeout>, opts: StylishToolOptions<FindOperations> = {}) {
  const localTool = createFindTool(cwd);
  const getOps = opts.getOperations ?? (() => readOperationsOverride().find);
  const getTag = opts.getTag ?? (() => readOperationsOverride().tag);

  return defineTool({
    name: opts.name ?? "find",
    label: "find",
    description: opts.extraDescription ? `${localTool.description}\n\n${opts.extraDescription}` : localTool.description,
    parameters: localTool.parameters,
    renderShell: "self",

    async execute(toolCallId, params, signal, onUpdate) {
      const ops = getOps();
      if (!ops) {
        if (opts.requireOperationsError) throw new Error(opts.requireOperationsError);
        return localTool.execute(toolCallId, params, signal, onUpdate);
      }
      return createFindTool(cwd, { operations: ops }).execute(toolCallId, params, signal, onUpdate);
    },

    renderCall(args, theme, context) {
      ensureState(context);
      const path = args.path ? theme.fg("dim", ` in ${args.path}`) : "";
      const tag = renderTag(theme, getTag());
      const line =
        theme.fg("toolTitle", theme.bold("⌕ find ")) + theme.fg("accent", String(args.pattern ?? "")) + path + tag;
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
      const tag = getTag();

      const extras = [`${resultCount} result${resultCount === 1 ? "" : "s"}`];
      if (details?.resultLimitReached) extras.push("limit reached");
      if (tag) extras.unshift("remote");

      const statusLine = formatStatusLine(theme, status, state, extras, expanded);
      if (!expanded) return new PlainLines([statusLine, ...buildPreview(theme, lines, FIND_PREVIEW_LINES)]);

      const body = capLines(
        noResults ? [theme.fg("dim", "(no results)")] : lines.map((l) => theme.fg("toolOutput", l)),
        theme,
      );
      return new IndicatorBlock(tagLabel("find", tag), theme, status, body, statusLine);
    },
  });
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  const cwd = process.cwd();
  const timers = new Set<NodeJS.Timeout>();

  pi.registerTool(createStylishBashTool(cwd, timers));
  pi.registerTool(createStylishReadTool(cwd, timers));
  pi.registerTool(createStylishEditTool(cwd, timers));
  pi.registerTool(createStylishWriteTool(cwd, timers));
  pi.registerTool(createStylishGrepTool(cwd, timers));
  pi.registerTool(createStylishLsTool(cwd, timers));
  pi.registerTool(createStylishFindTool(cwd, timers));

  pi.on("session_shutdown", async () => {
    for (const timer of timers) clearInterval(timer);
    timers.clear();
    clearOperationsOverride();
  });
}
