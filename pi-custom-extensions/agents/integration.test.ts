import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { act, run, snapshot, type Runner } from "./tmux.ts";
import { discover } from "./discovery.ts";

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

    // The fixture stands in for Claude's PID; discovery must not depend on its process title.
    writeFileSync(fixture, 'process.title = "claude-fixture"; setInterval(() => {}, 60000);\n');
    await tmux(["new-window", "-d", "-t", "origin", "-n", "claude", `exec node ${quote(fixture)}`]);
    const claudePane = (await tmux(["display-message", "-p", "-t", "origin:claude", "#{pane_id}"])).trim();
    await delay(100);
    const claudePid = (await snapshot(socket)).panes.find((pane) => pane.id === claudePane)?.pid;
    assert.ok(claudePid);
    const claudeRunner: Runner = (command, args) => command === "claude"
      ? Promise.resolve(JSON.stringify([{ pid: claudePid, kind: "interactive", cwd: directory, status: "idle" }]))
      : run(command, args);
    const claude = (await discover(socket, claudeRunner)).find((agent) => agent.provider === "claude");
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
