/**
 * SSH Remote Execution
 *
 * Delegates read/write/edit/bash to a remote machine via SSH, in one of
 * two modes:
 *
 * 1. CLI override (`pi -e ./ssh.ts -e ./stylish-tools.ts --ssh user@host`):
 *    resolved once at session_start. Redirects the *base* read/write/edit/
 *    bash tools (owned by stylish-tools.ts) to the remote host via
 *    stylish-tools.ts's operations-override registry — no local tool is
 *    registered under these names by this extension, so there's no
 *    "first registration wins" collision between the two files. `!`
 *    bash commands and the system prompt's cwd note follow the remote too.
 *
 * 2. Interactive session (`/ssh user@host` while pi is running): registers
 *    (at load time, always) four *additional* tools — read_remote,
 *    write_remote, edit_remote, bash_remote — styled identically to
 *    stylish-tools.ts's own tools via its exported factories, but kept out
 *    of the active tool set until /ssh is actually run. Local read/write/
 *    edit/bash keep working normally alongside them. `/ssh off` (or bare
 *    `/ssh`) disconnects and deactivates the _remote tools again.
 *    `/ssh` a second time with a new host repoints the existing tools.
 *
 * The two modes are mutually exclusive: if --ssh was passed on the CLI,
 * the /ssh command is a no-op (notifies and returns) since override mode
 * already covers the whole session.
 *
 * Tool-set compatibility: tool-set/index.ts is the single owner of
 * `pi.setActiveTools()` (see its header comment) — it tracks its own
 * `selection` state, which is what the /tools picker reads. Calling
 * `pi.setActiveTools()` directly here would desync from that selection: the
 * tool would actually be callable but still show "disabled" in /tools, and
 * the next mode/selection change would silently drop it again. So
 * activating/deactivating read_remote/write_remote/edit_remote/bash_remote
 * goes through `getToolSet().setSelection()` instead, and a `onChange`
 * listener keeps them out of the *default* (disconnected) selection
 * regardless of extension load order — see below. write_remote/edit_remote/
 * bash_remote are also registered as blocked via toolSet.addBlockedTools()
 * so SAFE mode blocks them the same way it blocks local write/edit/bash.
 *
 * Everything above must go through getToolSet(), never a direct import of
 * tool-set's internal state: pi loads each extension file through its own
 * independent jiti import graph (moduleCache: false), so a plain module-
 * level import of "./tool-set/state.ts" from here would get a *different*
 * copy of that module than the one tool-set/index.ts's factory actually
 * uses — mutating its exports here would silently do nothing. getToolSet()
 * works around this via a globalThis-keyed singleton; see its definition.
 *
 * Requirements:
 *   - SSH key-based auth (no password prompts)
 *   - bash on remote
 *
 * Usage:
 *   pi -e ./stylish-tools.ts -e ./tool-set/index.ts -e ./ssh.ts --ssh user@host
 *   pi -e ./stylish-tools.ts -e ./tool-set/index.ts -e ./ssh.ts --ssh user@host:/remote/path
 *   /ssh user@host[:/remote/path]   (inside a running session)
 *   /ssh off                        (disconnect the session-mode tools)
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  type BashOperations,
  type EditOperations,
  type ReadOperations,
  type WriteOperations,
} from "@earendil-works/pi-coding-agent";
import {
  clearOperationsOverride,
  createStylishBashTool,
  createStylishEditTool,
  createStylishReadTool,
  createStylishWriteTool,
  setOperationsOverride,
} from "./stylish-tools.ts";
import { getToolSet } from "./tool-set/index.ts";

const REMOTE_TOOL_NAMES = ["read_remote", "write_remote", "edit_remote", "bash_remote"];
const SAFE_BLOCKED_REMOTE_TOOL_NAMES = ["write_remote", "edit_remote", "bash_remote"];
const REMOTE_DESCRIPTION = "Executes on the SSH remote host connected via the /ssh command, not the local machine.";

function sshExec(remote: string, command: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", [remote, command], { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    child.stdout.on("data", (data) => chunks.push(data));
    child.stderr.on("data", (data) => errChunks.push(data));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`SSH failed (${code}): ${Buffer.concat(errChunks).toString()}`));
      } else {
        resolve(Buffer.concat(chunks));
      }
    });
  });
}

interface SshTarget {
  remote: string;
  remoteCwd: string;
}

async function resolveSshArg(arg: string): Promise<SshTarget> {
  const idx = arg.indexOf(":");
  if (idx === -1) {
    const remote = arg;
    const pwd = (await sshExec(remote, "pwd")).toString().trim();
    return { remote, remoteCwd: pwd };
  }
  return { remote: arg.slice(0, idx), remoteCwd: arg.slice(idx + 1) };
}

/** `Host` aliases from ~/.ssh/config, for /ssh argument hints. Wildcards excluded. */
function listSshConfigHosts(): string[] {
  try {
    const raw = readFileSync(join(homedir(), ".ssh", "config"), "utf8");
    const hosts = new Set<string>();
    for (const line of raw.split("\n")) {
      const match = line.match(/^\s*Host\s+(.+)$/i);
      if (!match) continue;
      for (const host of match[1].trim().split(/\s+/)) {
        if (host && !host.includes("*") && !host.includes("?")) hosts.add(host);
      }
    }
    return [...hosts];
  } catch {
    return [];
  }
}

