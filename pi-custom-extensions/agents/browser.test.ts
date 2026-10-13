import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createBrowser, openBrowser } from "./browser.ts";
import type { AgentSnapshot, RegistryView } from "./reader.ts";

const now = Date.now();
const agents: AgentSnapshot[] = [100, 200].map((pid, i) => ({ schemaVersion: 1, harness: "pi", observedAt: now, process: { pid, startedAt: now - 10000 }, session: { mode: "interactive", name: i ? "review" : "main", cwd: "/work" }, activity: { state: "busy", source: "pi-registry" }, pane: { server: "/socket", id: `%${i}`, sessionId: "$0", sessionName: "session", windowIndex: "0", paneIndex: String(i), cwd: "/work" } }));
const fresh = (): RegistryView => ({ state: "fresh", agents, warnings: [], updatedAt: now });
const theme = { fg: (_tone: string, s: string) => s, bold: (s: string) => s };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function setup() {
  let view = fresh();
  let closed = false;
  const actions: Array<[number, string]> = [];
  const terminal = { columns: 100, rows: 30 };
  const browser = createBrowser({ readRegistry: async () => view, origin: { server: "/socket", paneId: "%0" }, performPaneAction: async (_origin, agent, action) => { actions.push([agent.process.pid, action]); } }, terminal, theme, () => {}, () => { closed = true; });
  return { browser, terminal, actions, setView: (next: RegistryView) => { view = next; }, closed: () => closed };
}

test("navigation and attach act on the selected agent; responsive output fits", async () => {
  const { browser, terminal, actions } = setup();
  await browser.refresh();
  for (const width of [1, 10, 40, 100]) assert.ok(browser.render(width).every(line => visibleWidth(line) <= width));
  terminal.rows = 6;
  assert.ok(browser.render(20).length <= 4);
  browser.handleInput("j");
  browser.handleInput("\r");
  await tick();
  assert.deepEqual(actions, [[200, "attach"]]);
  browser.dispose();
});

test("refresh preserves process selection across pane moves but not PID reuse", async () => {
  const { browser, setView } = setup();
  await browser.refresh();
  browser.handleInput("j");
  setView({ ...fresh(), agents: [{ ...agents[1], pane: { ...agents[1].pane!, id: "%8" } }, agents[0]] });
  await browser.refresh();
  assert.ok(browser.render(100).some(line => line.includes("→") && line.includes("review")));
  setView({ ...fresh(), agents: [agents[0], { ...agents[1], process: { pid: 200, startedAt: now - 1000 } }] });
  await browser.refresh();
  assert.ok(browser.render(100).some(line => line.includes("→") && line.includes("main")));
  browser.dispose();
});

test("stale observations show details but cannot mutate panes", async () => {
  const { browser, setView, actions } = setup();
  setView({ ...fresh(), state: "stale", warnings: ["Writer stopped"] });
  await browser.refresh();
  browser.handleInput("j");
  browser.handleInput("H");
  browser.handleInput("\r");
  await tick();
  assert.deepEqual(actions, []);
  assert.ok(browser.render(100).some(line => line.includes("Metadata")));
  browser.dispose();
});

test("kill confirmation names the target, protects origin, and rechecks health", async () => {
  const { browser, actions, setView } = setup();
  await browser.refresh();
  browser.handleInput("\x18");
  browser.handleInput("y");
  await tick();
  assert.deepEqual(actions, []);
  browser.handleInput("j");
  browser.handleInput("\x18");
  assert.ok(browser.render(100).some(line => line.includes("200") && line.includes("y/n")));
  setView({ ...fresh(), state: "stale" });
  browser.handleInput("y");
  await tick();
  assert.deepEqual(actions, []);
  setView(fresh());
  await browser.refresh();
  browser.handleInput("\x18");
  browser.handleInput("y");
  await tick();
  assert.deepEqual(actions, [[200, "kill"]]);
  browser.dispose();
});

