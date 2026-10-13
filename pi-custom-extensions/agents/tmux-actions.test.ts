import assert from "node:assert/strict";
import { test } from "node:test";
import { performPaneAction } from "./tmux-actions.ts";
import type { AgentSnapshot } from "./reader.ts";
import type { Runner } from "../../agents-registry/src/types.ts";

const agent: AgentSnapshot = { schemaVersion: 1, harness: "pi", observedAt: 1800000000000, process: { pid: 301, startedAt: Date.parse("2026-10-09T09:39:50Z") }, session: { mode: "interactive" }, activity: { state: "idle", source: "process-only" }, pane: { server: "/tmp/socket", sessionId: "$2", sessionName: "agent", windowIndex: "2", paneIndex: "0", id: "%2", cwd: "/work" } };
const origin = { server: "/tmp/socket", paneId: "%0" };
function fixture() {
  const calls: string[][] = [];
  const runner: Runner = async (command, args) => {
    calls.push([command, ...args]);
    if (command === "ps") return "300 1 Fri Oct 9 09:39:49 2026 zsh zsh\n301 300 Fri Oct 9 09:39:50 2026 pi pi\n";
    if (args.includes("list-panes")) return "$0\torigin\t0\t0\t%0\t100\t/work\n$2\tagent\t2\t0\t%2\t300\t/work\n";
    if (args.includes("display-message")) return "$0\n";
    if (args.includes("list-clients")) return "tty1\t$0\t1\ntty2\t$0\t2\nother\t$2\t100\n";
    return "";
  };
  return { calls, runner };
}
for (const [action, command, suffix] of [
  ["attach", "switch-client", ["-c", "tty2", "-t", "%2"]],
  ["vertical", "join-pane", ["-v", "-s", "%2", "-t", "%0"]],
  ["horizontal", "join-pane", ["-h", "-s", "%2", "-t", "%0"]],
  ["kill", "kill-pane", ["-t", "%2"]],
] as const) test(`${action} acts on the verified pane using the invoking server`, async () => {
  const { calls, runner } = fixture();
  await performPaneAction(origin, agent, action, runner);
  assert.deepEqual(calls.at(-1), ["tmux", "-S", "/tmp/socket", command, ...suffix]);
});
for (const [name, altered] of [
  ["PID reuse", { ...agent, process: { ...agent.process, startedAt: 1 } }],
  ["moved ancestry", { ...agent, process: { ...agent.process, pid: 300, startedAt: Date.parse("2026-10-09T09:39:49Z") }, pane: { ...agent.pane!, id: "%0" } }],
  ["another server", { ...agent, pane: { ...agent.pane!, server: "/other/socket" } }],
  ["headless agent", { ...agent, session: { mode: "non-interactive" as const } }],
] as const) test(`rejects ${name} without mutation`, async () => {
  const { calls, runner } = fixture();
  await assert.rejects(performPaneAction(origin, altered, "kill", runner));
  assert.ok(!calls.some(c => c.includes("kill-pane")));
});
test("protects current pane and does not redirect unrelated clients", async () => {
  const { calls, runner } = fixture();
  await assert.rejects(performPaneAction({ ...origin, paneId: "%2" }, agent, "kill", runner), /current pane/);
  await assert.rejects(performPaneAction(origin, agent, "attach", (cmd, args) => args.includes("list-clients") ? Promise.resolve("other\t$2\t100\n") : runner(cmd, args)), /No attached/);
  assert.ok(!calls.some(c => c.includes("switch-client") || c.includes("kill-pane")));
});
