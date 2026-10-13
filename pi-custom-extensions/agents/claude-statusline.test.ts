import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const scripts = join(dirname(fileURLToPath(import.meta.url)), "./scripts");
const wrapper = join(scripts, "claude-statusline-wrapper.mjs");
const installer = join(scripts, "install-claude-statusline.mjs");
const payload = Buffer.from(' { "session_id": "session-uuid", "model": {"id": "claude-test-model", "display_name": "Test Model"}, "prompt": "DO NOT STORE", "cost": {"total_cost_usd": 42} }\n\n');
// Tests may run inside Claude Code, which would otherwise leak its messaging socket into every wrapper.
const { CLAUDE_CODE_MESSAGING_SOCKET: _, ...env } = process.env;
const invoke = (registry: string, input = payload, command = "cat", socketPath?: string) =>
  spawnSync("node", [wrapper, "--registry", registry, "--command", command], {
    input, env: socketPath === undefined ? env : { ...env, CLAUDE_CODE_MESSAGING_SOCKET: socketPath },
  });

test("wrapper preserves stdin bytes and renderer output, writes only model metadata with private permissions", () => {
  const directory = mkdtempSync(join(tmpdir(), "claude-statusline-"));
  try {
    const registry = join(directory, "claude");
    const result = invoke(registry);
    assert.equal(result.status, 0);
    assert.deepEqual(result.stdout, payload);
    assert.equal(result.stderr.length, 0);
    const record = JSON.parse(readFileSync(join(registry, "session-uuid.json"), "utf8"));
    assert.deepEqual(Object.keys(record).sort(), ["version", "sessionId", "updatedAt", "model", "displayName"].sort());
    assert.equal(record.model, "claude-test-model");
    assert.equal(record.displayName, "Test Model");
    assert.equal(statSync(registry).mode & 0o777, 0o700);
    assert.equal(statSync(join(registry, "session-uuid.json")).mode & 0o777, 0o600);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("wrapper is fail-open for malformed JSON, absent model, unsafe session IDs, and registry write failures", () => {
  const directory = mkdtempSync(join(tmpdir(), "claude-statusline-fail-"));
  try {
    for (const input of ["invalid", "null", "{}", JSON.stringify({ session_id: "../escape", model: { id: "test" } })]) {
      const bytes = Buffer.from(input);
      const result = invoke(join(directory, "claude"), bytes);
      assert.equal(result.status, 0);
      assert.deepEqual(result.stdout, bytes);
    }
    assert.equal(existsSync(join(directory, "claude")), false);
    const blocked = join(directory, "blocked");
    writeFileSync(blocked, "file, not a directory");
    const result = invoke(blocked);
    assert.equal(result.status, 0);
    assert.deepEqual(result.stdout, payload);
    assert.equal(result.stderr.length, 0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("wrapper preserves renderer exit code, stdout and stderr", () => {
  const directory = mkdtempSync(join(tmpdir(), "claude-statusline-exit-"));
  try {
    const result = invoke(directory, payload, "printf 'output'; printf 'error' >&2; exit 37");
    assert.equal(result.status, 37);
    assert.equal(result.stdout.toString(), "output");
    assert.equal(result.stderr.toString(), "error");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("concurrent wrapper invocations use separate temp files and leave a complete record", async () => {
  const directory = mkdtempSync(join(tmpdir(), "claude-statusline-concurrent-"));
  try {
    await Promise.all(Array.from({ length: 6 }, () => new Promise<void>((resolve, reject) => {
      const child = spawn("node", [wrapper, "--registry", directory, "--command", "cat >/dev/null"], { stdio: "pipe", env });
      child.stdin.end(payload);
      child.on("error", reject);
      child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`Wrapper exited ${code}`)));
    })));
    assert.deepEqual(readdirSync(directory), ["session-uuid.json"]);
    assert.equal(JSON.parse(readFileSync(join(directory, "session-uuid.json"), "utf8")).model, "claude-test-model");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("endpoint capture never breaks the renderer and does not write invalid paths", () => {
  const directory = mkdtempSync(join(tmpdir(), "claude-endpoint-invalid-"));
  try {
    for (const path of ["relative", "bad\npath"]) {
      assert.equal(invoke(join(directory, "claude"), payload, "cat", path).status, 0);
      assert.equal(existsSync(join(directory, "claude", "endpoints")), false);
    }
    const blocked = join(directory, "claude", "endpoints");
    writeFileSync(blocked, "not a directory");
    const result = invoke(join(directory, "claude"), payload, "cat", "/tmp/messaging.sock");
    assert.equal(result.status, 0);
    assert.deepEqual(result.stdout, payload);
    assert.equal(result.stderr.length, 0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("installer preserves existing renderer and settings, is idempotent, and uninstall restores only the command", () => {
  const directory = mkdtempSync(join(tmpdir(), "claude-statusline-install-"));
  try {
    const settings = join(directory, "settings.json");
    const original = { model: "opus", statusLine: { type: "command", command: "printf '%s' \"renderer's output\"", padding: 2 }, other: { keep: true } };
    writeFileSync(settings, JSON.stringify(original));
    const args = [installer, "--settings", settings, "--agent-dir", join(directory, "pi ' agent")];
    assert.equal(spawnSync("node", args).status, 0);
    const installed = JSON.parse(readFileSync(settings, "utf8"));
    assert.equal(installed.statusLine.padding, 2);
    assert.deepEqual(installed.other, original.other);
    assert.notEqual(installed.statusLine.command, original.statusLine.command);
    const render = spawnSync("/bin/bash", ["-c", installed.statusLine.command], { input: payload, env });
    assert.equal(render.status, 0);
    assert.equal(render.stdout.toString(), "renderer's output");
    assert.ok(existsSync(join(directory, "pi ' agent", "agents-live", "claude", "session-uuid.json")));
    assert.equal(spawnSync("node", args).status, 0);
    assert.equal(readdirSync(directory).filter((file) => file.includes("pre-agents-statusline")).length, 1);
    installed.model = "sonnet";
    installed.statusLine.padding = 4;
    writeFileSync(settings, JSON.stringify(installed));
    assert.equal(spawnSync("node", [...args, "--uninstall"]).status, 0);
    const restored = JSON.parse(readFileSync(settings, "utf8"));
    assert.equal(restored.statusLine.command, original.statusLine.command);
    assert.equal(restored.statusLine.padding, 4);
    assert.equal(restored.model, "sonnet");
    assert.equal(spawnSync("node", [...args, "--uninstall"]).status, 0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("uninstall refuses to overwrite a renderer changed after installation", () => {
  const directory = mkdtempSync(join(tmpdir(), "claude-statusline-conflict-"));
  try {
    const settings = join(directory, "settings.json");
    writeFileSync(settings, JSON.stringify({ statusLine: { type: "command", command: "cat" } }));
    const args = [installer, "--settings", settings];
    assert.equal(spawnSync("node", args).status, 0);
    writeFileSync(settings, JSON.stringify({ statusLine: { type: "command", command: "new renderer" } }));
    assert.equal(spawnSync("node", [...args, "--uninstall"]).status, 1);
    assert.equal(JSON.parse(readFileSync(settings, "utf8")).statusLine.command, "new renderer");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("wrapper forwards cancellation to its renderer process group", { timeout: 5_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "claude-statusline-cancel-"));
  const child = spawn("node", [wrapper, "--registry", directory, "--command", "printf ready; sleep 60 & wait"], { stdio: "pipe", env });
  try {
    child.stdin.end(payload);
    const exit = new Promise<string | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (_code, signal) => resolve(signal));
    });
    await new Promise<void>((resolve, reject) => {
      child.on("error", reject);
      child.stdout.once("data", () => resolve());
    });
    child.kill("SIGTERM");
    assert.equal(await exit, "SIGTERM");
  } finally {
    child.kill("SIGKILL");
    rmSync(directory, { recursive: true, force: true });
  }
});

test("wrapper tightens existing registry directories even for endpoint-only capture", () => {
  const directory = mkdtempSync(join(tmpdir(), "claude-private-registry-"));
  try {
    const registry = join(directory, "claude");
    const endpoints = join(registry, "endpoints");
    mkdirSync(endpoints, { recursive: true });
    chmodSync(registry, 0o755);
    chmodSync(endpoints, 0o755);
    const result = invoke(registry, Buffer.from('{"session_id":"socket-only"}'), "cat", "/tmp/messaging.sock");
    assert.equal(result.status, 0);
    assert.equal(statSync(registry).mode & 0o777, 0o700);
    assert.equal(statSync(endpoints).mode & 0o777, 0o700);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("installer recovers pending state when settings still contain the original command", () => {
  const directory = mkdtempSync(join(tmpdir(), "claude-pending-install-"));
  try {
    const settings = join(directory, "settings.json");
    const stateFile = `${settings}.agents-statusline-backup.json`;
    const originalStatusLine = { type: "command", command: "cat" };
    const pending = { version: 1, originalStatusLine, installedCommand: "pending wrapper" };
    const args = [installer, "--settings", settings, "--agent-dir", join(directory, "pi")];
    writeFileSync(settings, JSON.stringify({ statusLine: originalStatusLine }));
    writeFileSync(stateFile, JSON.stringify(pending));
    assert.equal(spawnSync("node", [...args, "--uninstall"]).status, 0);
    assert.equal(existsSync(stateFile), false);
    assert.equal(JSON.parse(readFileSync(settings, "utf8")).statusLine.command, "cat");
    writeFileSync(stateFile, JSON.stringify(pending));
    assert.equal(spawnSync("node", args).status, 0);
    const installed = JSON.parse(readFileSync(settings, "utf8"));
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(installed.statusLine.command, state.installedCommand);
    assert.notEqual(state.installedCommand, pending.installedCommand);
    assert.equal(spawnSync("node", [...args, "--uninstall"]).status, 0);
    assert.equal(JSON.parse(readFileSync(settings, "utf8")).statusLine.command, "cat");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
