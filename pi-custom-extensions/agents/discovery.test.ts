import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { discover, parseClaudeSessions } from "./discovery.ts";
import { act, isInteractive, isSelectable, parseProcesses, type Runner } from "./tmux.ts";
import { writeStatus } from "./registry.ts";

const ps = `
 100 1 Fri Oct  9 09:39:49 2026 zsh zsh
 101 100 Fri Oct  9 09:39:50 2026 pi pi
 102 100 Fri Oct  9 09:39:51 2026 pi pi --mode rpc
 103 1 Fri Oct  9 09:39:52 2026 pi pi
 200 1 Fri Oct  9 09:39:49 2026 zsh zsh
 201 200 Fri Oct  9 09:39:50 2026 /Users/budi/.loc /Users/budi/.local/bin/claude
 202 201 Fri Oct  9 09:39:51 2026 other-title anything
 203 200 Fri Oct  9 09:39:52 2026 claude claude --print prompt
 204 1 Fri Oct  9 09:39:53 2026 claude claude
 205 200 Fri Oct  9 09:39:54 2026 claude claude
`;
const panes = "$0\tcurrent\t0\t0\t%0\t100\t/work/pi\n" +
  "$1\tother\t1\t0\t%1\t200\t/work/claude\n";
const sessions = [
  { pid: 201, kind: "interactive", cwd: "/work/claude", status: "busy", name: "Feature", sessionId: "uuid" },
  { pid: 202, kind: "interactive", cwd: "/work/claude", status: "waiting", waitingFor: "permission prompt" },
  { pid: 203, kind: "interactive", cwd: "/work/claude", status: "busy" },
  { pid: 204, kind: "interactive", cwd: "/work/remote", status: "idle" },
  { pid: 205, kind: "background", cwd: "/work/background", status: "idle" },
  { pid: 999, kind: "interactive", cwd: "/work/exited", status: "idle" },
  { kind: "background", cwd: "/work/exited", state: "blocked" },
];
const fakeRunner: Runner = async (command) => command === "claude" ? JSON.stringify(sessions) : command === "ps" ? ps : panes;

test("Claude JSON uses live PID matching and process ancestry, regardless of process title", async () => {
  const agents = await discover("/tmp/socket", fakeRunner, "/nonexistent/registry");
  const selectable = agents.filter(isSelectable);
  assert.deepEqual(selectable.map((agent) => [agent.provider, agent.process.pid, agent.pane.id]), [
    ["pi", 101, "%0"], ["claude", 201, "%1"], ["claude", 202, "%1"],
  ]);
  assert.equal(selectable[1].metadata?.state, "busy");
  assert.equal(selectable[1].metadata?.name, "Feature");
  assert.equal(selectable[2].metadata?.waitingFor, "permission prompt");
  assert.equal(agents.some((agent) => agent.process.pid === 999), false);
  assert.deepEqual(agents.filter((agent) => !isSelectable(agent)).map((agent) => agent.process.pid), [102, 103, 203, 204, 205]);
});

test("malformed entries and exited jobs are ignored; duplicate Claude PIDs are deduplicated", () => {
  assert.deepEqual(parseClaudeSessions(JSON.stringify([null, {}, { pid: "201", kind: "interactive", cwd: "/x" }])), []);
  assert.equal(parseClaudeSessions(JSON.stringify([sessions[0], sessions[0]])).length, 1);
  assert.throws(() => parseClaudeSessions("{}"), /array/);
  assert.throws(() => parseClaudeSessions("not JSON"));
});

test("missing Claude binary does not hide Pi or display a warning", async () => {
  const agents = await discover("/tmp/socket", async (command, args) => {
    if (command === "claude") throw Object.assign(new Error("not installed"), { code: "ENOENT" });
    return fakeRunner(command, args);
  }, "/nonexistent/registry");
  assert.equal(agents.length, 3);
  assert.equal(agents.warning, undefined);
});

test("Claude CLI errors and malformed JSON preserve Pi discovery and provide a warning", async () => {
  for (const output of ["", "{}", "invalid"]) {
    const agents = await discover("/tmp/socket", async (command, args) => command === "claude" ? output : fakeRunner(command, args), "/nonexistent/registry");
    assert.equal(agents.length, 3);
    assert.match(agents.warning ?? "", /Claude discovery unavailable/);
  }
});

test("Pi runtime metadata marks headless instances even when their title hides CLI flags", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agents-discovery-"));
  try {
    const process = parseProcesses(ps).get(101)!;
    writeStatus(directory, {
      pid: process.pid, startedAt: process.startedAt, updatedAt: Date.now(), state: "working",
      interactive: false, sessionId: "pi-session", cwd: "/runtime/cwd", model: "provider/model",
    });
    const agent = (await discover("/tmp/socket", fakeRunner, directory)).find((agent) => agent.process.pid === 101)!;
    assert.equal(isSelectable(agent), false);
    assert.equal(agent.metadata?.state, "working");
    assert.equal(agent.metadata?.cwd, "/runtime/cwd");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("non-interactive actions are rejected before running any command", async () => {
  const agents = (await discover("/tmp/socket", fakeRunner, "/nonexistent/registry")).filter((agent) => !isSelectable(agent));
  for (const agent of agents) {
    for (const action of ["attach", "vertical", "horizontal"] as const) {
      await assert.rejects(act("/tmp/socket", "%0", agent, action, async () => {
        assert.fail("Should not run any command");
      }), /Non-interactive/);
    }
  }
});

test("headless CLI flags exclude print, RPC, and JSON modes", () => {
  const process = parseProcesses(ps).get(101)!;
  for (const args of ["pi -p prompt", "pi --print", "pi --mode rpc", "pi --mode=json", "claude --print prompt"]) {
    assert.equal(isInteractive({ ...process, args }), false);
  }
  assert.equal(isInteractive({ ...process, args: "pi --model model" }), true);
});
