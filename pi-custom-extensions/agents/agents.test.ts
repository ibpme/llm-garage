import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { act, findAgents, isDescendant, isPi, parsePanes, parseProcesses, type Agent, type ProcessInfo, type Runner } from "./tmux.ts";
import { readStatus, removeStatus, writeStatus, type AgentStatus } from "./registry.ts";

const ps = `
 100 1 Fri Oct  9 09:39:49 2026 /bin/zsh zsh
 101 100 Fri Oct  9 09:39:50 2026 /bin/bash bash wrapper.sh
 102 101 Fri Oct  9 09:39:51 2026 pi pi
 103 102 Fri Oct  9 09:39:52 2026 pi pi
 200 1 Fri Oct  9 09:39:49 2026 /bin/zsh zsh
 201 200 Fri Oct  9 09:39:50 2026 node node unrelated.js
 300 1 Fri Oct  9 09:39:49 2026 /bin/zsh zsh
 301 300 Fri Oct  9 09:39:50 2026 /usr/bin/node node /opt/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js
`;
const panes = "$0\tcurrent\t0\t0\t%0\t100\t/work/current\n" +
  "$1\tother session\t1\t0\t%1\t200\t/work/other\n" +
  "$2\tpi session\t2\t0\t%2\t300\t/work/pi\n";

const info = (command: string, args: string): ProcessInfo => ({
  pid: 1, ppid: 0, startedAt: "Fri Oct 9 09:39:49 2026", command, args,
});

test("finds nested Pi processes and bundled Node entrypoints, ignoring unrelated Node", () => {
  const found = findAgents(parsePanes(panes), parseProcesses(ps));
  assert.deepEqual(found.map((agent) => [agent.pane.id, agent.process.pid]), [
    ["%0", 102], ["%0", 103], ["%2", 301],
  ]);
  assert.equal(found[0].process.startedAt, "Fri Oct 9 09:39:51 2026");
  assert.equal(found[2].pane.sessionName, "pi session");
});

test("recognizes executable paths and legacy CLI paths without matching incidental mentions", () => {
  assert.ok(isPi(info("/opt/bin/pi", "pi")));
  assert.ok(isPi(info("node", "node /opt/node_modules/@mariozechner/pi-coding-agent/dist/cli.js")));
  assert.ok(isPi(info("bun", "bun /opt/node_modules/@earendil-works/pi-coding-agent/src/cli.ts")));
  assert.ok(isPi(info("node", "node /opt/bin/pi")));
  assert.equal(isPi(info("node", "node app.js /opt/pi-coding-agent/dist/cli.js")), false);
  assert.equal(isPi(info("bash", "bash -c pi")), false);
});

test("ancestry includes pane root and tolerates missing parents and cycles", () => {
  const processes = parseProcesses(ps);
  assert.ok(isDescendant(100, 100, processes));
  assert.equal(isDescendant(999, 100, processes), false);
  processes.set(900, { ...info("pi", "pi"), pid: 900, ppid: 901 });
  processes.set(901, { ...info("pi", "pi"), pid: 901, ppid: 900 });
  assert.equal(isDescendant(900, 100, processes), false);
});

test("malformed process and pane lines are ignored", () => {
  assert.equal(parseProcesses("garbage\n").size, 0);
  assert.deepEqual(parsePanes("garbage\n"), []);
});

function fakeRunner(): { calls: string[][]; runner: Runner } {
  const calls: string[][] = [];
  const runner: Runner = async (command, args) => {
    calls.push([command, ...args]);
    if (command === "ps") return ps;
    if (args.includes("list-panes")) return panes;
    if (args.includes("display-message")) return "$0\n";
    if (args.includes("list-clients")) return "/dev/tty1\t$0\t1\n/dev/tty2\t$0\t2\n/dev/tty3\t$2\t100\n";
    return "";
  };
  return { calls, runner };
}

const target = {
  provider: "pi", interactive: true,
  pane: {
    sessionId: "$2", sessionName: "pi session", windowIndex: "2", paneIndex: "0",
    id: "%2", pid: 300, cwd: "/work/pi",
  },
  process: {
    pid: 301, ppid: 300, startedAt: "Fri Oct 9 09:39:50 2026", command: "/usr/bin/node",
    args: "node /opt/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
  },
} satisfies Agent;

test("Enter switches the most recently active client in the originating session", async () => {
  const { calls, runner } = fakeRunner();
  await act("/tmp/socket", "%0", target, "attach", runner);
  assert.deepEqual(calls.at(-1), ["tmux", "-S", "/tmp/socket", "switch-client", "-c", "/dev/tty2", "-t", "$2:2.0"]);
  assert.equal(calls.some((call) => call.includes("attach-session")), false);
});

