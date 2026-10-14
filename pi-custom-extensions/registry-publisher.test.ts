import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PublishMessage } from "../agents-registry/src/types.ts";
import extension from "./registry-publisher.ts";

async function setup(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "pi-pub-"));
  const previous = process.env.AGENTS_REGISTRY_DIR;
  process.env.AGENTS_REGISTRY_DIR = directory;
  const messages: PublishMessage[] = [];
  const server = createServer(socket => {
    let input = "";
    socket.on("data", chunk => {
      input += chunk;
      if (!input.includes("\n")) return;
      messages.push(JSON.parse(input.split("\n")[0]!));
      socket.end('{"ok":true}\n');
    });
  });
  await new Promise<void>(resolve => server.listen(join(directory, "registry.sock"), resolve));
  const handlers = new Map<string, (event: any, ctx: ExtensionContext) => unknown>();
  const bus = new EventEmitter();
  extension({
    on(name: string, handler: Function) { handlers.set(name, handler as any); },
    events: {
      on(name: string, handler: (...args: any[]) => void) { bus.on(name, handler); return () => bus.off(name, handler); },
      emit(name: string, value: unknown) { bus.emit(name, value); },
    },
  } as unknown as ExtensionAPI);
  let idle = true;
  let name: string | undefined = "Review";
  let file: string | undefined = "/sessions/one.jsonl";
  const ctx = {
    mode: "tui", cwd: "/repo", model: { id: "model-one", provider: "provider", name: "Model One" },
    isIdle: () => idle,
    sessionManager: { getSessionId: () => "session-one", getSessionFile: () => file, getSessionName: () => name },
  } as unknown as ExtensionContext;
  const fire = (name: string, event = {}) => handlers.get(name)?.(event, ctx);
  t.after(async () => {
    await fire("session_shutdown");
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (previous === undefined) delete process.env.AGENTS_REGISTRY_DIR;
    else process.env.AGENTS_REGISTRY_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  });
  async function next(after: number) {
    for (let i = 0; i < 650; i++) {
      if (messages.length > after) return messages.at(-1)!;
      await delay(10);
    }
    assert.fail("No publication received");
  }
  return { ctx, messages, fire, next, server, directory, bus, set idle(value: boolean) { idle = value; }, clearSession() { name = undefined; file = undefined; } };
}

test("publishes verified own identity and full metadata only after session startup", async t => {
  const h = await setup(t);
  await delay(30);
  assert.equal(h.messages.length, 0);
  h.fire("session_start");
  const message = await h.next(0);
  assert.equal(message.harness, "pi");
  assert.equal(message.source, "pi");
  assert.equal(message.process.pid, process.pid);
  assert.ok(message.process.startedAt <= Date.now());
  assert.equal(message.process.startedAt % 1000, 0);
  assert.deepEqual(message.patch.session, { id: "session-one", file: "/sessions/one.jsonl", name: "Review", cwd: "/repo", mode: "interactive" });
  assert.deepEqual(message.patch.model, { id: "model-one", provider: "provider", displayName: "Model One" });
  assert.equal(message.patch.activity?.state, "idle");
});

test("stays busy through agent_end and reports nested UI waits without exposing titles", async t => {
  const h = await setup(t);
  h.fire("session_start"); await h.next(0);
  h.idle = false;
  let count = h.messages.length;
  h.fire("before_agent_start");
  assert.equal((await h.next(count)).patch.activity?.state, "busy");
  count = h.messages.length;
  h.fire("ui_prompt_start", { kind: "confirm", title: "secret prompt" });
  const waiting = await h.next(count);
  assert.deepEqual(waiting.patch.activity, { state: "waiting", waitingFor: "ui_prompt" });
  assert.ok(!JSON.stringify(waiting).includes("secret"));
  h.fire("ui_prompt_start", { kind: "input" });
  count = h.messages.length;
  h.fire("ui_prompt_end");
  assert.equal((await h.next(count)).patch.activity?.state, "waiting");
  count = h.messages.length;
  h.fire("ui_prompt_end");
  assert.equal((await h.next(count)).patch.activity?.state, "busy");
  count = h.messages.length;
  h.fire("agent_end"); await delay(30);
  assert.equal(h.messages.length, count);
  h.idle = true;
  h.fire("agent_settled");
  assert.equal((await h.next(count)).patch.activity?.state, "idle");
});

test("clears missing metadata and uses event model on selection in non-interactive mode", async t => {
  const h = await setup(t);
  h.ctx.mode = "json";
  h.fire("session_start"); await h.next(0);
  h.clearSession(); h.ctx.model = undefined;
  let count = h.messages.length;
  h.fire("session_info_changed");
  const cleared = await h.next(count);
  assert.equal(cleared.patch.session?.name, null);
  assert.equal(cleared.patch.session?.file, null);
  assert.equal(cleared.patch.session?.mode, "non-interactive");
  assert.equal(cleared.patch.model, null);
  count = h.messages.length;
  h.fire("model_select", { model: { id: "model-two", provider: "other", name: "Two" } });
  assert.deepEqual((await h.next(count)).patch.model, { id: "model-two", provider: "other", displayName: "Two" });
});

test("refreshes activity before default TTL expiry and stops on shutdown", async t => {
  const h = await setup(t);
  h.fire("session_start"); await h.next(0);
  const count = h.messages.length;
  assert.equal((await h.next(count)).patch.activity?.state, "idle");
  h.fire("session_shutdown");
  const stopped = h.messages.length;
  h.fire("before_agent_start");
  await delay(100);
  assert.equal(h.messages.length, stopped);
});

test("an unavailable daemon does not block events and recovers on the next heartbeat", async t => {
  const h = await setup(t);
  await new Promise<void>(resolve => h.server.close(() => resolve()));
  assert.equal(h.fire("session_start"), undefined);
  h.idle = false;
  assert.equal(h.fire("before_agent_start"), undefined);
  await delay(100);
  assert.equal(h.messages.length, 0);
  await new Promise<void>(resolve => h.server.listen(join(h.directory, "registry.sock"), resolve));
  assert.equal((await h.next(0)).patch.activity?.state, "busy");
});

test("queries listener state at startup and publishes changes and clearing", async t => {
  const h = await setup(t);
  const endpoint = { transport: "unix", path: "/tmp/pi-listen.sock", protocol: "pi-listener-v2" };
  h.bus.on("message-listener:query", () => h.bus.emit("message-listener:changed", endpoint));
  h.fire("session_start");
  assert.deepEqual((await h.next(0)).patch.messaging, endpoint);
  const count = h.messages.length;
  h.bus.emit("message-listener:changed", null);
  assert.equal((await h.next(count)).patch.messaging, null);
});

test("shutdown sends a bounded endpoint clear before abandoning publication", async t => {
  const h = await setup(t);
  h.bus.on("message-listener:query", () => h.bus.emit("message-listener:changed", { transport: "unix", path: "/tmp/pi.sock", protocol: "pi-listener-v2" }));
  h.fire("session_start"); await h.next(0);
  await h.fire("session_shutdown");
  assert.equal(h.messages.at(-1)?.patch.messaging, null);
});