function createRemoteReadOps(remote: string, remoteCwd: string, localCwd: string): ReadOperations {
  const toRemote = (p: string) => p.replace(localCwd, remoteCwd);
  return {
    readFile: (p) => sshExec(remote, `cat ${JSON.stringify(toRemote(p))}`),
    access: (p) => sshExec(remote, `test -r ${JSON.stringify(toRemote(p))}`).then(() => {}),
    detectImageMimeType: async (p) => {
      try {
        const r = await sshExec(remote, `file --mime-type -b ${JSON.stringify(toRemote(p))}`);
        const m = r.toString().trim();
        return ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(m) ? m : null;
      } catch {
        return null;
      }
    },
  };
}

function createRemoteWriteOps(remote: string, remoteCwd: string, localCwd: string): WriteOperations {
  const toRemote = (p: string) => p.replace(localCwd, remoteCwd);
  return {
    writeFile: async (p, content) => {
      const b64 = Buffer.from(content).toString("base64");
      await sshExec(remote, `echo ${JSON.stringify(b64)} | base64 -d > ${JSON.stringify(toRemote(p))}`);
    },
    mkdir: (dir) => sshExec(remote, `mkdir -p ${JSON.stringify(toRemote(dir))}`).then(() => {}),
  };
}

function createRemoteEditOps(remote: string, remoteCwd: string, localCwd: string): EditOperations {
  const r = createRemoteReadOps(remote, remoteCwd, localCwd);
  const w = createRemoteWriteOps(remote, remoteCwd, localCwd);
  return { readFile: r.readFile, access: r.access, writeFile: w.writeFile };
}

function createRemoteBashOps(remote: string, remoteCwd: string, localCwd: string): BashOperations {
  const toRemote = (p: string) => p.replace(localCwd, remoteCwd);
  return {
    exec: (command, cwd, { onData, signal, timeout }) =>
      new Promise((resolve, reject) => {
        const cmd = `cd ${JSON.stringify(toRemote(cwd))} && ${command}`;
        const child = spawn("ssh", [remote, cmd], { stdio: ["ignore", "pipe", "pipe"] });
        let timedOut = false;
        const timer = timeout
          ? setTimeout(() => {
              timedOut = true;
              child.kill();
            }, timeout * 1000)
          : undefined;
        child.stdout.on("data", onData);
        child.stderr.on("data", onData);
        child.on("error", (e) => {
          if (timer) clearTimeout(timer);
          reject(e);
        });
        const onAbort = () => child.kill();
        signal?.addEventListener("abort", onAbort, { once: true });
        child.on("close", (code) => {
          if (timer) clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          if (signal?.aborted) reject(new Error("aborted"));
          else if (timedOut) reject(new Error(`timeout:${timeout}`));
          else resolve({ exitCode: code });
        });
      }),
  };
}

