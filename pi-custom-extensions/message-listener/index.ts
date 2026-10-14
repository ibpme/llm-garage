import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { LISTENER_CHANGED_EVENT, LISTENER_QUERY_EVENT, LISTENER_STATUS_KEY } from "../contracts/listener.ts";
import { startListener } from "./listener.ts";
import type { Listener } from "./listener.ts";

export default function messageListener(pi: ExtensionAPI): void {
  let listener: Listener | undefined;
  let context: ExtensionContext | undefined;
  let enabled = true;
  let shutdown = false;
  let queue = Promise.resolve();

  function advertise(): void {
    pi.events.emit(LISTENER_CHANGED_EVENT, listener ? { transport: "unix", path: listener.path, protocol: "pi-listener-v2" } : null);
  }
  const unsubscribe = pi.events.on(LISTENER_QUERY_EVENT, advertise);
  function status(): void {
    if (context?.mode === "tui") context.ui.setStatus(LISTENER_STATUS_KEY, listener ? "● listening" : "○ listener off");
  }
  async function stop(): Promise<void> {
    const old = listener;
    listener = undefined;
    advertise();
    status();
    await old?.close();
  }
  async function start(): Promise<void> {
    if (shutdown || !enabled || context?.mode !== "tui" || listener) return;
    try {
      listener = await startListener(message => {
        if (shutdown || !listener) throw new Error("Listener is stopping");
        pi.sendUserMessage(message.content, { deliverAs: message.deliverAs, expandPromptTemplates: false });
      });
      if (shutdown) { await stop(); return; }
      advertise();
      status();
    } catch (error) {
      advertise();
      context.ui.setStatus(LISTENER_STATUS_KEY, "! listener error");
      context.ui.notify(`Listener could not start: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  }
  function serialized(action: () => Promise<void>): Promise<void> {
    const next = queue.then(action);
    queue = next.catch(() => {});
    return next;
  }

  pi.on("session_start", (_event, ctx) => serialized(async () => {
    await stop();
    context = ctx;
    await start();
  }));
  pi.on("session_shutdown", () => {
    shutdown = true;
    unsubscribe();
    return serialized(stop);
  });
  pi.registerCommand("listen", {
    description: "Toggle message listener, or /listen on|off|status",
    handler: (args, ctx) => serialized(async () => {
      context = ctx;
      const command = args.trim().toLowerCase();
      if (command === "status") {
        ctx.ui.notify(listener ? `Listening: ${listener.path}` : "Listener is off", "info");
        return;
      }
      if (!["", "on", "off"].includes(command)) { ctx.ui.notify("Usage: /listen [on|off|status]", "warning"); return; }
      if (ctx.mode !== "tui") { ctx.ui.notify("Message listening is available only in TUI mode", "warning"); return; }
      enabled = command === "" ? !Boolean(listener) : command === "on";
      if (enabled) await start();
      else await stop();
    }),
  });
}
