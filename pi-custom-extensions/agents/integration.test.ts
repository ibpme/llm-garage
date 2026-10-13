import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { performPaneAction } from "./tmux-actions.ts";
import { run, listProcesses, ancestryDistance } from "../../agents-registry/src/discovery/processes.ts";
import type { Runner } from "../../agents-registry/src/types.ts";
import type { AgentSnapshot } from "./reader.ts";
async function discover(socket: string, runner: Runner, claudePid?: number): Promise<AgentSnapshot[]> {
  const processes = await listProcesses(runner);
  const panes = (await runner("tmux", ["-S", socket, "-u", "list-panes", "-a", "-F", "#{session_id}\t#{session_name}\t#{window_index}\t#{pane_index}\t#{pane_id}\t#{pane_pid}\t#{pane_current_path}"])).trim().split("\n").map(line => line.split("\t"));
  return [...processes.values()].filter(info => info.command === "pi" || info.pid === claudePid).flatMap(info => {
    const fields = panes.find(pane => ancestryDistance(info.pid, Number(pane[5]), processes) !== undefined);
    if (!fields) return [];
    return [{ schemaVersion: 1 as const, harness: info.pid === claudePid ? "claude" as const : "pi" as const,
      observedAt: Date.now(), process: { pid: info.pid, startedAt: info.startedAt }, session: { mode: "interactive" as const },
      activity: { state: "unknown" as const, source: "process-only" as const },
      pane: { server: socket, sessionId: fields[0], sessionName: fields[1], windowIndex: fields[2], paneIndex: fields[3], id: fields[4], cwd: fields[6] } }];
  });
}
const act = (socket: string, origin: string, agent: Parameters<typeof performPaneAction>[1], action: Parameters<typeof performPaneAction>[2]) => performPaneAction({ server: socket, paneId: origin }, agent, action);

const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;

test("isolated tmux server: discover, switch client, and move panes in both directions", async (t) => {
  if (process.platform === "win32") { t.skip("Requires macOS/Linux"); return; }
  try {
    await run("tmux", ["-V"]);
    await run("node", ["--version"]);
  } catch { t.skip("Requires tmux and Node on PATH"); return; }

  const directory = mkdtempSync(join(tmpdir(), "pi-agents-integration-"));
  const socket = join(directory, "socket");
  const tmux = (args: string[]) => run("tmux", ["-S", socket, "-u", "-f", "/dev/null", ...args]);
  const fixture = join(directory, "pi-fixture.cjs");
  writeFileSync(fixture, 'process.title = "pi"; setInterval(() => {}, 60000);\n');
  let client: ReturnType<typeof spawn> | undefined;
  try {
    await tmux(["new-session", "-d", "-s", "origin", "-x", "120", "-y", "40", "sleep 60"]);
    const origin = (await tmux(["display-message", "-p", "-t", "origin", "#{pane_id}"])).trim();
    await tmux(["new-session", "-d", "-s", "agent", `exec node ${quote(fixture)}`]);
    const runner: Runner = (command, args) => command === "claude" ? Promise.resolve("[]") : run(command, args);
    let agents = (await discover(socket, runner)).filter((agent) => agent.pane);
    for (let attempt = 0; agents.length === 0 && attempt < 30; attempt++) {
      await delay(100);
      agents = (await discover(socket, runner)).filter((agent) => agent.pane);
    }
    assert.equal(agents.length, 1);
    const agent = agents[0];
    assert.ok(agent.pane);

    client = spawn("tmux", ["-S", socket, "-C", "attach-session", "-t", "origin"], { stdio: "pipe" });
    client.stdout?.resume();
    client.stderr?.resume();
    let clients = "";
    for (let attempt = 0; !clients.trim() && attempt < 30; attempt++) {
      await delay(100);
      clients = await tmux(["list-clients", "-F", "#{session_name}"]);
    }
    assert.equal(clients.trim(), "origin");
    await act(socket, origin, agent, "attach");
    assert.equal((await tmux(["list-clients", "-F", "#{session_name}"])).trim(), "agent");
    await tmux(["switch-client", "-t", "origin"]);

    await act(socket, origin, agent, "vertical");
    const geometry = () => tmux(["list-panes", "-t", "origin:0", "-F", "#{pane_id}\t#{pane_left}\t#{pane_top}"]);
    let layout = (await geometry()).trim().split("\n").map((line) => line.split("\t"));
    assert.equal(layout.length, 2);
    assert.equal(layout[0][1], layout[1][1]);
    assert.notEqual(layout[0][2], layout[1][2]);

    await tmux(["break-pane", "-d", "-s", agent.pane.id]);
    const moved = (await discover(socket, runner)).find((item) => item.process.pid === agent.process.pid);
    assert.ok(moved);
    await act(socket, origin, moved, "horizontal");
    layout = (await geometry()).trim().split("\n").map((line) => line.split("\t"));
    assert.equal(layout.length, 2);
    assert.notEqual(layout[0][1], layout[1][1]);
    assert.equal(layout[0][2], layout[1][2]);

    // Pane actions use verified registry identity, not a harness-specific process title.
    writeFileSync(fixture, 'process.title = "claude-fixture"; setInterval(() => {}, 60000);\n');
    await tmux(["new-window", "-d", "-t", "origin", "-n", "claude", `exec node ${quote(fixture)}`]);
    const claudePane = (await tmux(["display-message", "-p", "-t", "origin:claude", "#{pane_id}"])).trim();
    await delay(100);
    const claudePid = Number((await tmux(["display-message", "-p", "-t", claudePane, "#{pane_pid}"])).trim());
    assert.ok(claudePid);
    const claudeRunner: Runner = (command, args) => command === "claude"
      ? Promise.resolve(JSON.stringify([{ pid: claudePid, kind: "interactive", cwd: directory, status: "idle" }]))
      : run(command, args);
    const claude = (await discover(socket, claudeRunner, claudePid)).find((agent) => agent.harness === "claude");
    assert.ok(claude?.pane);
    assert.equal(claude.pane.id, claudePane);
    await act(socket, origin, claude, "attach");
    assert.equal((await tmux(["display-message", "-p", "-t", "origin", "#{pane_id}"])).trim(), claudePane);
    await act(socket, origin, claude, "horizontal");
    assert.equal((await geometry()).trim().split("\n").length, 3);
  } finally {
    client?.stdin?.end();
    client?.kill();
    await tmux(["kill-server"]).catch(() => {});
    rmSync(directory, { recursive: true, force: true });
  }
});
