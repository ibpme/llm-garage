import { realpathSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum, type Usage } from "@earendil-works/pi-ai";
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { AgentJobs, MAX_ACTIVE_PER_OWNER, type JobSnapshot } from "../shared/agent-jobs/jobs.ts";
import { isTerminal } from "../shared/agent-jobs/store.ts";
import { emptyUsage, oneLine, type RunDetails } from "./events.ts";
import { renderRun } from "./rendering.ts";
import { runSubagent } from "./runner.ts";
import { envRole, hasRoleEntry, restoreRole, ROLE_ENTRY, type Role, type SavedEntry } from "./role.ts";
import { EFFORT_LEVELS, resolveBackend } from "./backend.ts";
import { addUsage, jobLabel, outstandingText, resultText, summaryLine } from "./job-results.ts";
import { JobWatcher, NOTICE_TYPE, type NoticeDetails } from "./job-watcher.ts";

const TOOL_NAME = "oneshot_subagent";
const JOBS_TOOL_NAME = "subagent_jobs";
const CONTEXT_TYPE = "subagent-jobs-outstanding";
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
}

interface JobsToolDetails { action: string; jobs: { id: string; name: string; state: string; liveness: string }[] }

const text = (value: string) => [{ type: "text" as const, text: value }];

export default function oneshotSubagentExtension(pi: ExtensionAPI, jobs = new AgentJobs({ supervisor })) {
  const baseRole = envRole();
  let role: Role = baseRole;
  let registered = false;
  // Only foreground runs and unacknowledged background launches belong to this
  // runtime; accepted background jobs are never cancelled by shutdown.
  const live = new Map<AbortController, Promise<unknown>>();
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
    watcher = new JobWatcher(pi, jobs, ctx);
    watcher.start();
  });
  pi.on("session_shutdown", async () => {
    watcher?.stop();
    watcher = undefined;
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

  const owned = async (id: string, ctx: ExtensionContext): Promise<JobSnapshot> => {
    const job = await jobs.inspect(id);
    // Other sessions' jobs are indistinguishable from missing ones.
    if (!job || job.request.owner.sessionId !== ctx.sessionManager.getSessionId()) throw new Error(`No background job ${id} in this session`);
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

  async function launchBackground(params: LaunchParams, backend: ReturnType<typeof resolveBackend>, toolCallId: string,
    signal: AbortSignal | undefined, ctx: ExtensionContext): Promise<AgentToolResult<ReceiptDetails>> {
    const owner = ctx.sessionManager.getSessionId();
    const active = await jobs.list({ owner, active: true });
    if (active.length >= MAX_ACTIVE_PER_OWNER) {
      throw new Error(`At most ${MAX_ACTIVE_PER_OWNER} background subagent jobs may run at once in this session; active: ` +
        `${active.map((job) => jobLabel(job)).join(", ")}. Wait for, retrieve or cancel one with ${JOBS_TOOL_NAME}, or use mode "foreground".`);
    }
    const cwd = await realpath(resolve(ctx.cwd, params.cwd ?? "."));
    const name = params.name ?? "subagent";
    const job = await track(signal, (abort) => jobs.start({
      name, task: params.task, cwd, ...backend, effort: backend.effort,
      timeoutSeconds: params.timeout_seconds ?? 1800, launcher,
      owner: { sessionId: owner, sessionFile: ctx.sessionManager.getSessionFile(), toolCallId,
        branchAnchor: ctx.sessionManager.getLeafId() ?? undefined },
    }, abort));
    return {
      content: text(`Background subagent ${jobLabel(job)} was accepted and is running (${backend.agent}` +
        `${backend.model ? ` · ${backend.model}` : ""}, timeout ${params.timeout_seconds ?? 1800}s). ` +
        "This is a launch receipt, not its answer. Continue with other work; a short notice arrives when it finishes. " +
        `Retrieve its answer with ${JOBS_TOOL_NAME} {"action":"result","job_id":"${job.id}"} (or "wait") before relying on it, ` +
        `and do not edit files it may be changing until then.\n\n[Subagent job ${job.id}: ${job.dir}]`),
      details: { kind: "background-receipt", jobId: job.id, name, agent: backend.agent, model: backend.model, cwd,
        task: params.task, state: job.status.state, dir: job.dir, createdAt: job.request.createdAt },
    };
  }

  type LaunchParams = { task: string; name?: string; cwd?: string; timeout_seconds?: number };

  function registerTools() {
    pi.registerTool({
      name: TOOL_NAME,
      exposure: "direct",
      label: "One-shot subagent",
      renderShell: "self",
      description: "Delegate a complete, self-contained task to a fresh Pi or Claude Code agent via agent-spawn.sh in JSON mode. " +
        `By default (mode "background") it returns a job receipt immediately while the child runs independently; collect the answer later with ${JOBS_TOOL_NAME}. ` +
        'Use mode "foreground" only when you cannot do anything useful until the answer arrives; it waits and returns the final answer. ' +
        "The child has its own tools/configuration and can edit files or run commands. " +
        "It does not see this conversation and does not resume earlier delegations. Children are leaves and cannot delegate further. " +
        "Defaults to the current working directory. Pi inherits model/thinking; Claude uses its own defaults. Delegation remains available in SAFE mode.",
      promptSnippet: `oneshot_subagent: delegate a standalone task to a fresh Pi or Claude Code agent; runs in the background by default (results via ${JOBS_TOOL_NAME})`,
      promptGuidelines: [
        "Give oneshot_subagent all necessary context, file paths, constraints, and expected deliverables; it cannot see the parent conversation.",
        `After a background launch, keep working on independent tasks. Retrieve the result with ${JOBS_TOOL_NAME} before relying on it or claiming dependent work is complete; a receipt is not an answer.`,
        'Use mode "foreground" only when you are blocked on the answer.',
        "Avoid concurrent agents editing the same files, and do not edit files a running background job may change. The child is not a sandbox and has its own tool permissions, but it cannot delegate further.",
      ],
      annotations: { destructiveHint: true, openWorldHint: true },
      parameters: Type.Object({
        agent: Type.Optional(StringEnum(["pi", "claude"] as const, { description: "Backend (default pi)" })),
        task: Type.String({ minLength: 1, description: "Complete standalone task, including context and expected output" }),
        mode: Type.Optional(StringEnum(["background", "foreground"] as const, { description: "background (default): return a job receipt now; foreground: wait for the final answer" })),
        name: Type.Optional(Type.String({ pattern: "^[a-zA-Z0-9][a-zA-Z0-9_-]*$", maxLength: 64, description: "Short task label shown in the TUI and job files" })),
        cwd: Type.Optional(Type.String({ description: "Working directory, relative to the main agent's cwd or absolute" })),
        model: Type.Optional(Type.String({ description: "Backend-specific model ID or alias; model:level supported. Pi inherits the parent; Claude uses its configured default" })),
        provider: Type.Optional(Type.String({ description: "Pi provider restriction; requires an explicit model for Pi, ignored for Claude" })),
        thinking: Type.Optional(StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const)),
        effort: Type.Optional(StringEnum(EFFORT_LEVELS, { description: "Shared reasoning level: Pi --thinking / Claude --effort. Alias of thinking for common levels; explicit level overrides model suffix" })),
        timeout_seconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 3600, description: "Total time limit in seconds (default 1800 in background, 600 in foreground)" })),
      }),
      async execute(toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult<RunDetails | ReceiptDetails>> {
        if (role === "child") throw new Error("One-shot subagents cannot delegate");
        if (!params.task.trim()) throw new Error("Task must not be blank");
        const backend = resolveBackend(params, ctx);
        if (params.mode !== "foreground") return launchBackground(params, backend, toolCallId, signal, ctx);
        const outcome = await track(signal, (abort) => runSubagent({
          launcher,
          name: params.name ?? "subagent",
          task: params.task,
          cwd: resolve(ctx.cwd, params.cwd ?? "."),
          ...backend,
          timeoutSeconds: params.timeout_seconds ?? 600,
          signal: abort,
          onProgress: (details) => onUpdate?.({ content: text(details.activity.at(-1) ?? `Starting ${backend.agent}…`), details }),
        }));
        return { content: text(outcome.text), details: outcome.details, usage: outcome.usage, isError: outcome.details.status !== "success" };
      },
      renderCall(args, theme) {
        return new Text(
          theme.fg("toolTitle", theme.bold("◆ one-shot subagent")) + theme.fg("accent", `  ${oneLine(args.name ?? "subagent", 64)}`) + theme.fg("dim", ` · ${args.agent ?? "pi"}`) +
          (args.model ? theme.fg("dim", ` · ${oneLine(args.model, 80)}`) : "") + (args.mode === "foreground" ? theme.fg("dim", " · foreground") : "") +
          `\n${theme.fg("muted", "  Task ")} ${theme.fg("toolOutput", oneLine(args.task ?? "…", 240))}`, 0, 0);
      },
      renderResult(result, { expanded }, theme) {
        const details = result.details as RunDetails | ReceiptDetails | undefined;
        if (details && "kind" in details && details.kind === "background-receipt") {
          return new Text(theme.fg("borderMuted", "│ ") + theme.fg("accent", "◌ background job ") + theme.fg("toolOutput", details.jobId) +
            theme.fg("dim", ` · ${details.agent}${details.model ? ` · ${oneLine(details.model, 60)}` : ""} · /agents to inspect`) +
            (expanded ? `\n${theme.fg("borderMuted", "│ ")}${theme.fg("dim", `cwd: ${details.cwd}`)}\n${theme.fg("borderMuted", "│ ")}${theme.fg("dim", `files: ${details.dir}`)}` : ""), 0, 0);
        }
        if (details) return renderRun(details as RunDetails, expanded, theme);
        return new Text(result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n"), 0, 0);
      },
    });

    pi.registerTool({
      name: JOBS_TOOL_NAME,
      exposure: "direct",
      label: "Subagent jobs",
      description: "Manage background one-shot subagent jobs launched from this session: list them, check status, retrieve a finished job's answer, " +
        "wait (bounded) for jobs to finish, or cancel one. Retrieving a running job returns its state, not an error. " +
        "Failed, timed-out, cancelled and interrupted jobs are returned as errors; their child may have left partial changes.",
      promptSnippet: `${JOBS_TOOL_NAME}: list, check, retrieve, wait for, or cancel background subagent jobs from this session`,
      promptGuidelines: [
        `Retrieve a background job's answer with ${JOBS_TOOL_NAME} action "result" before relying on it; use "wait" only when you have nothing else to do.`,
      ],
      annotations: { openWorldHint: false },
      parameters: Type.Object({
        action: StringEnum(["list", "status", "result", "wait", "cancel"] as const, { description: "list: this session's jobs; status: state only; result: the answer of a finished job; wait: block until jobs finish (bounded); cancel: stop a job" }),
        job_id: Type.Optional(Type.String({ pattern: "^job-[0-9a-f]{12}$", description: "Job ID from the launch receipt" })),
        job_ids: Type.Optional(Type.Array(Type.String({ pattern: "^job-[0-9a-f]{12}$" }), { maxItems: 16, description: "For wait: jobs to wait for (default: all running jobs of this session)" })),
        timeout_seconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 600, description: "For wait: maximum seconds to wait (default 60)" })),
      }),
      async execute(_toolCallId, params, signal, _onUpdate, ctx): Promise<AgentToolResult<JobsToolDetails>> {
        if (role === "child") throw new Error("One-shot subagents have no background jobs");
        const owner = ctx.sessionManager.getSessionId();
        const action = params.action;
        if (action === "list") {
          const all = await jobs.list({ owner, limit: 30 });
          return { content: text(all.length ? all.map((job) => `- ${summaryLine(job)}`).join("\n") : "No background subagent jobs in this session."),
            details: jobsDetails(action, all) };
        }
        if (action === "wait") {
          const ids = params.job_ids?.length ? params.job_ids : params.job_id ? [params.job_id]
            : (await jobs.list({ owner, active: true })).map((job) => job.id);
          if (!ids.length) return { content: text("No running background subagent jobs in this session."), details: jobsDetails(action, []) };
          for (const id of ids) await owned(id, ctx);
          // Aborting the wait only stops waiting; the jobs keep running.
          const waited = await jobs.wait(ids, (params.timeout_seconds ?? 60) * 1000, signal);
          const result = await retrieve(waited);
          return { content: text(result.text), details: jobsDetails(action, waited), usage: result.usage, isError: result.isError };
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
        const target = args.job_id ?? (args.job_ids?.length ? args.job_ids.join(", ") : "");
        return new Text(theme.fg("toolTitle", theme.bold("◆ subagent jobs")) + theme.fg("accent", `  ${args.action ?? "…"}`) +
          (target ? theme.fg("dim", ` · ${oneLine(target, 120)}`) : ""), 0, 0);
      },
    });
  }
}