export default function (pi: ExtensionAPI) {
  pi.registerFlag("ssh", { description: "SSH remote: user@host or user@host:/path", type: "string" });

  const localCwd = process.cwd();
  const timers = new Set<NodeJS.Timeout>();

  // CLI override mode — resolved once at session_start, redirects the base
  // read/write/edit/bash tools via stylish-tools.ts's override registry.
  let cliSsh: SshTarget | null = null;

  // Interactive session mode — mutated by /ssh, drives the _remote tools.
  let sessionSsh: SshTarget | null = null;

  pi.registerTool(
    createStylishReadTool(localCwd, timers, {
      name: "read_remote",
      extraDescription: REMOTE_DESCRIPTION,
      getOperations: () => (sessionSsh ? createRemoteReadOps(sessionSsh.remote, sessionSsh.remoteCwd, localCwd) : undefined),
      getTag: () => sessionSsh?.remote,
    }),
  );
  pi.registerTool(
    createStylishWriteTool(localCwd, timers, {
      name: "write_remote",
      extraDescription: REMOTE_DESCRIPTION,
      getOperations: () => (sessionSsh ? createRemoteWriteOps(sessionSsh.remote, sessionSsh.remoteCwd, localCwd) : undefined),
      getTag: () => sessionSsh?.remote,
    }),
  );
  pi.registerTool(
    createStylishEditTool(localCwd, timers, {
      name: "edit_remote",
      extraDescription: REMOTE_DESCRIPTION,
      getOperations: () => (sessionSsh ? createRemoteEditOps(sessionSsh.remote, sessionSsh.remoteCwd, localCwd) : undefined),
      getTag: () => sessionSsh?.remote,
    }),
  );
  pi.registerTool(
    createStylishBashTool(localCwd, timers, {
      name: "bash_remote",
      extraDescription: REMOTE_DESCRIPTION,
      getOperations: () => (sessionSsh ? createRemoteBashOps(sessionSsh.remote, sessionSsh.remoteCwd, localCwd) : undefined),
      getTag: () => sessionSsh?.remote,
    }),
  );

  function activateRemoteTools(ctx: { ui: { setStatus(key: string, text: string | undefined): void } }) {
    const toolSet = getToolSet();
    const selection = new Set(toolSet.getSelection());
    for (const name of REMOTE_TOOL_NAMES) selection.add(name);
    toolSet.setSelection([...selection]);
    ctx.ui.setStatus("ssh", `SSH session: ${sessionSsh!.remote}:${sessionSsh!.remoteCwd}`);
  }

  function deactivateRemoteTools(ctx: { ui: { setStatus(key: string, text: string | undefined): void } }) {
    const toolSet = getToolSet();
    toolSet.setSelection(toolSet.getSelection().filter((n) => !REMOTE_TOOL_NAMES.includes(n)));
    ctx.ui.setStatus("ssh", undefined);
  }

  // _remote tools are opt-in via /ssh; keep them out of the *default*
  // (disconnected) selection. Only touched here, never elsewhere, so it's
  // safe to call unconditionally.
  function stripRemoteFromDefaultSelection() {
    if (sessionSsh) return; // connected — selection is intentional, leave it
    const toolSet = getToolSet();
    const selection = toolSet.getSelection();
    if (REMOTE_TOOL_NAMES.some((n) => selection.includes(n))) {
      toolSet.setSelection(selection.filter((n) => !REMOTE_TOOL_NAMES.includes(n)));
    }
  }

  // getToolSet() only works once tool-set/index.ts's factory has run, which
  // isn't guaranteed relative to this factory (extension load order across
  // files isn't something either extension controls). session_start always
  // fires after every extension has finished loading, so that's the first
  // safe place to touch it — never call getToolSet() directly in this
  // factory body.
  let toolSetIntegrated = false;

  pi.on("session_start", async (_event, ctx) => {
    if (!toolSetIntegrated) {
      toolSetIntegrated = true;
      getToolSet().addBlockedTools(SAFE_BLOCKED_REMOTE_TOOL_NAMES);
      // Catches up in case tool-set's own session_start (which may run
      // before or after this one) already adopted/restored a selection
      // that happens to include the _remote names.
      stripRemoteFromDefaultSelection();
      getToolSet().onChange(stripRemoteFromDefaultSelection);
    }

    const arg = pi.getFlag("ssh") as string | undefined;
    if (!arg) return;

    cliSsh = await resolveSshArg(arg);
    setOperationsOverride({
      read: createRemoteReadOps(cliSsh.remote, cliSsh.remoteCwd, localCwd),
      write: createRemoteWriteOps(cliSsh.remote, cliSsh.remoteCwd, localCwd),
      edit: createRemoteEditOps(cliSsh.remote, cliSsh.remoteCwd, localCwd),
      bash: createRemoteBashOps(cliSsh.remote, cliSsh.remoteCwd, localCwd),
      tag: cliSsh.remote,
    });
    ctx.ui.setStatus("ssh", ctx.ui.theme.fg("accent", `SSH: ${cliSsh.remote}:${cliSsh.remoteCwd}`));
    ctx.ui.notify(`SSH override mode: ${cliSsh.remote}:${cliSsh.remoteCwd} (read/write/edit/bash run remotely)`, "info");
  });

  pi.registerCommand("ssh", {
    description: "user@host[:/path] to connect read_remote/write_remote/edit_remote/bash_remote, or 'off' to disconnect",
    getArgumentCompletions: (prefix) => {
      if (cliSsh) return null; // --ssh already covers the whole session; command is a no-op

      const items: { value: string; label: string; description?: string }[] = [];
      if (sessionSsh) {
        items.push({
          value: "off",
          label: "off",
          description: `disconnect (currently ${sessionSsh.remote}:${sessionSsh.remoteCwd})`,
        });
      }
      for (const host of listSshConfigHosts()) {
        items.push({ value: host, label: host, description: "from ~/.ssh/config" });
      }

      const filtered = items.filter((i) => i.value.startsWith(prefix));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args, ctx) => {
      if (cliSsh) {
        ctx.ui.notify(
          `SSH is already active via --ssh (${cliSsh.remote}); the /ssh command has no effect this session.`,
          "warning",
        );
        return;
      }

      const trimmed = args.trim();
      if (trimmed === "" || trimmed === "off") {
        if (!sessionSsh) {
          ctx.ui.notify("SSH is not active.", "info");
          return;
        }
        sessionSsh = null;
        deactivateRemoteTools(ctx);
        ctx.ui.notify("SSH disconnected.", "info");
        return;
      }

      try {
        sessionSsh = await resolveSshArg(trimmed);
      } catch (e) {
        ctx.ui.notify(`SSH connection failed: ${e instanceof Error ? e.message : String(e)}`, "error");
        return;
      }
      activateRemoteTools(ctx);
      ctx.ui.notify(
        `SSH session tools active: ${sessionSsh.remote}:${sessionSsh.remoteCwd} (read_remote/write_remote/edit_remote/bash_remote)`,
        "info",
      );
    },
  });

  // Handle user ! commands via SSH — only in CLI override mode, since in
  // session mode local bash remains the default and bash_remote is opt-in.
  pi.on("user_bash", (_event) => {
    if (!cliSsh) return;
    return { operations: createRemoteBashOps(cliSsh.remote, cliSsh.remoteCwd, localCwd) };
  });

  // Replace local cwd with remote cwd in system prompt — CLI override mode only.
  pi.on("before_agent_start", async (event) => {
    if (!cliSsh) return;
    const modified = event.systemPrompt.replace(
      `Current working directory: ${localCwd}`,
      `Current working directory: ${cliSsh.remoteCwd} (via SSH: ${cliSsh.remote})`,
    );
    return { systemPrompt: modified };
  });

  pi.on("session_shutdown", async () => {
    for (const timer of timers) clearInterval(timer);
    timers.clear();
    if (cliSsh) clearOperationsOverride();
  });
}
