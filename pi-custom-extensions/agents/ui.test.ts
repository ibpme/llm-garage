import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { test } from "node:test";
process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), "agents-ui-state-"));
import agentsExtension, { agentsOverlayOptions, picker } from "./index.ts";
import { parseProcesses, run, type Agent } from "./tmux.ts";
import { readStatus } from "./registry.ts";

type Factory = Parameters<ExtensionCommandContext["ui"]["custom"]>[0];
const agents: Agent[] = [100, 200].map((pid, i) => ({
  provider: "pi", interactive: true,
  pane: {
    sessionId: `$${i}`, sessionName: i ? "other" : "current", windowIndex: "0", paneIndex: "0",
    id: `%${i}`, pid, cwd: "/work/project",
  },
  process: { pid: pid + 1, ppid: pid, startedAt: "Fri Oct 9 09:39:49 2026", command: "pi", args: "pi" },
}));

for (const [key, action] of [
  ["\r", "attach"], ["V", "vertical"], ["H", "horizontal"],
  ["\x1b[13;2u", "horizontal"], ["\x1b[27;2;13~", "horizontal"],
] as const) {
  test(`picker: j navigates and ${JSON.stringify(key)} chooses ${action}; rendering fits narrow widths`, async () => {
    let completed = false;
    const terminal = { rows: 30 };
    const ctx = {
      ui: {
        custom: async (factory: Factory) => {
          let result: unknown;
          const component = await factory(
            { terminal, requestRender() {} } as Parameters<Factory>[0],
            { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Parameters<Factory>[1],
            {} as Parameters<Factory>[2],
            (value) => { completed = true; result = value; },
          );
          await new Promise<void>((resolve) => setImmediate(resolve));
          try {
            const lines = component.render(100);
            assert.ok(lines.some((line) => line.includes("running (status unknown)")));
            assert.ok(lines.some((line) => line.includes("(current)")));
            assert.ok(lines[0].startsWith("╭") && lines[0].endsWith("╮"));
            assert.ok(lines.at(-1)?.startsWith("╰") && lines.at(-1)?.endsWith("╯"));
            assert.ok(lines.some((line) => line.startsWith("├") && line.endsWith("┤")));
            assert.ok(lines.every((line) => visibleWidth(line) === 100));
            assert.ok(lines.some((line) => line.includes("Shift+Enter")));
            for (const width of [1, 10, 40, 80, 120]) {
              assert.ok(component.render(width).every((line) => visibleWidth(line) <= width));
            }
            terminal.rows = 6;
            const compact = component.render(20);
            assert.ok(compact.length <= 4);
            assert.ok(compact[0].startsWith("╭"));
            assert.ok(compact.at(-1)?.endsWith("╯"));
            component.handleInput?.("j");
            component.handleInput?.(key);
            assert.ok(completed);
            return result;
          } finally {
            component.dispose?.();
          }
        },
      },
    } as unknown as ExtensionCommandContext;
    const result = await picker(ctx, "/tmp/socket", "%0", "/nonexistent/pi-agent-registry", async () => agents);
    assert.equal(result?.agent.process.pid, 201);
    assert.equal(result?.action, action);
  });
}

test("picker: Escape closes an empty list without an action", async () => {
  const ctx = {
    ui: {
      custom: async (factory: Factory) => {
        let result: unknown;
        const component = await factory(
          { terminal: { rows: 30 }, requestRender() {} } as Parameters<Factory>[0],
          { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Parameters<Factory>[1],
          {} as Parameters<Factory>[2],
          (value) => { result = value; },
        );
        await new Promise<void>((resolve) => setImmediate(resolve));
        try {
          assert.ok(component.render(80).some((line) => line.includes("No interactive agents")));
          component.handleInput?.("\x1b");
          return result;
        } finally {
          component.dispose?.();
        }
      },
    },
  } as unknown as ExtensionCommandContext;
  assert.equal(await picker(ctx, "/tmp/socket", "%0", "/nonexistent/pi-agent-registry", async () => []), null);
});

test("lifecycle: factory starts no resources; start, working, idle, name change and shutdown publish correctly", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-agents-lifecycle-"));
  const original = {
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
    TMUX: process.env.TMUX,
    TMUX_PANE: process.env.TMUX_PANE,
  };
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  let name = "first";
  const api = {
    on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(event, handler),
    registerCommand() {},
    getSessionName: () => name,
  } as unknown as ExtensionAPI;
  const ctx = {
    ui: { notify: (text: string) => { throw new Error(text); } },
    isIdle: () => true,
    mode: "tui",
    sessionManager: { getSessionId: () => "session-id", getSessionFile: () => "/tmp/session.jsonl" },
    cwd: "/work/project",
    model: { provider: "test", id: "model" },
  } as unknown as ExtensionContext;
  const emit = async (event: string) => { await handlers.get(event)?.({}, ctx); };
  try {
    process.env.PI_CODING_AGENT_DIR = directory;
    delete process.env.TMUX;
    delete process.env.TMUX_PANE;
    agentsExtension(api);
    const registry = join(directory, "agents-live");
    assert.equal(existsSync(registry), false);
    const info = parseProcesses(await run("ps", ["-axo", "pid=,ppid=,lstart=,comm=,args="])).get(process.pid);
    assert.ok(info);
    await emit("session_start");
    assert.equal(readStatus(registry, info)?.state, "idle");
    assert.equal(readStatus(registry, info)?.model, "test/model");
    assert.equal(readStatus(registry, info)?.interactive, true);
    await emit("agent_start");
    assert.equal(readStatus(registry, info)?.state, "working");
    await emit("agent_settled");
    assert.equal(readStatus(registry, info)?.state, "idle");
    name = "renamed";
    await emit("session_info_changed");
    assert.equal(readStatus(registry, info)?.name, "renamed");
    await emit("session_shutdown");
    assert.equal(readStatus(registry, info), undefined);
    await emit("session_start");
    assert.equal(readStatus(registry, info)?.name, "renamed");
  } finally {
    await emit("session_shutdown");
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const active of [true, false]) {
  test(`headless rows are selectable for metadata only (${active ? "mixed list" : "no interactive agents"})`, async () => {
    const inactive: Agent[] = Array.from({ length: 8 }, (_, i) => ({
      provider: i % 2 ? "pi" : "claude", interactive: false,
      process: { ...agents[0].process, pid: 500 + i },
      metadata: { state: "busy", cwd: "/work/headless" },
    }));
    const input = active ? [...inactive, agents[0]] : inactive;
    const ctx = {
      ui: {
        custom: async (factory: Factory) => {
          let result: unknown;
          let completed = false;
          const component = await factory(
            { terminal: { rows: 30 }, requestRender() {} } as Parameters<Factory>[0],
            { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Parameters<Factory>[1],
            {} as Parameters<Factory>[2],
            (value) => { completed = true; result = value; },
          );
          await new Promise<void>((resolve) => setImmediate(resolve));
          try {
            const lines = component.render(140);
            assert.ok(lines.some((line) => line.includes("PID 500")));
            if (active) assert.ok(lines.findIndex((line) => line.includes("PID 101")) < lines.findIndex((line) => line.includes("PID 500")));
            for (let i = 0; i < (active ? 1 : 0); i++) component.handleInput?.("j");
            for (const key of ["V", "H", "\x1b[13;2u", "\x18"]) {
              component.handleInput?.(key);
              if (active) component.handleInput?.("n");
              assert.equal(completed, false);
            }
            assert.ok(component.render(140).some((line) => line.includes("No interactive tmux pane")) || active);
            component.handleInput?.("\r");
            assert.equal(completed, false);
            assert.ok(component.render(140).some((line) => line.includes("only process metadata")));
            component.handleInput?.("\x1b");
            if (active) {
              component.handleInput?.("k");
              component.handleInput?.("\r");
              assert.equal((result as { agent: Agent }).agent.process.pid, 101);
            } else {
              assert.equal(completed, false);
              component.handleInput?.("\x1b");
            }
            return result;
          } finally { component.dispose?.(); }
        },
      },
    } as unknown as ExtensionCommandContext;
    const result = await picker(ctx, "/tmp/socket", "%0", "/nonexistent/registry", async () => input);
    if (active) assert.equal(result?.agent.process.pid, 101);
    else assert.equal(result, null);
  });
}

for (const fail of [false, true]) {
  test(`picker: kill confirms y/n and stays open (${fail ? "failure" : "success"})`, async () => {
    let killed = 0;
    let discoveries = 0;
    let completed = false;
    const ctx = {
      ui: {
        custom: async (factory: Factory) => {
          let result: unknown;
          const terminal = { rows: 30 };
          const component = await factory(
            { terminal, requestRender() {} } as Parameters<Factory>[0],
            { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Parameters<Factory>[1],
            {} as Parameters<Factory>[2],
            (value) => { completed = true; result = value; },
          );
          await new Promise<void>((resolve) => setImmediate(resolve));
          try {
            component.handleInput?.("\x18");
            assert.ok(component.render(100).some((line) => line.includes("Cannot kill the current pane")));
            component.handleInput?.("j");
            component.handleInput?.("\x18");
            assert.ok(component.render(100).some((line) => line.includes("[y/n]")));
            terminal.rows = 6;
            assert.ok(component.render(80).some((line) => line.includes("[y/n]")));
            terminal.rows = 30;
            component.handleInput?.("n");
            assert.equal(killed, 0);
            assert.equal(completed, false);
            component.handleInput?.("\x18");
            component.handleInput?.("\x1b");
            assert.equal(completed, false);
            component.handleInput?.("\x18");
            component.handleInput?.("y");
            component.handleInput?.("y");
            await new Promise((resolve) => setTimeout(resolve, 0));
            assert.equal(killed, 1);
            assert.equal(completed, false);
            if (fail) {
              assert.ok(component.render(100).some((line) => line.includes("kill failed")));
            } else {
              assert.equal(discoveries, 2);
              assert.ok(!component.render(100).some((line) => line.includes("PID 201")));
            }
            component.handleInput?.("\x1b");
            return result;
          } finally { component.dispose?.(); }
        },
      },
    } as unknown as ExtensionCommandContext;
    assert.equal(await picker(ctx, "/tmp/socket", "%0", "/nonexistent/registry",
      async () => { discoveries++; return killed && !fail ? [agents[0]] : agents; },
      async (_socket, _origin, agent, action) => {
        killed++;
        assert.equal(agent.process.pid, 201);
        assert.equal(action, "kill");
        if (fail) throw new Error("kill failed");
      }), null);
  });
}

test("overlay sizing is centered, capped, and recomputed after resize", () => {
  const terminal = { columns: 100, rows: 40 };
  const options = agentsOverlayOptions(terminal);
  assert.equal(options.anchor, "center");
  assert.equal(options.margin, 1);
  assert.equal(options.width, 85);
  assert.equal(options.maxHeight, 30);
  terminal.columns = 240;
  terminal.rows = 100;
  assert.equal(options.width, 120);
  assert.equal(options.maxHeight, 36);
  terminal.columns = 40;
  terminal.rows = 10;
  assert.equal(options.width, 38);
  assert.equal(options.maxHeight, 8);
  terminal.columns = 1;
  terminal.rows = 1;
  assert.equal(options.width, 1);
  assert.equal(options.maxHeight, 1);
});

for (const closeEarly of [false, true]) {
  test(`modal mounts before discovery and ${closeEarly ? "ignores updates after closing" : "populates without resizing"}`, async () => {
    let discoveries = 0;
    let renders = 0;
    let resolveDiscovery!: (value: Agent[]) => void;
    const discovery = new Promise<Agent[]>((resolve) => { resolveDiscovery = resolve; });
    const terminal = { columns: 100, rows: 30 };
    const ctx = {
      ui: {
        custom: async (factory: Factory, options: Parameters<ExtensionCommandContext["ui"]["custom"]>[1]) => {
          assert.equal(discoveries, 0);
          assert.equal(options?.overlay, true);
          let result: unknown;
          const component = await factory(
            { terminal, requestRender() { renders++; } } as Parameters<Factory>[0],
            { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Parameters<Factory>[1],
            {} as Parameters<Factory>[2],
            (value) => { result = value; },
          );
          try {
            const layout = typeof options?.overlayOptions === "function" ? options.overlayOptions() : options?.overlayOptions;
            const before = component.render(layout?.width as number);
            assert.equal(before.length, layout?.maxHeight);
            assert.ok(before.some((line) => line.includes("Discovering agents")));
            await new Promise<void>((resolve) => setImmediate(resolve));
            assert.equal(discoveries, 1);
            if (closeEarly) {
              component.handleInput?.("\x1b");
              component.dispose?.();
            }
            const previousRenders = renders;
            resolveDiscovery(agents);
            await new Promise<void>((resolve) => setImmediate(resolve));
            if (closeEarly) {
              assert.equal(renders, previousRenders);
            } else {
              const after = component.render(layout?.width as number);
              assert.equal(after.length, before.length);
              assert.ok(after.some((line) => line.includes("PID 101")));
              assert.ok(!after.some((line) => line.includes("Discovering agents")));
              terminal.rows = 10;
              terminal.columns = 40;
              const resized = component.render(layout?.width as number);
              assert.equal(resized.length, layout?.maxHeight);
              assert.ok(resized.every((line) => visibleWidth(line) <= (layout?.width as number)));
              component.handleInput?.("\x1b");
            }
            return result;
          } finally { component.dispose?.(); }
        },
      },
    } as unknown as ExtensionCommandContext;
    assert.equal(await picker(ctx, "/tmp/socket", "%0", "/nonexistent/registry", async () => {
      discoveries++;
      return discovery;
    }), null);
  });
}
