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
import { envRole, hasRoleEntry, restoreRole, ROLE_ENTRY, type Role, type SavedEntry } from "./role.ts";
import { EFFORT_LEVELS, resolveBackend } from "./backend.ts";

const TOOL_NAME = "oneshot_subagent";
const launcher = resolve(dirname(realpathSync(fileURLToPath(import.meta.url))), "../../scripts/agent-spawn.sh");

export default function oneshotSubagentExtension(pi: ExtensionAPI) {
  const baseRole = envRole();
  let role: Role = baseRole;
  let registered = false;
  const live = new Map<AbortController, Promise<unknown>>();

  pi.on("session_start", async (_event, ctx) => {
    const saved: SavedEntry[] = ctx.sessionManager.getEntries().flatMap((entry) =>
      entry.type === "custom" && entry.customType === ROLE_ENTRY
        ? [{ customType: entry.customType, data: entry.data }] : []);
    role = restoreRole(baseRole, saved);
    // Register only once the role is known: a tool cannot be unregistered, and a
    // resumed child session may carry no environment marker.
    if (role === "child") {
      if (!hasRoleEntry(saved)) pi.appendEntry(ROLE_ENTRY, { version: 1, role });
    } else if (!registered) {
      registered = true;
      registerTool();
    }
  });
  pi.on("session_shutdown", async () => {
    for (const controller of live.keys()) controller.abort();
    await Promise.allSettled(live.values());
    live.clear();
  });

  function registerTool() {
    pi.registerTool({
      name: TOOL_NAME,
      exposure: "direct",
      label: "One-shot subagent",
      renderShell: "self",
      description: "Delegate a complete, self-contained task to a fresh Pi or Claude Code agent via agent-spawn.sh in JSON mode. " +
        "Waits for completion and returns its final answer. The child has its own tools/configuration and can edit files or run commands. " +
        "It does not see this conversation and does not resume earlier delegations. Children are leaves and cannot delegate further. " +
        "Defaults to the current working directory. Pi inherits model/thinking; Claude uses its own defaults. Delegation remains available in SAFE mode.",
      promptSnippet: "oneshot_subagent: delegate a standalone task to a fresh Pi or Claude Code agent and receive its final answer",
      promptGuidelines: [
        "Give oneshot_subagent all necessary context, file paths, constraints, and expected deliverables; it cannot see the parent conversation.",
        "Avoid concurrent agents editing the same files. The child is not a sandbox and has its own tool permissions, but it cannot delegate further.",
      ],
      annotations: { destructiveHint: true, openWorldHint: true },
      parameters: Type.Object({
        agent: Type.Optional(StringEnum(["pi", "claude"] as const, { description: "Backend (default pi)" })),
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
        if (role === "child") throw new Error("One-shot subagents cannot delegate");
        if (!params.task.trim()) throw new Error("Task must not be blank");
        const backend = resolveBackend(params, ctx);
        const controller = new AbortController();
        const abort = () => controller.abort();
        if (signal?.aborted) abort();
        signal?.addEventListener("abort", abort, { once: true });
        const promise = runSubagent({
          launcher,
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
}
