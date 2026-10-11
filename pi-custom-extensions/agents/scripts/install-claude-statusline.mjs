#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const expand = (path) => path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
const quote = (text) => `'${text.replace(/'/g, "'\\''")}'`;
function atomicWrite(path, data, mode = 0o600) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(data, null, 2) + "\n", { mode, flag: "wx" });
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
}

try {
  let settings = join(expand(process.env.CLAUDE_CONFIG_DIR || "~/.claude"), "settings.json");
  let agentDir = expand(process.env.PI_CODING_AGENT_DIR || "~/.pi/agent");
  let uninstall = false;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--uninstall") uninstall = true;
    else if (args[i] === "--settings" && args[i + 1]) settings = expand(args[++i]);
    else if (args[i] === "--agent-dir" && args[i + 1]) agentDir = expand(args[++i]);
    else throw new Error("Usage: install-claude-statusline.mjs [--settings <file>] [--agent-dir <directory>] [--uninstall]");
  }
  settings = resolve(settings);
  if (lstatSync(settings).isSymbolicLink()) throw new Error("Settings is a symlink. Install against its source file instead.");
  const originalText = readFileSync(settings, "utf8");
  const config = JSON.parse(originalText);
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("Settings must be a JSON object.");
  const stateFile = `${settings}.agents-statusline-backup.json`;
  let state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : undefined;
  if (state && (state.version !== 1 || typeof state.installedCommand !== "string" ||
    typeof state.originalStatusLine?.command !== "string")) throw new Error("Invalid installation backup; refusing to modify settings.");

  // A crash or failed write can leave saved state before the command was installed.
  if (state && config.statusLine?.command === state.originalStatusLine.command) {
    rmSync(stateFile);
    state = undefined;
  }
  let createdState = false;
  if (uninstall) {
    if (!state) {
      console.log("Claude status-line wrapper is not installed.");
      process.exit(0);
    }
    if (config.statusLine?.command !== state.installedCommand) {
      throw new Error("Status-line command changed since installation; refusing to overwrite it. Backup: " + stateFile);
    }
    // Restore only the command, preserving unrelated settings and any later status-line options.
    config.statusLine.command = state.originalStatusLine.command;
  } else {
    if (state && config.statusLine?.command === state.installedCommand) {
      console.log("Claude status-line wrapper already installed.");
      process.exit(0);
    }
    if (state) throw new Error("An installation backup already exists but the command changed. Review " + stateFile);
    if (config.statusLine?.type !== "command" || typeof config.statusLine.command !== "string" || !config.statusLine.command.trim()) {
      throw new Error("Configure an existing command-based status line first; this installer preserves its renderer.");
    }
    const wrapper = join(dirname(fileURLToPath(import.meta.url)), "claude-statusline-wrapper.mjs");
    const directory = join(resolve(agentDir), "agents-live", "claude");
    const installedCommand = `node ${quote(wrapper)} --registry ${quote(directory)} --command ${quote(config.statusLine.command)}`;
    const backup = `${settings}.pre-agents-statusline.${Date.now()}`;
    copyFileSync(settings, backup);
    atomicWrite(stateFile, { version: 1, originalStatusLine: config.statusLine, installedCommand });
    createdState = true;
    config.statusLine = { ...config.statusLine, command: installedCommand };
    console.log(`Backed up settings: ${backup}`);
  }
  try {
    if (readFileSync(settings, "utf8") !== originalText) throw new Error("Settings changed during installation; refusing to overwrite them.");
    atomicWrite(settings, config, statSync(settings).mode & 0o777);
  } catch (error) {
    // Keep recovery state if another writer changed settings; otherwise undo our pending state.
    if (createdState) {
      try {
        if (readFileSync(settings, "utf8") === originalText) rmSync(stateFile);
      } catch { /* Retain the backup when settings cannot be checked safely. */ }
    }
    throw error;
  }
  if (uninstall) rmSync(stateFile);
  console.log(`${uninstall ? "Removed" : "Installed"} Claude status-line wrapper: ${settings}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
