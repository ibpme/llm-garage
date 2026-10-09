import {
  createBashToolDefinition,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
  defineTool,
  getShellConfig,
  type BashOperations,
  type BashToolDetails,
  type BashToolOptions,
  type EditOperations,
  type EditToolDetails,
  type FindOperations,
  type FindToolDetails,
  type GrepOperations,
  type GrepToolDetails,
  type LsOperations,
  type LsToolDetails,
  type ReadOperations,
  type ReadToolDetails,
  type WriteOperations,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { getOperationsOverride } from "./overrides.ts";
import {
  BASH_TAIL_LINES,
  buildPreview,
  capLines,
  colorDiffLine,
  countNonEmptyLines,
  ensureState,
  FIND_PREVIEW_LINES,
  formatStatusLine,
  getTextOutput,
  GREP_PREVIEW_LINES,
  IndicatorBlock,
  isSkillPath,
  LS_PREVIEW_LINES,
  PlainLines,
  refineBashStatus,
  renderTag,
  skillNameFromPath,
  tagLabel,
  updateRenderState,
  WRITE_PREVIEW_LINES,
} from "./rendering.ts";

// ---------------------------------------------------------------------------
// Per-tool factories — reused both for the base "read"/"write"/"edit"/"bash"
// registrations below and by other extensions that want the same styling
// under a different tool name (e.g. SSH's "read_remote").
// ---------------------------------------------------------------------------

export interface StylishToolOptions<Ops> {
  /** Tool name as seen by the LLM. Defaults to the built-in's own name. */
  name?: string;
  /** Placed before the built-in description so alternate tool destinations are immediately visible to the LLM. */
  extraDescription?: string;
  /** Override the short system-prompt tool summary (used by bash). */
  promptSnippet?: string;
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
  opts: StylishToolOptions<BashOperations> & {
    getBashOptions?: () => Pick<BashToolOptions, "shellPath" | "commandPrefix">;
  } = {},
) {
  const metadata = createBashToolDefinition(cwd);
  const getOps = opts.getOperations ?? (() => getOperationsOverride().bash);
  const getTag = opts.getTag ?? (() => getOperationsOverride().tag);
  const getBashOptions = () => {
    const options = opts.getBashOptions?.() ?? {};
    const shellPath = options.shellPath?.startsWith("~/")
      ? join(homedir(), options.shellPath.slice(2))
      : options.shellPath;
    return { ...options, shellPath };
  };
  const getLabel = () => {
    if (getOps() || opts.requireOperationsError) return "bash";
    const { shellPath } = getBashOptions();
    const shellName = basename(getShellConfig(shellPath).shell).replace(/\.exe$/i, "");
    return shellName === "bash" ? "bash" : `bash (${shellName})`;
  };

  return defineTool({
    name: opts.name ?? "bash",
    get label() { return getLabel(); },
    description: opts.extraDescription ? `${opts.extraDescription}\n\n${metadata.description}` : metadata.description,
    promptSnippet: opts.promptSnippet ?? metadata.promptSnippet,
    promptGuidelines: metadata.promptGuidelines,
    parameters: metadata.parameters,
    renderShell: "self",

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const ops = getOps();
      if (!ops && opts.requireOperationsError) throw new Error(opts.requireOperationsError);
      // Local startup files must not be injected into remote/custom operations.
      const options = ops ? { operations: ops } : getBashOptions();
      return createBashToolDefinition(ctx.cwd, options).execute(toolCallId, params, signal, onUpdate, ctx);
    },

    renderCall(args, theme, context) {
      ensureState(context);
      const command = String(args.command ?? "");
      const tag = renderTag(theme, getTag());
      const text =
        theme.fg("toolTitle", theme.bold(`$ ${getLabel()}`)) + tag + " " + theme.fg("accent", command);
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
      return new IndicatorBlock(tagLabel(getLabel(), tag), theme, status, body, footer);
    },
  });
}

export function createStylishReadTool(cwd: string, timers: Set<NodeJS.Timeout>, opts: StylishToolOptions<ReadOperations> = {}) {
  const localTool = createReadTool(cwd);
  const getOps = opts.getOperations ?? (() => getOperationsOverride().read);
  const getTag = opts.getTag ?? (() => getOperationsOverride().tag);

  return defineTool({
    name: opts.name ?? "read",
    label: "read",
    description: opts.extraDescription ? `${opts.extraDescription}\n\n${localTool.description}` : localTool.description,
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
      const prefix = skill ? "✦ skill" : "▸ read";
      const line =
        theme.fg("toolTitle", theme.bold(prefix)) +
        tag +
        " " +
        (skill
          ? theme.fg("mdLink", skillNameFromPath(path)) + theme.fg("dim", ` ${path}`)
          : theme.fg("accent", path)) +
        suffix;
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
  const getOps = opts.getOperations ?? (() => getOperationsOverride().edit);
  const getTag = opts.getTag ?? (() => getOperationsOverride().tag);

  return defineTool({
    name: opts.name ?? "edit",
    label: "edit",
    description: opts.extraDescription ? `${opts.extraDescription}\n\n${localTool.description}` : localTool.description,
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
        theme.fg("toolTitle", theme.bold("✎ edit")) +
        tag +
        " " +
        theme.fg("accent", String(args.path ?? "")) +
        suffix;
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
  const getOps = opts.getOperations ?? (() => getOperationsOverride().write);
  const getTag = opts.getTag ?? (() => getOperationsOverride().tag);

  return defineTool({
    name: opts.name ?? "write",
    label: "write",
    description: opts.extraDescription ? `${opts.extraDescription}\n\n${localTool.description}` : localTool.description,
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
        theme.fg("toolTitle", theme.bold("✎ write")) +
        tag +
        " " +
        theme.fg("accent", String(args.path ?? "")) +
        theme.fg("dim", ` (${lineCount} lines)`);
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
  const getOps = opts.getOperations ?? (() => getOperationsOverride().grep);
  const getTag = opts.getTag ?? (() => getOperationsOverride().tag);

  return defineTool({
    name: opts.name ?? "grep",
    label: "grep",
    description: opts.extraDescription ? `${opts.extraDescription}\n\n${localTool.description}` : localTool.description,
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
        theme.fg("toolTitle", theme.bold("⌕ grep")) +
        tag +
        " " +
        theme.fg("accent", String(args.pattern ?? "")) +
        path;
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
  const getOps = opts.getOperations ?? (() => getOperationsOverride().ls);
  const getTag = opts.getTag ?? (() => getOperationsOverride().tag);

  return defineTool({
    name: opts.name ?? "ls",
    label: "ls",
    description: opts.extraDescription ? `${opts.extraDescription}\n\n${localTool.description}` : localTool.description,
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
      const line =
        theme.fg("toolTitle", theme.bold("▸ ls")) + tag + " " + theme.fg("accent", String(args.path ?? "."));
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
  const getOps = opts.getOperations ?? (() => getOperationsOverride().find);
  const getTag = opts.getTag ?? (() => getOperationsOverride().tag);

  return defineTool({
    name: opts.name ?? "find",
    label: "find",
    description: opts.extraDescription ? `${opts.extraDescription}\n\n${localTool.description}` : localTool.description,
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
        theme.fg("toolTitle", theme.bold("⌕ find")) +
        tag +
        " " +
        theme.fg("accent", String(args.pattern ?? "")) +
        path;
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