test("details sanitizes terminal controls and back restores the selected list row", async () => {
  const { browser, setView } = setup();
  setView({ ...fresh(), agents: [agents[0], { ...agents[1], session: { mode: "interactive", name: "review\x1b[2J" } }] });
  await browser.refresh();
  browser.handleInput("j");
  browser.handleInput("i");
  const text = browser.render(100).join("\n");
  assert.ok(text.includes("Metadata"));
  assert.ok(!text.includes("\x1b"));
  browser.handleInput("\x1b");
  assert.ok(browser.render(100).some(line => line.includes("→") && line.includes("review")));
  browser.dispose();
});

test("closing does not wait for an in-flight read or accept its late completion", async () => {
  let resolve!: (view: RegistryView) => void;
  let closed = false;
  let renders = 0;
  const browser = createBrowser({ readRegistry: () => new Promise(r => { resolve = r; }), performPaneAction: async () => {} }, { columns: 100, rows: 30 }, theme, () => { renders++; }, () => { closed = true; });
  const pending = browser.refresh();
  browser.handleInput("q");
  assert.equal(closed, true);
  const before = renders;
  resolve(fresh());
  await pending;
  assert.equal(renders, before);
  assert.ok(!browser.render(100).join("\n").includes("main"));
});

test("modal uses the injected terminal for resize and closes without waiting for registry", async () => {
  const terminal = { columns: 120, rows: 40 };
  let resolveRead!: (view: RegistryView) => void;
  let reads = 0;
  let component!: ReturnType<typeof createBrowser>;
  const ctx = { ui: { custom: (factory: any, options: any) => new Promise<void>(resolve => {
    component = factory({ terminal, requestRender() {} }, theme, {}, resolve);
    assert.equal(options.overlayOptions().width, 118);
    terminal.columns = 60;
    assert.equal(options.overlayOptions().width, 58);
    component.handleInput("q");
  }) } } as unknown as ExtensionCommandContext;
  await openBrowser(ctx, { readRegistry: () => { reads++; return new Promise(r => { resolveRead = r; }); }, performPaneAction: async () => {} });
  resolveRead(fresh());
  await tick();
  assert.equal(reads, 1);
  assert.ok(!component.render(80).join("\n").includes("main"));
});

test("other-server and old per-agent observations stay read-only", async () => {
  const { browser, setView, actions } = setup();
  setView({ ...fresh(), agents: [{ ...agents[1], pane: { ...agents[1].pane!, server: "/another/socket" } }] });
  await browser.refresh();
  browser.handleInput("H");
  await tick();
  assert.deepEqual(actions, []);
  assert.ok(browser.render(100).join("\n").includes("another tmux server"));
  setView({ ...fresh(), agents: [{ ...agents[1], observedAt: Date.now() - 31000 }] });
  await browser.refresh();
  browser.handleInput("H");
  await tick();
  assert.deepEqual(actions, []);
  browser.dispose();
});

test("compact modal keeps the kill confirmation visible", async () => {
  const { browser, terminal } = setup();
  await browser.refresh();
  browser.handleInput("j");
  browser.handleInput("\x18");
  terminal.rows = 6;
  assert.ok(browser.render(100).some(line => line.includes("PID 200") && line.includes("y/n")));
  browser.dispose();
});

test("footer does not offer moving or killing the invoking pane", async () => {
  const { browser } = setup();
  await browser.refresh();
  assert.ok(!browser.render(120).join("\n").includes("Ctrl+X kill"));
  browser.handleInput("j");
  assert.ok(browser.render(120).join("\n").includes("Ctrl+X kill"));
  browser.dispose();
});

test("browser fills large terminals without a size cap", async () => {
  const { browser, terminal } = setup();
  terminal.columns = 220;
  terminal.rows = 70;
  await browser.refresh();
  assert.equal(browser.render(218).length, 68);
  browser.dispose();
});