for (const [action, flag] of [["vertical", "-v"], ["horizontal", "-h"]] as const) {
  test(`${action} moves the selected pane into the originating pane`, async () => {
    const { calls, runner } = fakeRunner();
    await act("/tmp/socket", "%0", target, action, runner);
    assert.deepEqual(calls.at(-1), ["tmux", "-S", "/tmp/socket", "join-pane", flag, "-s", "%2", "-t", "%0"]);
  });
}

test("rejects an exited process or reused PID before changing tmux", async () => {
  const { calls, runner } = fakeRunner();
  const stale = { ...target, process: { ...target.process, startedAt: "different process" } };
  await assert.rejects(act("/tmp/socket", "%0", stale, "vertical", runner), /exited or moved/);
  assert.equal(calls.some((call) => call.includes("join-pane")), false);
});

test("current pane cannot be moved into itself; selecting it is a no-op", async () => {
  const { calls, runner } = fakeRunner();
  await assert.rejects(act("/tmp/socket", "%2", target, "vertical", runner), /itself/);
  await act("/tmp/socket", "%2", target, "attach", runner);
  assert.equal(calls.some((call) => call.includes("switch-client")), false);
});

test("does not switch an unrelated client if originating session has no client", async () => {
  const { runner } = fakeRunner();
  await assert.rejects(act("/tmp/socket", "%0", target, "attach", async (command, args) =>
    args.includes("list-clients") ? "/dev/tty3\t$2\t100\n" : runner(command, args)), /No attached/);
});

function registry(t: import("node:test").TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "pi-agents-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const now = 1_800_000_000_000;
  const status: AgentStatus = {
    pid: target.process.pid, startedAt: target.process.startedAt, updatedAt: now,
    state: "working", sessionId: "test", cwd: "/work/pi",
  };
  writeStatus(directory, status);
  return { directory, now, status };
}

test("published agent status is retrievable by process identity", (t) => {
  const { directory, now, status } = registry(t);
  assert.deepEqual(readStatus(directory, target.process, now), status);
});

test("agent status expires when its heartbeat is older than 20 seconds", (t) => {
  const { directory, now } = registry(t);
  assert.equal(readStatus(directory, target.process, now + 21_000), undefined);
});

test("agent status cannot be inherited by a reused PID", (t) => {
  const { directory, now } = registry(t);
  assert.equal(readStatus(directory, { ...target.process, startedAt: "reused" }, now), undefined);
});

test("malformed agent status is ignored", (t) => {
  const { directory, now, status } = registry(t);
  writeFileSync(join(directory, `${status.pid}.json`), "invalid json");
  assert.equal(readStatus(directory, target.process, now), undefined);
});

test("publishing an updated status replaces the previous state", (t) => {
  const { directory, now, status } = registry(t);
  writeStatus(directory, { ...status, state: "idle" });
  assert.equal(readStatus(directory, target.process, now)?.state, "idle");
});

test("removed status is no longer retrievable and cleanup can be repeated", (t) => {
  const { directory, now, status } = registry(t);
  removeStatus(directory, status.pid);
  removeStatus(directory, status.pid);
  assert.equal(readStatus(directory, target.process, now), undefined);
});

test("kill closes the selected pane without switching clients or splitting", async () => {
  const { calls, runner } = fakeRunner();
  await act("/tmp/socket", "%0", target, "kill", runner);
  assert.deepEqual(calls.at(-1), ["tmux", "-S", "/tmp/socket", "kill-pane", "-t", "%2"]);
  assert.equal(calls.some((call) => call.includes("switch-client") || call.includes("join-pane")), false);
});

test("kill protects every agent in the current pane", async () => {
  const { calls, runner } = fakeRunner();
  for (const agent of findAgents(parsePanes(panes), parseProcesses(ps)).filter((agent) => agent.pane.id === "%0")) {
    await assert.rejects(act("/tmp/socket", "%0", agent, "kill", runner), /Cannot kill the current pane/);
  }
  assert.equal(calls.length, 0);
});

for (const [name, overrides, reason] of [
  ["stale process identities", { process: { ...target.process, startedAt: "reused" } }, /exited or moved/],
  ["agents whose pane has moved", { pane: { ...target.pane, id: "%1" } }, /exited or moved/],
  ["non-interactive agents", { interactive: false }, /Non-interactive/],
] as const) {
  test(`kill rejects ${name} without killing a pane`, async () => {
    const { calls, runner } = fakeRunner();
    await assert.rejects(act("/tmp/socket", "%0", { ...target, ...overrides }, "kill", runner), reason);
    assert.equal(calls.some((call) => call.includes("kill-pane")), false);
  });
}
