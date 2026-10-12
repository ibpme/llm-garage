import { realpathSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { StringEnum, type Usage } from "@earendil-works/pi-ai";
import { getAgentDir, type AgentToolResult, type AgentToolUpdateCallback, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { AgentJobs, MAX_ACTIVE_PER_OWNER, type JobSnapshot, type StartRequest } from "../shared/agent-jobs/jobs.ts";
import { publishForegroundWaits } from "../shared/agent-jobs/foreground.ts";
import { isTerminal } from "../shared/agent-jobs/store.ts";
import { loadShortcutKeys } from "../shared/shortcut-config.ts";
import { emptyUsage, oneLine, type RunDetails } from "./events.ts";
import { keyLabel, renderRun } from "./rendering.ts";
import { contextWindowResolver, contextWindowTable } from "./context-window.ts";
import { envRole, hasRoleEntry, restoreRole, ROLE_ENTRY, type Role, type SavedEntry } from "./role.ts";
import { EFFORT_LEVELS, resolveBackend } from "./backend.ts";
import { CONFIG_FILE, loadConfig } from "./config.ts";
import { AttachedWaits, type AttachedWait } from "./foreground.ts";
import { addUsage, jobLabel, outstandingText, receiptText, resultText, runDetails, summaryLine } from "./job-results.ts";
import { JobWatcher, NOTICE_TYPE, type NoticeDetails } from "./job-watcher.ts";

const TOOL_NAME = "oneshot_subagent";
const JOBS_TOOL_NAME = "subagent_jobs";
const CONTEXT_TYPE = "subagent-jobs-outstanding";
export const BACKGROUND_SHORTCUT_ACTION = "extensions.oneshotSubagent.background";
export const DEFAULT_BACKGROUND_KEYS = ["shift+up"] as const;
const here = dirname(realpathSync(fileURLToPath(import.meta.url)));
const launcher = resolve(here, "../../scripts/agent-spawn.sh");
const supervisor = resolve(here, "supervisor.ts");

export interface ReceiptDetails {
  kind: "background-receipt";
  jobId: string;
  name: string;
  agent: string;
  model?: string;
  cwd: string;
  task: string;
  state: string;
  dir: string;
  createdAt: number;
  /** Sent to the background from a foreground wait rather than launched there. */
  backgrounded?: boolean;
}

export interface OneshotOptions {
  /** Defaults to oneshot-subagent.json in Pi's agent directory. */
  configPath?: string;
  /** Defaults to keybindings.json in Pi's agent directory. */
  keybindingsPath?: string;
}

interface JobsToolDetails { action: string; jobs: { id: string; name: string; state: string; liveness: string }[] }

const text = (value: string) => [{ type: "text" as const, text: value }];

export default function oneshotSubagentExtension(pi: ExtensionAPI, jobs = new AgentJobs({ supervisor }), options: OneshotOptions = {}) {
  const { config, warnings } = loadConfig(options.configPath ?? join(getAgentDir(), CONFIG_FILE));
  const baseRole = envRole();
  let role: Role = baseRole;
  let registered = false;
  let warned = false;
  // Launches and still-attached foreground waits belong to this runtime and are
  // cancelled at shutdown; accepted background jobs never are.
  const live = new Map<AbortController, Promise<unknown>>();
  const waits = new AttachedWaits();
  let unpublish: (() => void) | undefined;
  let watcher: JobWatcher | undefined;

  const track = <T>(signal: AbortSignal | undefined, run: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) abort();
    signal?.addEventListener("abort", abort, { once: true });
    const promise = run(controller.signal);
    live.set(controller, promise);
    return promise.finally(() => {
      live.delete(controller);
      signal?.removeEventListener("abort", abort);
    });
  };

  pi.on("session_start", async (_event, ctx) => {
    const saved: SavedEntry[] = ctx.sessionManager.getEntries().flatMap((entry) =>
      entry.type === "custom" && entry.customType === ROLE_ENTRY
        ? [{ customType: entry.customType, data: entry.data }] : []);
    role = restoreRole(baseRole, saved);
    watcher?.stop();
    watcher = undefined;
    // Register only once the role is known: a tool cannot be unregistered, and a
    // resumed child session may carry no environment marker.
    if (role === "child") {
      if (!hasRoleEntry(saved)) pi.appendEntry(ROLE_ENTRY, { version: 1, role });
      return;
    }
    if (!registered) {
      registered = true;
      registerTools();
    }
    if (!warned && warnings.length && ctx.hasUI) ctx.ui.notify(`One-shot subagent config: ${warnings.join("; ")}`, "warning");
    warned = true;
    unpublish ??= publishForegroundWaits(waits);
    watcher = new JobWatcher(pi, jobs, ctx, config.completionNotice);
    watcher.start();
  });
  pi.on("session_shutdown", async () => {
    watcher?.stop();
    watcher = undefined;
    unpublish?.();
    unpublish = undefined;
    for (const controller of live.keys()) controller.abort();
    await Promise.allSettled(live.values());
    live.clear();
  });
  pi.on("context", async (event, ctx) => {
    if (role === "child" || !registered) return;
    const owned = await jobs.list({ owner: ctx.sessionManager.getSessionId() }).catch(() => []);
    const reminder = outstandingText(owned);
    if (!reminder) return;
    // Appended last so the cached prompt prefix is unchanged; never persisted.
    return { messages: [...event.messages, { role: "custom", customType: CONTEXT_TYPE, content: reminder, display: false, timestamp: Date.now() }] };
  });

  pi.registerMessageRenderer<NoticeDetails>(NOTICE_TYPE, (message, _options, theme) => {
    const items = message.details?.jobs ?? [];
    const line = (item: NoticeDetails["jobs"][number]) => {
      const tone = item.state === "succeeded" ? "success" : item.state === "cancelled" ? "warning" : "error";
      return `${theme.fg(tone, item.state === "succeeded" ? "✓" : "✗")} ${oneLine(item.name, 64)} ${theme.fg("dim", item.id)} ` +
        theme.fg(tone, item.state) + (item.reason && item.state !== "succeeded" ? theme.fg("dim", ` · ${oneLine(item.reason, 160)}`) : "");
    };
    return new Text(theme.fg("accent", "◆ background subagents finished") + theme.fg("dim", "  /agents to inspect") +
      items.map((item) => `\n  ${line(item)}`).join(""), 0, 0);
  });

  pi.registerCommand("jobs-indicator", {
    description: "Toggle the background subagent indicator between compact and expanded",
    handler: async (args, ctx) => {
      if (!watcher) { ctx.ui.notify("Background subagents are unavailable in this session.", "warning"); return; }
      const choice = args.trim();
      if (choice && choice !== "compact" && choice !== "expanded") { ctx.ui.notify("Usage: /jobs-indicator [compact|expanded]", "warning"); return; }
      watcher.expanded = choice ? choice === "expanded" : !watcher.expanded;
      watcher.render();
    },
  });

  const backgroundKeys = config.allowBackgroundShortcut
    ? loadShortcutKeys(options.keybindingsPath ?? join(getAgentDir(), "keybindings.json"), BACKGROUND_SHORTCUT_ACTION, DEFAULT_BACKGROUND_KEYS) : [];
  for (const key of backgroundKeys) pi.registerShortcut(key, { description: "Send a foreground one-shot subagent to the background", handler: sendToBackground });
  const backgroundHint = backgroundKeys.length ? backgroundKeys.map(keyLabel).join("/") : undefined;

  async function sendToBackground(ctx: ExtensionContext): Promise<void> {
    if (role === "child" || !registered) return;
    const owner = ctx.sessionManager.getSessionId();
    const eligible = waits.attached(owner);
    if (!eligible.length) { ctx.ui.notify("No foreground subagent is running.", "info"); return; }
    let target = eligible[0];
    if (eligible.length > 1) {
      const labels = eligible.map((job) => `${oneLine(job.name, 64)} (${job.jobId})`);
      const choice = await ctx.ui.select("Send which subagent to the background?", labels);
      if (choice === undefined) return;
      target = eligible[labels.indexOf(choice)];
    }
    const outcome = await waits.sendToBackground(target.jobId, owner);
    ctx.ui.notify(outcome === "backgrounded" ? `Sent ${oneLine(target.name, 64)} to the background.`
      : outcome === "completed" ? `${oneLine(target.name, 64)} already finished; its answer is being returned.`
      : `${oneLine(target.name, 64)} is no longer waiting in the foreground.`, "info");
  }

  const owned = async (id: string, ctx: ExtensionContext): Promise<JobSnapshot> => {
    const job = await jobs.inspect(id);
    // Other sessions' jobs are indistinguishable from missing ones.
    if (!job || job.request.owner.sessionId !== ctx.sessionManager.getSessionId()) throw new Error(`No subagent job ${id} in this session`);
    return job;
  };

  /** Marks terminal jobs delivered and claims their usage exactly once across all retrievals. */
  const retrieve = async (selected: JobSnapshot[]): Promise<{ text: string; isError: boolean; usage?: Usage }> => {
    const usage = emptyUsage();
    let claimed = false;
    let isError = false;
    const parts: string[] = [];
    for (const job of selected) {
      const result = await resultText(job);
      parts.push(result.text);
      if (!isTerminal(job.status.state)) continue;
      isError ||= result.isError;
      await jobs.mark(job.id, "delivered");
      if (job.status.usage && await jobs.mark(job.id, "usage-delivered")) {
        addUsage(usage, job.status.usage);
        claimed = true;
      }
    }
    return { text: parts.join("\n\n---\n\n"), isError, usage: claimed ? usage : undefined };
  };

  const jobsDetails = (action: string, selected: JobSnapshot[]): JobsToolDetails => ({ action,
    jobs: selected.map((job) => ({ id: job.id, name: job.request.name, state: job.status.state, liveness: job.liveness })) });

  const receipt = (job: JobSnapshot, task: string, backgrounded: boolean): AgentToolResult<ReceiptDetails> => ({
    content: text(receiptText(job, backgrounded)),
    details: { kind: "background-receipt", jobId: job.id, name: job.request.name, agent: job.request.agent, model: job.request.model,
      cwd: job.request.cwd, task, state: job.status.state, dir: job.dir, createdAt: job.request.createdAt, backgrounded },
  });

  /**
   * Holds the tool call open on a supervised job until it finishes, the call is
   * cancelled (which cancels the job), or the user releases it to the background.
   */
  async function follow(job: JobSnapshot, task: string, wait: AttachedWait, signal: AbortSignal,
    onUpdate: AgentToolUpdateCallback<RunDetails | ReceiptDetails> | undefined): Promise<AgentToolResult<RunDetails | ReceiptDetails>> {
    signal.addEventListener("abort", () => wait.notify(), { once: true });
    // A call, so the check is repeated after every await rather than narrowed away.
    const released = () => wait.settled === "background";
    let current = job;
    while (true) {
      if (released()) return receipt(current, task, true);
      // The supervisor enforces the deadline; this only bounds the wait if the supervisor is lost.
      const overdue = !isTerminal(current.status.state) && Date.now() > current.request.deadline + 30_000;
      if ((signal.aborted || overdue) && wait.settle("cancelled")) {
        const { job: stopped = current } = await jobs.cancel(current.id, wait.owner);
        if (!isTerminal(stopped.status.state)) {
          return { content: text(`Cancellation of ${jobLabel(stopped)} was requested; it is still stopping.\n\n[Subagent job ${stopped.id}: ${stopped.dir}]`),
            details: { ...runDetails(stopped, task), status: "aborted" }, isError: true };
        }
        // Cancellation can lose to completion; a finished answer is still an answer.
        const result = await retrieve([stopped]);
        return { content: text(result.text), details: runDetails(stopped, task, result.text), usage: result.usage,
          isError: stopped.status.state !== "succeeded" };
      }
      const next = await jobs.inspect(current.id);
      if (!next) throw new Error(`Subagent job record disappeared: ${current.dir}`);
      current = next;
      if (released()) return receipt(current, task, true);
      if (isTerminal(current.status.state) && wait.settle("completed")) {
        const result = await retrieve([current]);
        return { content: text(result.text), details: runDetails(current, task, result.text), usage: result.usage,
          isError: current.status.state !== "succeeded" };
      }
      onUpdate?.({ content: text(current.status.details.activity.at(-1) ?? `Running ${current.request.agent}…`), details: runDetails(current, task) });
      await Promise.race([sleep(250), wait.wake]);
    }
  }

  async function launch(request: StartRequest, toolSignal: AbortSignal | undefined, onUpdate: AgentToolUpdateCallback<RunDetails | ReceiptDetails> | undefined,
    initial: RunDetails): Promise<AgentToolResult<RunDetails | ReceiptDetails>> {
    if (request.mode === "background") return receipt(await track(toolSignal, (abort) => jobs.start(request, abort)), request.task, false);
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (toolSignal?.aborted) abort();
    toolSignal?.addEventListener("abort", abort, { once: true });
    let wait: AttachedWait | undefined;
    const run = (async () => {
      onUpdate?.({ content: text(`Starting ${request.agent}…`), details: initial });
      let job: JobSnapshot;
      try { job = await jobs.start(request, controller.signal); }
      catch (error) {
        if (!controller.signal.aborted) throw error;
        return { content: text("One-shot subagent was cancelled."), details: { ...initial, status: "aborted" as const, result: "One-shot subagent was cancelled." }, isError: true };
      }
      wait = waits.attach({ jobId: job.id, name: request.name, owner: request.owner.sessionId });
      wait.onBackground = async () => {
        // Detach from shutdown and Esc before anything can observe the release.
        live.delete(controller);
        toolSignal?.removeEventListener("abort", abort);
        await jobs.mark(job.id, "backgrounded");
      };
      return follow(job, request.task, wait, controller.signal, onUpdate);
    })();
    live.set(controller, run);
    try { return await run; }
    finally {
      live.delete(controller);
      toolSignal?.removeEventListener("abort", abort);
      if (wait) waits.detach(wait);
    }
  }

  function registerTools() {
    const foregroundDefault = config.defaultMode === "foreground";
    const waking = config.completionNotice !== "passive";
    pi.registerTool({
      name: TOOL_NAME,
      exposure: "direct",
      label: "One-shot subagent",
      renderShell: "self",
      description: "Delegate a complete, self-contained task to a fresh Pi or Claude Code agent via agent-spawn.sh in JSON mode. " +
        `Default mode here: "${config.defaultMode}". Mode "foreground" waits and returns the final answer; the user may send it to the background, ` +
        `in which case the call returns a job receipt instead. Mode "background" returns a job receipt immediately while the child runs independently. ` +
        `Collect a receipt's answer later with ${JOBS_TOOL_NAME}. ` +
        "The child has its own tools/configuration and can edit files or run commands. " +
        "It does not see this conversation and does not resume earlier delegations. Children are leaves and cannot delegate further. " +
        "Defaults to the current working directory. Pi inherits model/thinking; Claude uses its own defaults. Delegation remains available in SAFE mode.",
      promptSnippet: `oneshot_subagent: delegate a standalone task to a fresh Pi or Claude Code agent; ${foregroundDefault
        ? "waits for the answer by default" : "runs in the background by default"} (receipts are collected with ${JOBS_TOOL_NAME})`,
      promptGuidelines: [
        "Give oneshot_subagent all necessary context, file paths, constraints, and expected deliverables; it cannot see the parent conversation.",
        `A receipt is not an answer. After one, keep working on independent tasks and retrieve the result with ${JOBS_TOOL_NAME} before relying on it or claiming dependent work is complete.`,
        waking
          ? `A completion notice arrives as a new message when a background job finishes; if you have nothing else to do, end your turn instead of polling ${JOBS_TOOL_NAME}.`
          : `Completion notices do not start a turn; use mode "foreground" when you are blocked on the answer.`,
        foregroundDefault
          ? 'Pass mode "background" when you have independent work to do while the subagent runs.'
          : 'Pass mode "foreground" only when you are blocked on the answer.',
        "Avoid concurrent agents editing the same files, and do not edit files a running background job may change. The child is not a sandbox and has its own tool permissions, but it cannot delegate further.",
      ],
      annotations: { destructiveHint: true, openWorldHint: true },
      parameters: Type.Object({
        agent: Type.Optional(StringEnum(["pi", "claude"] as const, { description: "Backend (default pi)" })),
        task: Type.String({ minLength: 1, description: "Complete standalone task, including context and expected output" }),
        mode: Type.Optional(StringEnum(["background", "foreground"] as const, {
          description: `foreground: wait for the final answer; background: return a job receipt now (default ${config.defaultMode})` })),
        name: Type.Optional(Type.String({ pattern: "^[a-zA-Z0-9][a-zA-Z0-9_-]*$", maxLength: 64, description: "Short task label shown in the TUI and job files" })),
        cwd: Type.Optional(Type.String({ description: "Working directory, relative to the main agent's cwd or absolute" })),
        model: Type.Optional(Type.String({ description: "Backend-specific model ID or alias; model:level supported. Pi inherits the parent; Claude uses its configured default" })),
        provider: Type.Optional(Type.String({ description: "Pi provider restriction; requires an explicit model for Pi, ignored for Claude" })),
        thinking: Type.Optional(StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const)),
        effort: Type.Optional(StringEnum(EFFORT_LEVELS, { description: "Shared reasoning level: Pi --thinking / Claude --effort. Alias of thinking for common levels; explicit level overrides model suffix" })),
        timeout_seconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 3600, description: "Total time limit in seconds, fixed at launch (default 600 in foreground, 1800 in background)" })),
      }),
      async execute(toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult<RunDetails | ReceiptDetails>> {
        if (role === "child") throw new Error("One-shot subagents cannot delegate");
        if (!params.task.trim()) throw new Error("Task must not be blank");
        const backend = resolveBackend(params, ctx);
        const mode = params.mode ?? config.defaultMode;
        const name = params.name ?? "subagent";
        const initial: RunDetails = { name, task: params.task, cwd: resolve(ctx.cwd, params.cwd ?? "."), agent: backend.agent, model: backend.model,
          status: "running", activity: [], preview: "", turns: 0, toolCalls: 0, durationMs: 0 };
        if (mode === "foreground" && signal?.aborted)
          return { content: text("One-shot subagent was cancelled."), details: { ...initial, status: "aborted", result: "One-shot subagent was cancelled." }, isError: true };
        const owner = ctx.sessionManager.getSessionId();
        if (mode === "background") {
          const active = await jobs.list({ owner, active: true });
          if (active.length >= MAX_ACTIVE_PER_OWNER) {
            throw new Error(`At most ${MAX_ACTIVE_PER_OWNER} background subagent jobs may run at once in this session; active: ` +
              `${active.map((job) => jobLabel(job)).join(", ")}. Wait for, retrieve or cancel one with ${JOBS_TOOL_NAME}, or use mode "foreground".`);
          }
        }
        const cwd = await realpath(initial.cwd);
        // Pi fuzzy-matches an explicit --model, so only an inherited model narrows the table to one ID.
        const contextWindows = backend.agent === "pi"
          ? contextWindowTable(ctx.modelRegistry, await contextWindowResolver(ctx.modelRegistry), params.model ? undefined : backend.model) : undefined;
        return launch({
          name, task: params.task, cwd, ...backend, mode, contextWindows,
          timeoutSeconds: params.timeout_seconds ?? (mode === "foreground" ? 600 : 1800), launcher,
          owner: { sessionId: owner, sessionFile: ctx.sessionManager.getSessionFile(), toolCallId,
            branchAnchor: ctx.sessionManager.getLeafId() ?? undefined },
        }, signal, onUpdate, { ...initial, cwd });
      },
      renderCall(args, theme) {
        const mode = args.mode ?? config.defaultMode;
        return new Text(
          theme.fg("toolTitle", theme.bold("◆ one-shot subagent")) + theme.fg("accent", `  ${oneLine(args.name ?? "subagent", 64)}`) + theme.fg("dim", ` · ${args.agent ?? "pi"}`) +
          (args.model ? theme.fg("dim", ` · ${oneLine(args.model, 80)}`) : "") + theme.fg("dim", ` · ${mode}`) +
          `\n${theme.fg("muted", "  Task ")} ${theme.fg("toolOutput", oneLine(args.task ?? "…", 240))}`, 0, 0);
      },
      renderResult(result, { expanded }, theme) {
        const details = result.details as RunDetails | ReceiptDetails | undefined;
        if (details && "kind" in details && details.kind === "background-receipt") {
          const label = details.backgrounded ? "◌ sent to background · job " : "◌ background job ";
          const state = details.state === "running" ? "" : ` · ${details.state}`;
          return new Text(theme.fg("borderMuted", "│ ") + theme.fg("accent", label) + theme.fg("toolOutput", details.jobId) +
            theme.fg("dim", `${state} · ${details.agent}${details.model ? ` · ${oneLine(details.model, 60)}` : ""} · receipt, not an answer · /agents to inspect`) +
            (expanded ? `\n${theme.fg("borderMuted", "│ ")}${theme.fg("dim", `cwd: ${details.cwd}`)}\n${theme.fg("borderMuted", "│ ")}${theme.fg("dim", `files: ${details.dir}`)}` +
              `\n${theme.fg("borderMuted", "│ ")}${theme.fg("dim", `retrieve: ${JOBS_TOOL_NAME} result ${details.jobId}`)}` : ""), 0, 0);
        }
        // Interactive hint only: print and JSON modes have no shortcuts.
        if (details) return renderRun(details as RunDetails, expanded, theme, role === "root" ? backgroundHint : undefined);
        return new Text(result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n"), 0, 0);
      },
    });

    pi.registerTool({
      name: JOBS_TOOL_NAME,
      exposure: "direct",
      label: "Subagent jobs",
      description: "Manage one-shot subagent jobs launched from this session: list them, check status, retrieve a finished job's answer, " +
        "or cancel one. Retrieving a running job returns its state, not an error. " +
        "Failed, timed-out, cancelled and interrupted jobs are returned as errors; their child may have left partial changes.",
      promptSnippet: `${JOBS_TOOL_NAME}: list, check, retrieve, or cancel background subagent jobs from this session`,
      promptGuidelines: [
        `Retrieve a background job's answer with ${JOBS_TOOL_NAME} action "result" before relying on it, typically after its completion notice.`,
      ],
      annotations: { openWorldHint: false },
      parameters: Type.Object({
        action: StringEnum(["list", "status", "result", "cancel"] as const, { description: "list: this session's jobs; status: state only; result: the answer of a finished job; cancel: stop a job" }),
        job_id: Type.Optional(Type.String({ pattern: "^job-[0-9a-f]{12}$", description: "Job ID from the receipt or completion notice" })),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<AgentToolResult<JobsToolDetails>> {
        if (role === "child") throw new Error("One-shot subagents have no background jobs");
        const owner = ctx.sessionManager.getSessionId();
        const action = params.action;
        if (action === "list") {
          const all = await jobs.list({ owner, limit: 30 });
          return { content: text(all.length ? all.map((job) => `- ${summaryLine(job)}`).join("\n") : "No subagent jobs in this session."),
            details: jobsDetails(action, all) };
        }
        if (!params.job_id) throw new Error(`Action "${action}" requires job_id`);
        const job = await owned(params.job_id, ctx);
        if (action === "status") return { content: text(summaryLine(job)), details: jobsDetails(action, [job]) };
        if (action === "result") {
          const result = await retrieve([job]);
          return { content: text(result.text), details: jobsDetails(action, [job]), usage: result.usage, isError: result.isError };
        }
        const cancelled = await jobs.cancel(job.id, owner);
        const current = cancelled.job ?? job;
        if (cancelled.outcome === "requested")
          return { content: text(`Cancellation of ${jobLabel(current)} was requested; it is ${current.status.state}.`), details: jobsDetails(action, [current]) };
        const result = await retrieve([current]);
        const prefix = cancelled.outcome === "already-terminal" ? `${jobLabel(current)} had already finished.\n\n` : "";
        return { content: text(prefix + result.text), details: jobsDetails(action, [current]), usage: result.usage,
          isError: cancelled.outcome !== "cancelled" && result.isError };
      },
      renderCall(args, theme) {
        const target = args.job_id ?? "";
        return new Text(theme.fg("toolTitle", theme.bold("◆ subagent jobs")) + theme.fg("accent", `  ${args.action ?? "…"}`) +
          (target ? theme.fg("dim", ` · ${oneLine(target, 120)}`) : ""), 0, 0);
      },
    });
  }
}