test("list hides process and pane identifiers while details retains them", async () => {
  const { browser } = setup();
  await browser.refresh();
  const text = browser.render(100).join("\n");
  assert.ok(!text.includes("PID 100"));
  assert.ok(!text.includes("session:0.0 %0"));
  browser.handleInput("i");
  const details = browser.render(100).join("\n");
  assert.ok(details.includes("PID: 100"));
  assert.ok(details.includes("session:0.0 %0"));
  browser.dispose();
});

test("current session is pinned above groups sorted waiting, busy, idle, unknown", async () => {
  const { browser, setView } = setup();
  let nextPid = 300;
  const row = (name: string, state: AgentSnapshot["activity"]["state"], tmux = true): AgentSnapshot => ({
    ...agents[1], process: { pid: nextPid++, startedAt: now },
    session: { mode: tmux ? "interactive" : "background", name },
    activity: { state, source: "pi-registry" }, pane: tmux ? agents[1].pane : undefined,
  });
  setView({ ...fresh(), agents: [row("non-idle", "idle", false), row("tmux-unknown", "unknown"), row("tmux-idle", "idle"), row("non-busy", "busy", false), row("tmux-busy", "busy"), { ...agents[0], activity: { state: "unknown", source: "pi-registry" } }, row("tmux-waiting", "waiting")] });
  await browser.refresh();
  const lines = browser.render(120);
  const labels = ["main", "Interactive (tmux)", "tmux-waiting", "tmux-busy", "tmux-idle", "tmux-unknown", "Non-tmux", "non-busy", "non-idle"];
  const positions = labels.map(label => lines.findIndex(line => line.includes(label)));
  assert.ok(positions.every((position, index) => position >= 0 && (!index || position > positions[index - 1])), JSON.stringify(positions));
  browser.handleInput("j");
  assert.ok(browser.render(120).some(line => line.includes("→") && line.includes("tmux-waiting")));
  browser.dispose();
});

test("current Pi process is pinned even outside tmux", async () => {
  const current = { ...agents[1], process: { pid: process.pid, startedAt: now }, pane: undefined };
  const browser = createBrowser({ readRegistry: async () => ({ ...fresh(), agents: [agents[0], current] }), performPaneAction: async () => {} }, { columns: 100, rows: 30 }, theme, () => {}, () => {});
  await browser.refresh();
  assert.ok(browser.render(100).some(line => line.includes("→") && line.includes("review") && line.includes("current")));
  browser.dispose();
});

test("status, group headings and selected rows use semantic styling", async () => {
  const tones = new Set<string>();
  const browser = createBrowser({ readRegistry: async () => fresh(), origin: { server: "/socket", paneId: "%0" }, performPaneAction: async () => {} }, { columns: 100, rows: 30 }, { fg: (tone, text) => { tones.add(tone); return text; }, bold: text => text }, () => {}, () => {});
  await browser.refresh();
  browser.render(100);
  assert.ok(tones.has("success"));
  assert.ok(tones.has("muted"));
  assert.ok(tones.has("accent"));
  browser.dispose();
});

test("non-tmux and all non-interactive modes share one group, even with a mapped pane", async () => {
  const { browser, setView } = setup();
  const modes: AgentSnapshot["session"]["mode"][] = ["interactive", "non-interactive", "background", "unknown"];
  const grouped = modes.map((mode, index): AgentSnapshot => ({
    ...agents[1], process: { pid: 500 + index, startedAt: now },
    session: { mode, name: `grouped-${mode}` },
    pane: mode === "interactive" ? undefined : agents[1].pane,
  }));
  setView({ ...fresh(), agents: [agents[1], ...grouped] });
  await browser.refresh();
  const lines = browser.render(120);
  const groupIndex = lines.findIndex(line => line.includes("Non-tmux"));
  assert.ok(groupIndex >= 0);
  assert.equal(lines.filter(line => line.includes("Non-tmux")).length, 1);
  for (const agent of grouped) {
    assert.ok(lines.findIndex(line => line.includes(agent.session.name!)) > groupIndex);
  }
  assert.ok(lines.findIndex(line => line.includes("review")) < groupIndex);
  browser.dispose();
});
