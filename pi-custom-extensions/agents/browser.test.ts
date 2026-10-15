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

test("Right Arrow previews the selected session, smart-follow pauses above bottom and End resumes", async () => {
  let snapshot = { entries: Array.from({ length: 40 }, (_, i) => ({ label: "ASSISTANT", text: `message-${i}` })), usage: "input=12 · Recorded cost: $0.010000", warnings: [] };
  const readTargets: number[] = [];
  const browser = createBrowser({ readRegistry: async () => fresh(), readSession: async agent => { readTargets.push(agent.process.pid); return snapshot; }, performPaneAction: async () => {} }, { columns: 120, rows: 16 }, theme, () => {}, () => {});
  await browser.refresh();
  browser.handleInput("j");
  browser.handleInput("\x1b[C");
  await tick();
  let text = browser.render(118).join("\n");
  assert.ok(text.includes("message-39") && text.includes("input=12") && text.includes("Following"));
  assert.deepEqual(readTargets, [200]);
  browser.handleInput("\x1b[H");
  text = browser.render(118).join("\n");
  assert.ok(text.includes("message-0") && !text.includes("message-39"));
  snapshot = { ...snapshot, entries: [...snapshot.entries, { label: "USER", text: "new-message" }] };
  await browser.refresh();
  text = browser.render(118).join("\n");
  assert.ok(text.includes("message-0") && !text.includes("new-message") && text.includes("Paused"));
  browser.handleInput("\x1b[F");
  assert.ok(browser.render(118).join("\n").includes("new-message"));
  snapshot = { ...snapshot, entries: [...snapshot.entries, { label: "ASSISTANT", text: "latest-message" }] };
  await browser.refresh();
  assert.ok(browser.render(118).join("\n").includes("latest-message"));
  for (const width of [1, 10, 40, 118]) assert.ok(browser.render(width).every(line => visibleWidth(line) <= width));
  browser.handleInput("\x1b[D");
  assert.ok(browser.render(118).some(line => line.includes("→") && line.includes("review")));
  browser.dispose();
});

test("preview failures stay inspectable and returning to list ignores late session reads", async () => {
  let reject = true;
  let resolve!: (value: { entries: Array<{ label: string; text: string }>; usage: string; warnings: string[] }) => void;
  let renders = 0;
  const browser = createBrowser({ readRegistry: async () => fresh(), readSession: async () => { if (reject) throw new Error("Session file missing"); return new Promise(r => { resolve = r; }); }, performPaneAction: async () => {} }, { columns: 100, rows: 30 }, theme, () => { renders++; }, () => {});
  await browser.refresh();
  browser.handleInput("\x1b[C");
  await tick();
  assert.ok(browser.render(100).join("\n").includes("Session file missing"));
  reject = false;
  browser.handleInput("r");
  await tick();
  browser.handleInput("\x1b");
  const before = renders;
  resolve({ entries: [{ label: "USER", text: "late-message" }], usage: "", warnings: [] });
  await tick();
  assert.equal(renders, before);
  assert.ok(!browser.render(100).join("\n").includes("late-message"));
  browser.dispose();
});

test("preview keeps token and cost summary visible at ordinary terminal widths", async () => {
  const browser = createBrowser({ readRegistry: async () => fresh(), readSession: async () => ({ entries: [{ label: "USER", text: "prompt" }], usage: "Observed tokens: input=100 output=20 cache-read=3000 cache-write=0 · Recorded cost: $0.010000", warnings: [] }), performPaneAction: async () => {} }, { columns: 80, rows: 24 }, theme, () => {}, () => {});
  await browser.refresh();
  browser.handleInput("\x1b[C");
  await tick();
  const text = browser.render(78).join("\n");
  assert.ok(text.includes("input=100") && text.includes("$0.010000") && text.includes("prompt"));
  browser.dispose();
});

