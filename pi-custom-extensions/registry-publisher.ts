import { execFile } from "node:child_process";
import { createConnection } from "node:net";
import type { Socket } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ProcessIdentity, PublishMessage } from "../agents-registry/src/types.ts";

const execute = promisify(execFile);

export default function (pi: ExtensionAPI): void {
  let active = false;
  let generation = 0;
  let identity: ProcessIdentity | undefined;
  let context: ExtensionContext | undefined;
  let directory = "";
  let prompts = 0;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let pending: PublishMessage | undefined;
  let sending = false;
  let socket: Socket | undefined;
  let reportedAt = 0;

  async function identify(): Promise<ProcessIdentity> {
    const { stdout } = await execute("ps", ["-p", String(process.pid), "-o", "lstart="], {
      encoding: "utf8", timeout: 1000, maxBuffer: 4096,
      env: { ...process.env, TZ: "UTC", LC_ALL: "C" },
    });
    const startedAt = Date.parse(`${stdout.trim().replace(/\s+/g, " ")} UTC`);
    if (!Number.isSafeInteger(startedAt) || startedAt < 0) throw new Error("Invalid process identity");
    return { pid: process.pid, startedAt };
  }

  function request(message: PublishMessage): Promise<void> {
    return new Promise(resolveRequest => {
      const connection = createConnection(join(directory, "registry.sock"));
      socket = connection;
      let response = "";
      const timer = setTimeout(finish, 1000);
      function finish(): void {
        clearTimeout(timer);
        connection.destroy();
        if (socket === connection) socket = undefined;
        resolveRequest();
      }
      connection.on("connect", () => connection.write(`${JSON.stringify(message)}\n`));
      connection.on("data", chunk => {
        response += chunk.toString();
        if (response.includes("\n") || Buffer.byteLength(response) > 4096) finish();
      });
      connection.on("error", finish);
      connection.on("close", finish);
    });
  }

  async function drain(): Promise<void> {
    if (sending) return;
    sending = true;
    try {
      while (active && pending) {
        const message = pending;
        pending = undefined;
        await request(message);
      }
    } finally { sending = false; }
  }

  function publish(ctx: ExtensionContext, model = ctx.model): void {
    if (!active) return;
    context = ctx;
    if (!identity) return;
    // Equal-priority duplicate timestamps keep the first value in the registry.
    reportedAt = Math.max(Date.now(), reportedAt + 1);
    pending = {
      version: 1, type: "publish", harness: "pi", source: "pi", process: identity, reportedAt,
      patch: {
        session: {
          id: ctx.sessionManager.getSessionId(), file: ctx.sessionManager.getSessionFile() ?? null,
          name: ctx.sessionManager.getSessionName() ?? null, cwd: ctx.cwd,
          mode: ctx.mode === "tui" ? "interactive" : "non-interactive",
        },
        activity: prompts > 0 ? { state: "waiting", waitingFor: "ui_prompt" } : { state: ctx.isIdle() ? "idle" : "busy" },
        model: model ? { id: model.id, provider: model.provider, displayName: model.name } : null,
      },
    };
    if (Buffer.byteLength(JSON.stringify(pending)) + 1 > 64 * 1024) { pending = undefined; return; }
    // Coalesce queued updates: socket failures must never block Pi's event loop.
    void drain().catch(() => {});
  }

  function refresh(): void {
    if (!active || !context) return;
    if (identity) { publish(context); return; }
    const current = generation;
    void identify().then(value => {
      if (!active || generation !== current || !context) return;
      identity = value;
      publish(context);
    }).catch(() => {});
  }

  function stop(): void {
    active = false;
    generation++;
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = undefined;
    pending = undefined;
    context = undefined;
    identity = undefined;
    prompts = 0;
    socket?.destroy();
    socket = undefined;
  }

  pi.on("session_start", (_event, ctx) => {
    stop();
    active = true;
    context = ctx;
    directory = resolve(process.env.AGENTS_REGISTRY_DIR ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "agents-registry"));
    refresh();
    heartbeat = setInterval(refresh, 5000);
    heartbeat.unref();
  });
  pi.on("session_shutdown", stop);
  pi.on("session_info_changed", (_event, ctx) => { publish(ctx); });
  pi.on("model_select", (event, ctx) => { publish(ctx, event.model); });
  pi.on("before_agent_start", (_event, ctx) => { publish(ctx); });
  pi.on("agent_start", (_event, ctx) => { publish(ctx); });
  pi.on("agent_settled", (_event, ctx) => { publish(ctx); });
  pi.on("ui_prompt_start", (_event, ctx) => { if (active) prompts++; publish(ctx); });
  pi.on("ui_prompt_end", (_event, ctx) => { prompts = Math.max(0, prompts - 1); publish(ctx); });
}
