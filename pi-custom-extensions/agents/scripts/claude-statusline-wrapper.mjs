#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function capture(input, directory) {
  const data = JSON.parse(input.toString("utf8"));
  if (!data || typeof data.session_id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(data.session_id)) return;
  if (typeof data.model?.id === "string" && data.model.id.trim() && data.model.id.length <= 512) {
    const record = {
      version: 1,
      sessionId: data.session_id,
      updatedAt: Date.now(),
      model: data.model.id,
      ...(typeof data.model.display_name === "string" && data.model.display_name.length <= 256
        ? { displayName: data.model.display_name } : {}),
    };
    try { atomicRecord(directory, data.session_id, record); } catch { /* Endpoint capture can still succeed. */ }
  }
  const socketPath = process.env.CLAUDE_CODE_MESSAGING_SOCKET;
  if (socketPath && socketPath.startsWith("/") && socketPath.length <= 4096 && !/[\x00-\x1f\x7f]/.test(socketPath)) {
    try {
      privateDirectory(directory);
      atomicRecord(join(directory, "endpoints"), data.session_id, {
        version: 1, sessionId: data.session_id, capturedAt: Date.now(), socketPath,
      });
    } catch { /* Metadata must never affect rendering. */ }
  }
}

function privateDirectory(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
}

function atomicRecord(directory, sessionId, record) {
  privateDirectory(directory);
  const temporary = join(directory, `.${sessionId}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, JSON.stringify(record), { mode: 0o600, flag: "wx" });
    renameSync(temporary, join(directory, `${sessionId}.json`));
  } finally {
    rmSync(temporary, { force: true });
  }
}

const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== "--registry" || args[2] !== "--command") {
  console.error("Usage: claude-statusline-wrapper.mjs --registry <directory> --command <existing shell command>");
  process.exit(2);
}
const [, directory, , command] = args;
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const input = Buffer.concat(chunks);
try { capture(input, directory); } catch { /* Metadata must never break the renderer. */ }

const child = spawn("/bin/bash", ["-c", command], { stdio: ["pipe", "inherit", "inherit"], detached: true });
child.stdin.on("error", () => {}); // A renderer may intentionally exit without consuming stdin.
child.stdin.end(input);
const signals = new Map();
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  const forward = () => {
    if (child.pid) {
      try { process.kill(-child.pid, signal); } catch { /* Renderer may have already exited. */ }
    }
  };
  signals.set(signal, forward);
  process.on(signal, forward);
}
child.on("error", (error) => {
  console.error(`Status-line renderer failed to start: ${error.message}`);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  for (const [name, handler] of signals) process.removeListener(name, handler);
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
