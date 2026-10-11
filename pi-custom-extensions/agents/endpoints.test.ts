import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import agentsExtension from "./index.ts";
import { claudeEndpointRows, formatClaudeEndpoints } from "./endpoints.ts";
import type { Runner } from "./tmux.ts";

const wrapper = join(dirname(fileURLToPath(import.meta.url)), "./scripts/claude-statusline-wrapper.mjs");

test("endpoint report shows live Claude records without disclosing socket paths by default", async () => {
  const directory = mkdtempSync(join(tmpdir(), "claude-endpoint-report-"));
  try {
    const socketPath = "/tmp/private-claude-test.sock";
    const result = spawnSync("node", [wrapper, "--registry", join(directory, "claude"), "--command", "cat"], {
      input: '{"session_id":"session-uuid"}', env: { ...process.env, CLAUDE_CODE_MESSAGING_SOCKET: socketPath },
    });
    assert.equal(result.status, 0);
    const startedAt = "Fri Oct  9 09:39:50 2020";
    const runner: Runner = async (command) => command === "claude" ? JSON.stringify([
      { pid: 201, kind: "interactive", cwd: "/work", status: "idle", sessionId: "session-uuid" },
      { pid: 202, kind: "background", cwd: "/work", status: "busy", sessionId: "other" },
      { pid: 203, kind: "interactive", cwd: "/work", status: "idle" },
      { pid: 999, kind: "background", cwd: "/work", status: "idle", sessionId: "exited" },
    ]) : `201 1 ${startedAt} claude claude\n202 1 ${startedAt} claude claude\n203 1 ${startedAt} claude claude\n`;
    const rows = await claudeEndpointRows(directory, false, runner);
    assert.deepEqual(rows.map((row) => row.endpoint), ["recorded (not probed)", "not captured or invalid", "no session ID"]);
    assert.equal(rows[0].socketPath, socketPath);
    assert.ok(!formatClaudeEndpoints(rows).includes(socketPath));
    assert.ok(formatClaudeEndpoints(rows, true).includes(socketPath));
    const checked = await claudeEndpointRows(directory, true, runner);
    assert.equal(checked[0].endpoint, "unavailable");
    assert.equal(checked.length, 3);
    assert.equal(formatClaudeEndpoints([]), "No live Claude sessions reported by claude agents --json.");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("/diagnostics:claude-endpoints registers without requiring tmux and rejects unexpected arguments", async () => {
  const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
  agentsExtension({
    on() {},
    registerCommand(name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) {
      commands.set(name, command);
    },
  } as unknown as ExtensionAPI);
  const notices: string[] = [];
  assert.equal(commands.has("claude-endpoints"), false);
  await commands.get("diagnostics:claude-endpoints")?.handler("--unknown", { ui: { notify: (text: string) => notices.push(text) } });
  assert.deepEqual(notices, ["Usage: /diagnostics:claude-endpoints [--probe] [--paths]"]);
});
