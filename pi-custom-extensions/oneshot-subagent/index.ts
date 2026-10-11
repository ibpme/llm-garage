import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { oneLine, type RunDetails } from "./events.ts";
import { renderRun } from "./rendering.ts";
import { runSubagent } from "./runner.ts";
import { DEPTH_ENTRY, initialPolicy, restorePolicy } from "./depth.ts";
import { EFFORT_LEVELS, resolveBackend } from "./backend.ts";

const TOOL_NAME = "oneshot_subagent";
const launcher = resolve(dirname(realpathSync(fileURLToPath(import.meta.url))), "../../scripts/agent-spawn.sh");

export default function oneshotSubagentExtension(pi: ExtensionAPI) {
  const basePolicy = initialPolicy();
  let policy = basePolicy;
  let policyError: string | undefined;
  const live = new Map<AbortController, Promise<unknown>>();

  pi.on("session_start", async (_event, ctx) => {
    const saved = ctx.sessionManager.getEntries()
      .filter((entry) => entry.type === "custom" && entry.customType === DEPTH_ENTRY)
      .map((entry) => entry.type === "custom" ? entry.data : undefined);
    policyError = undefined;
    try {
      policy = restorePolicy(basePolicy, saved);
      if (!saved.length) pi.appendEntry(DEPTH_ENTRY, policy);
    } catch (error) {
      policy = { version: 1, depth: 0, maxDepth: 0 };
      policyError = error instanceof Error ? error.message : String(error);
    }
    registerTool();
  });
  pi.on("session_shutdown", async () => {
    for (const controller of live.keys()) controller.abort();
    await Promise.allSettled(live.values());
    live.clear();
  });

  function registerTool() {
    pi.registerTool({
      name: TOOL_NAME,
      exposure: policy.depth < policy.maxDepth ? "direct" : "hidden",
      label: "One-shot subagent",
      renderShell: "self",
      description: "Delegate a complete, self-contained task to a fresh Pi or Claude Code agent via agent-spawn.sh in JSON mode. " +
        "Waits for completion and returns its final answer. The child has its own tools/configuration and can edit files or run commands. " +
        "It does not see this conversation and does not resume earlier delegations. Pi children may delegate within the inherited depth budget; Claude is a leaf backend. " +
        `Current depth ${policy.depth}/${policy.maxDepth}; children run at depth ${policy.depth + 1}. ` +
        "Defaults to the current working directory. Pi inherits model/thinking; Claude uses its own defaults. Delegation remains available in SAFE mode.",
      promptSnippet: "oneshot_subagent: delegate a standalone task to a fresh Pi or Claude Code agent and receive its final answer",
      promptGuidelines: [
        "Give oneshot_subagent all necessary context, file paths, constraints, and expected deliverables; it cannot see the parent conversation.",
        "Avoid concurrent agents editing the same files. The child is not a sandbox and has its own tool permissions.",
      ],
      annotations: { destructiveHint: true, openWorldHint: true },
      parameters: Type.Object({
        agent: Type.Optional(StringEnum(["pi", "claude"] as const, { description: "Backend (default pi); Claude is a leaf agent" })),
        task: Type.String({ minLength: 1, description: "Complete standalone task, including context and expected output" }),
        name: Type.Optional(Type.String({ pattern: "^[a-zA-Z0-9][a-zA-Z0-9_-]*$", maxLength: 64, description: "Short task label shown in the TUI and job files" })),
        cwd: Type.Optional(Type.String({ description: "Working directory, relative to the main agent's cwd or absolute" })),
        model: Type.Optional(Type.String({ description: "Backend-specific model ID or alias; model:level supported. Pi inherits the parent; Claude uses its configured default" })),
        provider: Type.Optional(Type.String({ description: "Pi provider restriction; requires an explicit model for Pi, ignored for Claude" })),
        thinking: Type.Optional(StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const)),
        effort: Type.Optional(StringEnum(EFFORT_LEVELS, { description: "Shared reasoning level: Pi --thinking / Claude --effort. Alias of thinking for common levels; explicit level overrides model suffix" })),
        timeout_seconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 3600, description: "Total time limit in seconds (default 600)" })),
      }),
      async execute(_toolCallId, params, signal, onUpdate, ctx) {
        if (policyError) throw new Error(policyError);
        if (policy.depth >= policy.maxDepth) throw new Error(`Subagent depth limit reached (${policy.depth}/${policy.maxDepth})`);
        if (!params.task.trim()) throw new Error("Task must not be blank");
        const backend = resolveBackend(params, ctx);
        const controller = new AbortController();
        const abort = () => controller.abort();
        if (signal?.aborted) abort();
        signal?.addEventListener("abort", abort, { once: true });
        const promise = runSubagent({
          launcher,
          policy: { ...policy },
          name: params.name ?? "subagent",
          task: params.task,
          cwd: resolve(ctx.cwd, params.cwd ?? "."),
          ...backend,
          timeoutSeconds: params.timeout_seconds ?? 600,
          signal: controller.signal,
          onProgress: (details) => onUpdate?.({ content: [{ type: "text", text: details.activity.at(-1) ?? `Starting ${backend.agent}…` }], details }),
        });
        live.set(controller, promise);
        try {
          const outcome = await promise;
          return { content: [{ type: "text", text: outcome.text }], details: outcome.details,
            usage: outcome.usage, isError: outcome.details.status !== "success" };
        } finally {
          live.delete(controller);
          signal?.removeEventListener("abort", abort);
        }
      },
      renderCall(args, theme) {
        return new Text(
          theme.fg("toolTitle", theme.bold("◆ one-shot subagent")) + theme.fg("accent", `  ${oneLine(args.name ?? "subagent", 64)}`) + theme.fg("dim", ` · ${args.agent ?? "pi"}`) +
          (args.model ? theme.fg("dim", ` · ${oneLine(args.model, 80)}`) : "") +
          `\n${theme.fg("muted", "  Task ")} ${theme.fg("toolOutput", oneLine(args.task ?? "…", 240))}`, 0, 0);
      },
      renderResult(result, { expanded }, theme) {
        const details = result.details as RunDetails | undefined;
        if (details) return renderRun(details, expanded, theme);
        return new Text(result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n"), 0, 0);
      },
    });
  }
  registerTool();
}