test("default preview reader follows file-backed messages and does not render after disposal", async () => {
  const { mkdtemp, writeFile, appendFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "browser-preview-"));
  try {
    const file = join(dir, "session.jsonl");
    await writeFile(file, JSON.stringify({ type: "message", id: "u", parentId: null, message: { role: "user", content: "file prompt" } }) + "\n");
    const target = { ...agents[1], session: { ...agents[1].session, file } };
    let renders = 0;
    const browser = createBrowser({ readRegistry: async () => ({ ...fresh(), agents: [target] }), performPaneAction: async () => {} }, { columns: 100, rows: 30 }, theme, () => { renders++; }, () => {});
    await browser.refresh();
    browser.handleInput("\x1b[C");
    // Registry refresh waits for a session read only when one is not already in flight.
    for (let i = 0; i < 100 && !browser.render(98).join("\n").includes("file prompt"); i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(browser.render(98).join("\n").includes("file prompt"));
    await appendFile(file, JSON.stringify({ type: "message", id: "a", parentId: "u", message: { role: "assistant", content: [{ type: "text", text: "file answer" }] } }) + "\n");
    await browser.refresh();
    assert.ok(browser.render(98).join("\n").includes("file answer"));
    browser.dispose();
    const before = renders;
    await browser.refresh();
    assert.equal(renders, before);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("registry listener advertisements update list badges and details without exposing paths", async () => {
  const { browser, setView } = setup();
  const messaging = { transport: "unix", protocol: "pi-listener-v2", path: "/tmp/private-listener.sock", reportedAt: Date.now() } as const;
  setView({ ...fresh(), agents: [{ ...agents[0], messaging }] });
  await browser.refresh();
  let text = browser.render(120).join("\n");
  assert.ok(text.includes("[listening]"));
  assert.ok(!text.includes(messaging.path));
  for (const width of [1, 10, 40, 120]) assert.ok(browser.render(width).every(line => visibleWidth(line) <= width));
  browser.handleInput("i");
  text = browser.render(120).join("\n");
  assert.ok(text.includes("listener: advertised (not probed)"));
  assert.ok(!text.includes(messaging.path));
  setView({ ...fresh(), agents: [agents[0]] });
  await browser.refresh();
  assert.ok(browser.render(120).join("\n").includes("listener: off (not advertised)"));
  browser.handleInput("\x1b");
  assert.ok(browser.render(120).join("\n").includes("[listener off]"));
  browser.dispose();
});

for (const reason of ["registry", "unavailable", "endpoint", "future", "observation"]) {
  test(`${reason} staleness does not show a listener as currently listening`, async () => {
    const { browser, setView } = setup();
    const at = Date.now();
    const agent: AgentSnapshot = { ...agents[0], observedAt: reason === "observation" ? at - 31000 : at,
      messaging: { transport: "unix", protocol: "pi-listener-v2", path: "/tmp/private-listener.sock", reportedAt: reason === "endpoint" ? at - 21000 : reason === "future" ? at + 6000 : at } };
    setView({ ...fresh(), state: reason === "registry" ? "stale" : reason === "unavailable" ? "unavailable" : "fresh", agents: [agent] });
    await browser.refresh();
    const text = browser.render(120).join("\n");
    assert.ok(text.includes("[listener stale]"));
    assert.ok(!text.includes("[listening]"));
    browser.handleInput("i");
    assert.ok(browser.render(120).join("\n").includes("listener: stale advertisement (not probed)"));
    browser.dispose();
  });
}

test("listener badges follow file-backed registry snapshots and health", async t => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { readRegistry } = await import("./reader.ts");
  const dir = await mkdtemp(join(tmpdir(), "browser-listener-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const at = Date.now();
  const target: AgentSnapshot = { ...agents[0], observedAt: at,
    messaging: { transport: "unix", protocol: "pi-listener-v2", path: "/tmp/nonexistent-listener.sock", reportedAt: at } };
  const health = { version: 1, pid: 456, state: "running", startedAt: at - 10000, updatedAt: at,
    lastSuccessfulProcessDiscoveryAt: at, agentCount: 1, errors: [] };
  await writeFile(join(dir, "agents.jsonl"), JSON.stringify(target) + "\n");
  await writeFile(join(dir, "registry-health.json"), JSON.stringify(health));
  const browser = createBrowser({ readRegistry: () => readRegistry(dir), performPaneAction: async () => {} },
    { columns: 120, rows: 30 }, theme, () => {}, () => {});
  t.after(() => browser.dispose());
  await browser.refresh();
  assert.ok(browser.render(120).join("\n").includes("[listening]"));
  await writeFile(join(dir, "registry-health.json"), JSON.stringify({ ...health, state: "stopped" }));
  await browser.refresh();
  assert.ok(browser.render(120).join("\n").includes("[listener stale]"));
  const { messaging, ...withoutListener } = target;
  await writeFile(join(dir, "registry-health.json"), JSON.stringify(health));
  await writeFile(join(dir, "agents.jsonl"), JSON.stringify(withoutListener) + "\n");
  await browser.refresh();
  assert.ok(browser.render(120).join("\n").includes("[listener off]"));
});
