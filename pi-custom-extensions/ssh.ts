/**
 * SSH Remote Execution
 *
 * Delegates read/write/edit/bash/grep/ls/find to a remote machine via SSH,
 * in one of two modes:
 *
 * 1. CLI override (`pi -e ./ssh.ts -e ./stylish-tools.ts --ssh user@host`):
 *    resolved once at session_start. Redirects the *base* read/write/edit/
 *    bash/grep/ls/find tools (owned by stylish-tools.ts) to the remote host
 *    via stylish-tools.ts's operations-override registry — no local tool is
 *    registered under these names by this extension, so there's no
 *    "first registration wins" collision between the two files. `!`
 *    bash commands and the system prompt's cwd note follow the remote too.
 *
 * 2. Interactive session (`/ssh user@host` while pi is running): registers
 *    (at load time, always) seven *additional* tools — read_remote,
 *    write_remote, edit_remote, bash_remote, grep_remote, ls_remote,
 *    find_remote — styled identically to stylish-tools.ts's own tools via
 *    its exported factories, but kept out of the active tool set until
 *    /ssh is actually run. Local tools keep working normally alongside
 *    them. `/ssh off` (or bare `/ssh`) disconnects and deactivates the
 *    _remote tools again. `/ssh` a second time with a new host repoints
 *    the existing tools.
 *
 * The two modes are mutually exclusive: if --ssh was passed on the CLI,
 * the /ssh command is a no-op (notifies and returns) since override mode
 * already covers the whole session.
 *
 * Tool-set compatibility: tool-set/index.ts is the single owner of
 * `pi.setActiveTools()` (see its header comment) — it tracks its own
 * `selection` state, which is what the /tools viewer reads. Calling
 * `pi.setActiveTools()` directly here would desync from that selection: the
 * tool would actually be callable but still show "disabled" in /tools, and
 * the next mode/selection change would silently drop it again. So
 * activating/deactivating the _remote tools goes through
 * `getToolSet().setSelection()` instead, and a `onChange` listener keeps
 * them out of the *default* (disconnected) selection regardless of
 * extension load order — see below.
 *
 * The _remote tools split into three groups (mirroring how tool-set treats
 * their local counterparts, see state.ts) — see ALWAYS_REMOTE_TOOL_NAMES /
 * SAFE_BLOCKED_REMOTE_TOOL_NAMES / SAFE_ONLY_REMOTE_TOOL_NAMES below:
 *   - read_remote: always selectable once connected, like read.
 *   - write_remote/edit_remote/bash_remote: blocked by SAFE mode via
 *     toolSet.addBlockedTools(), like write/edit/bash.
 *   - grep_remote/ls_remote/find_remote: only surfaced while SAFE *and*
 *     connected, like grep/ls/find (redundant with bash_remote in YOLO) —
 *     synced reactively by syncSafeOnlyRemoteTools(), since tool-set's
 *     generic SAFE_EXTRA_TOOLS mechanism has no notion of "connected" and
 *     would otherwise surface them in SAFE mode even while disconnected.
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

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import {
  type BashOperations,
  type EditOperations,
  type FindOperations,
  type GrepOperations,
  type LsOperations,
  type ReadOperations,
  type WriteOperations,
} from "@earendil-works/pi-coding-agent";
import {
  clearOperationsOverride,
  createStylishBashTool,
  createStylishEditTool,
  createStylishFindTool,
  createStylishGrepTool,
  createStylishLsTool,
  createStylishReadTool,
  createStylishWriteTool,
  setOperationsOverride,
} from "./stylish-tools.ts";
import { getToolSet } from "./tool-set/index.ts";
import { globToRegExp, parseSshTarget, shq, SshConnection } from "./shared/ssh-transport.ts";

// read_remote behaves like read: always selectable once connected, in
// either mode.
const ALWAYS_REMOTE_TOOL_NAMES = ["read_remote"];
// write_remote/edit_remote/bash_remote behave like write/edit/bash: blocked
// by SAFE mode (see toolSet.addBlockedTools() below), otherwise selectable.
const SAFE_BLOCKED_REMOTE_TOOL_NAMES = ["write_remote", "edit_remote", "bash_remote"];
// grep_remote/ls_remote/find_remote behave like local grep/ls/find: redundant
// with bash_remote in YOLO, so only surfaced while SAFE *and* connected.
// Unlike tool-set's generic SAFE_EXTRA_TOOLS mechanism (which would activate
// them in SAFE mode even while disconnected, since it only checks that a
// tool is registered — not that there's a live SSH session), membership
// here is synced reactively by syncSafeOnlyRemoteTools() below, gated on
// sessionSsh actually being set.
const SAFE_ONLY_REMOTE_TOOL_NAMES = ["grep_remote", "ls_remote", "find_remote"];
const REMOTE_TOOL_NAMES = [
  ...ALWAYS_REMOTE_TOOL_NAMES,
  ...SAFE_BLOCKED_REMOTE_TOOL_NAMES,
  ...SAFE_ONLY_REMOTE_TOOL_NAMES,
];
const REMOTE_DESCRIPTIONS = {
  read: "Read a file on the SSH remote host connected via /ssh, not the local machine.",
  write: "Write a file on the SSH remote host connected via /ssh, not the local machine.",
  edit: "Edit a file on the SSH remote host connected via /ssh, not the local machine.",
  bash: "Execute a shell command on the SSH remote host connected via /ssh, not the local machine.",
  grep: "Search file contents on the SSH remote host connected via /ssh, not the local machine.",
  ls: "List a directory on the SSH remote host connected via /ssh, not the local machine.",
  find: "Find files on the SSH remote host connected via /ssh, not the local machine.",
} as const;
const NOT_CONNECTED_ERROR = "Not connected. Ask the user to run /ssh user@host first.";

/** Footer badge for the "ssh" status key; status-line.ts places it on the cwd line. */
function sshStatusText(theme: Theme, label: string, target: Pick<SshConnection, "remote" | "remoteCwd">): string {
  return (
    theme.fg("warning", theme.bold(`⇄ ${label}`)) +
    theme.fg("dim", " ") +
    theme.fg("accent", target.remote) +
    theme.fg("dim", ":") +
    theme.fg("success", target.remoteCwd)
  );
}

/** Opens a connection. Without an explicit path, the remote cwd is the login directory. */
async function connectSsh(arg: string): Promise<SshConnection> {
  const { remote, remoteCwd } = parseSshTarget(arg);
  if (remoteCwd !== undefined) return new SshConnection(remote, remoteCwd);
  const home = (await new SshConnection(remote, "").exec("pwd")).toString().trim();
  return new SshConnection(remote, home);
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

function createRemoteReadOps(conn: SshConnection, localCwd: string): ReadOperations {
  const toRemote = (p: string) => p.replace(localCwd, conn.remoteCwd);
  return {
    readFile: (p) => conn.exec(`cat ${JSON.stringify(toRemote(p))}`),
    access: (p) => conn.exec(`test -r ${JSON.stringify(toRemote(p))}`).then(() => {}),
    detectImageMimeType: async (p) => {
      try {
        const r = await conn.exec(`file --mime-type -b ${JSON.stringify(toRemote(p))}`);
        const m = r.toString().trim();
        return ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(m) ? m : null;
      } catch {
        return null;
      }
    },
  };
}

function createRemoteWriteOps(conn: SshConnection, localCwd: string): WriteOperations {
  const toRemote = (p: string) => p.replace(localCwd, conn.remoteCwd);
  return {
    writeFile: async (p, content) => {
      const b64 = Buffer.from(content).toString("base64");
      await conn.exec(`echo ${JSON.stringify(b64)} | base64 -d > ${JSON.stringify(toRemote(p))}`);
    },
    mkdir: (dir) => conn.exec(`mkdir -p ${JSON.stringify(toRemote(dir))}`).then(() => {}),
  };
}

function createRemoteEditOps(conn: SshConnection, localCwd: string): EditOperations {
  const r = createRemoteReadOps(conn, localCwd);
  const w = createRemoteWriteOps(conn, localCwd);
  return { readFile: r.readFile, access: r.access, writeFile: w.writeFile };
}

function createRemoteBashOps(conn: SshConnection, localCwd: string): BashOperations {
  const toRemote = (p: string) => p.replace(localCwd, conn.remoteCwd);
  return {
    exec: async (command, cwd, { onData, signal, timeout }) => {
      const result = await conn.run(`cd ${shq(toRemote(cwd))} && ${command}`, {
        onData,
        signal,
        timeoutMs: timeout ? timeout * 1000 : undefined,
      });
      return { exitCode: result.code };
    },
  };
}

/** "MISSING" | "DIR" | "FILE" for a remote path, shared by grep/ls's isDirectory/stat. */
async function remoteStatKind(conn: SshConnection, absolutePath: string): Promise<"MISSING" | "DIR" | "FILE"> {
  const quoted = JSON.stringify(absolutePath);
  const out = await conn.exec(`if [ ! -e ${quoted} ]; then echo MISSING; elif [ -d ${quoted} ]; then echo DIR; else echo FILE; fi`,
  );
  return out.toString().trim() as "MISSING" | "DIR" | "FILE";
}

function createRemoteGrepOps(conn: SshConnection, localCwd: string): GrepOperations {
  const toRemote = (p: string) => p.replace(localCwd, conn.remoteCwd);
  return {
    isDirectory: async (p) => {
      const kind = await remoteStatKind(conn, toRemote(p));
      if (kind === "MISSING") throw new Error(`No such file or directory: ${p}`);
      return kind === "DIR";
    },
    readFile: async (p) => (await conn.exec(`cat ${JSON.stringify(toRemote(p))}`)).toString(),
  };
}

function createRemoteLsOps(conn: SshConnection, localCwd: string): LsOperations {
  const toRemote = (p: string) => p.replace(localCwd, conn.remoteCwd);
  return {
    exists: async (p) => (await remoteStatKind(conn, toRemote(p))) !== "MISSING",
    stat: async (p) => {
      const kind = await remoteStatKind(conn, toRemote(p));
      if (kind === "MISSING") throw new Error(`No such file or directory: ${p}`);
      return { isDirectory: () => kind === "DIR" };
    },
    readdir: async (p) => {
      const out = await conn.exec(`ls -A ${JSON.stringify(toRemote(p))}`);
      return out.toString().split("\n").filter(Boolean);
    },
  };
}

/**
 * Best-effort remote find: lists all files under the search root over SSH
 * and glob-matches them locally. Unlike the local find tool (fd-backed),
 * this does not respect .gitignore — the remote host may not have fd/rg
 * available, and shelling out per-.gitignore-rule isn't worth it here.
 */
function createRemoteFindOps(conn: SshConnection, localCwd: string): FindOperations {
  const toRemote = (p: string) => p.replace(localCwd, conn.remoteCwd);
  return {
    exists: async (p) => (await remoteStatKind(conn, toRemote(p))) !== "MISSING",
    glob: async (pattern, cwd, { ignore, limit }) => {
      const remoteSearchCwd = toRemote(cwd);
      const prune = ignore.map((name) => `-name ${JSON.stringify(name)} -prune -o`).join(" ");
      const out = await conn.exec(`find ${JSON.stringify(remoteSearchCwd)} ${prune} -type f -print 2>/dev/null`,
      );
      const re = globToRegExp(pattern);
      const matches: string[] = [];
      for (const line of out.toString().split("\n")) {
        if (!line) continue;
        const rel = line.startsWith(remoteSearchCwd) ? line.slice(remoteSearchCwd.length + 1) : line;
        if (re.test(rel)) matches.push(rel);
        if (matches.length >= limit) break;
      }
      return matches;
    },
  };
}

export default function (pi: ExtensionAPI) {
  pi.registerFlag("ssh", { description: "SSH remote: user@host or user@host:/path", type: "string" });

  const localCwd = process.cwd();
  const timers = new Set<NodeJS.Timeout>();

  // CLI override mode — resolved once at session_start, redirects the base
  // read/write/edit/bash tools via stylish-tools.ts's override registry.
  let cliSsh: SshConnection | null = null;

  // Interactive session mode — mutated by /ssh, drives the _remote tools.
  let sessionSsh: SshConnection | null = null;

  pi.registerTool(
    createStylishReadTool(localCwd, timers, {
      name: "read_remote",
      extraDescription: REMOTE_DESCRIPTIONS.read,
      getOperations: () => (sessionSsh ? createRemoteReadOps(sessionSsh, localCwd) : undefined),
      getTag: () => sessionSsh?.remote,
      requireOperationsError: NOT_CONNECTED_ERROR,
    }),
  );
  pi.registerTool(
    createStylishWriteTool(localCwd, timers, {
      name: "write_remote",
      extraDescription: REMOTE_DESCRIPTIONS.write,
      getOperations: () => (sessionSsh ? createRemoteWriteOps(sessionSsh, localCwd) : undefined),
      getTag: () => sessionSsh?.remote,
      requireOperationsError: NOT_CONNECTED_ERROR,
    }),
  );
  pi.registerTool(
    createStylishEditTool(localCwd, timers, {
      name: "edit_remote",
      extraDescription: REMOTE_DESCRIPTIONS.edit,
      getOperations: () => (sessionSsh ? createRemoteEditOps(sessionSsh, localCwd) : undefined),
      getTag: () => sessionSsh?.remote,
      requireOperationsError: NOT_CONNECTED_ERROR,
    }),
  );
  pi.registerTool(
    createStylishBashTool(localCwd, timers, {
      name: "bash_remote",
      extraDescription: REMOTE_DESCRIPTIONS.bash,
      promptSnippet: "Execute bash commands on the SSH remote host connected via /ssh (not the local machine)",
      getOperations: () => (sessionSsh ? createRemoteBashOps(sessionSsh, localCwd) : undefined),
      getTag: () => sessionSsh?.remote,
      requireOperationsError: NOT_CONNECTED_ERROR,
    }),
  );
  pi.registerTool(
    createStylishGrepTool(localCwd, timers, {
      name: "grep_remote",
      extraDescription: REMOTE_DESCRIPTIONS.grep,
      getOperations: () => (sessionSsh ? createRemoteGrepOps(sessionSsh, localCwd) : undefined),
      getTag: () => sessionSsh?.remote,
      requireOperationsError: NOT_CONNECTED_ERROR,
    }),
  );
  pi.registerTool(
    createStylishLsTool(localCwd, timers, {
      name: "ls_remote",
      extraDescription: REMOTE_DESCRIPTIONS.ls,
      getOperations: () => (sessionSsh ? createRemoteLsOps(sessionSsh, localCwd) : undefined),
      getTag: () => sessionSsh?.remote,
      requireOperationsError: NOT_CONNECTED_ERROR,
    }),
  );
  pi.registerTool(
    createStylishFindTool(localCwd, timers, {
      name: "find_remote",
      extraDescription: REMOTE_DESCRIPTIONS.find,
      getOperations: () => (sessionSsh ? createRemoteFindOps(sessionSsh, localCwd) : undefined),
      getTag: () => sessionSsh?.remote,
      requireOperationsError: NOT_CONNECTED_ERROR,
    }),
  );

  type StatusUiCtx = { ui: { setStatus(key: string, text: string | undefined): void; theme: { fg(color: string, text: string): string } } };

  // mode.ts's "tools:" status line tries to keep pi's own built-ins from
  // being pushed out of the "+N" overflow by sorting on
  // tool.sourceInfo.source === "builtin" — but stylish-tools.ts re-registers
  // read/write/edit/bash/grep/ls/find as its own extension-owned tools, so
  // pi's loader stamps them source: "local" like everything else. That sort
  // no longer does anything useful, and the _remote tools (also "local",
  // also opt-in) have no reliable way to stay visible in that single
  // shared, truncated line. So: a second, dedicated status line for exactly
  // which _remote tools are active, updated whenever that could change
  // (connect/disconnect, or a SAFE/YOLO toggle blocking/unblocking some of
  // them) — see updateRemoteToolsStatus's callers below.
  let lastStatusCtx: StatusUiCtx | undefined;

  function updateRemoteToolsStatus() {
    if (!lastStatusCtx) return;
    if (!sessionSsh) {
      lastStatusCtx.ui.setStatus("ssh-remote-tools", undefined);
      return;
    }
    const active = REMOTE_TOOL_NAMES.filter((name) => pi.getActiveTools().includes(name));
    lastStatusCtx.ui.setStatus(
      "ssh-remote-tools",
      active.length > 0
        ? lastStatusCtx.ui.theme.fg("dim", "remote: ") + lastStatusCtx.ui.theme.fg("muted", active.join(", "))
        : undefined,
    );
  }

  function activateRemoteTools(ctx: StatusUiCtx) {
    const toolSet = getToolSet();
    const selection = new Set(toolSet.getSelection());
    for (const name of ALWAYS_REMOTE_TOOL_NAMES) selection.add(name);
    for (const name of SAFE_BLOCKED_REMOTE_TOOL_NAMES) selection.add(name);
    if (toolSet.getMode() === "safe") {
      for (const name of SAFE_ONLY_REMOTE_TOOL_NAMES) selection.add(name);
    }
    toolSet.setSelection([...selection]);
    ctx.ui.setStatus("ssh", sshStatusText(ctx.ui.theme as Theme, "SSH", sessionSsh!));
    lastStatusCtx = ctx;
    updateRemoteToolsStatus();
  }

  function deactivateRemoteTools(ctx: StatusUiCtx) {
    const toolSet = getToolSet();
    toolSet.setSelection(toolSet.getSelection().filter((n) => !REMOTE_TOOL_NAMES.includes(n)));
    ctx.ui.setStatus("ssh", undefined);
    lastStatusCtx = ctx;
    updateRemoteToolsStatus();
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

  // grep_remote/ls_remote/find_remote track SAFE mode while connected — added
  // to selection on entering SAFE, removed on leaving it — same as local
  // grep/ls/find track it via tool-set's SAFE_EXTRA_TOOLS/SAFE_ONLY_TOOLS, but
  // gated on sessionSsh since these three only make sense while connected.
  function syncSafeOnlyRemoteTools() {
    if (!sessionSsh) return; // stripRemoteFromDefaultSelection already covers this case
    const toolSet = getToolSet();
    const shouldBeActive = toolSet.getMode() === "safe";
    const selection = toolSet.getSelection();
    const currentlyIn = SAFE_ONLY_REMOTE_TOOL_NAMES.some((n) => selection.includes(n));
    if (shouldBeActive === currentlyIn) return;
    toolSet.setSelection(
      shouldBeActive
        ? [...new Set([...selection, ...SAFE_ONLY_REMOTE_TOOL_NAMES])]
        : selection.filter((n) => !SAFE_ONLY_REMOTE_TOOL_NAMES.includes(n)),
    );
  }

  // getToolSet() only works once tool-set/index.ts's factory has run, which
  // isn't guaranteed relative to this factory (extension load order across
  // files isn't something either extension controls). session_start always
  // fires after every extension has finished loading, so that's the first
  // safe place to touch it — never call getToolSet() directly in this
  // factory body.
  let toolSetIntegrated = false;

  pi.on("session_start", async (_event, ctx) => {
    lastStatusCtx = ctx;

    if (!toolSetIntegrated) {
      toolSetIntegrated = true;
      getToolSet().addBlockedTools(SAFE_BLOCKED_REMOTE_TOOL_NAMES);
      // Catches up in case tool-set's own session_start (which may run
      // before or after this one) already adopted/restored a selection
      // that happens to include the _remote names.
      stripRemoteFromDefaultSelection();
      getToolSet().onChange(stripRemoteFromDefaultSelection);
      // Keeps grep_remote/ls_remote/find_remote in sync with /safe /yolo
      // while connected (see syncSafeOnlyRemoteTools's own comment).
      getToolSet().onChange(syncSafeOnlyRemoteTools);
      // Repaints the remote-tools status line on any mode/selection change
      // too, not just connect/disconnect — e.g. /safe blocking write_remote/
      // edit_remote/bash_remote should drop them from the line immediately.
      getToolSet().onChange(updateRemoteToolsStatus);
    }

    const arg = pi.getFlag("ssh") as string | undefined;
    if (!arg) return;

    cliSsh = await connectSsh(arg);
    setOperationsOverride({
      read: createRemoteReadOps(cliSsh, localCwd),
      write: createRemoteWriteOps(cliSsh, localCwd),
      edit: createRemoteEditOps(cliSsh, localCwd),
      bash: createRemoteBashOps(cliSsh, localCwd),
      grep: createRemoteGrepOps(cliSsh, localCwd),
      ls: createRemoteLsOps(cliSsh, localCwd),
      find: createRemoteFindOps(cliSsh, localCwd),
      tag: cliSsh.remote,
    });
    ctx.ui.setStatus("ssh", sshStatusText(ctx.ui.theme as Theme, "SSH", cliSsh));
    ctx.ui.notify(
      `SSH override mode: ${cliSsh.remote}:${cliSsh.remoteCwd} (read/write/edit/bash/grep/ls/find run remotely)`,
      "info",
    );
  });

  pi.registerCommand("ssh", {
    description: "user@host[:/path] to connect the _remote tools (read/write/edit/bash/grep/ls/find), or 'off' to disconnect",
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
        const previous = sessionSsh;
        sessionSsh = null;
        deactivateRemoteTools(ctx);
        await previous.close();
        ctx.ui.notify("SSH disconnected.", "info");
        return;
      }

      let next: SshConnection;
      try {
        next = await connectSsh(trimmed);
      } catch (e) {
        ctx.ui.notify(`SSH connection failed: ${e instanceof Error ? e.message : String(e)}`, "error");
        return;
      }
      const previous = sessionSsh;
      sessionSsh = next;
      await previous?.close();
      activateRemoteTools(ctx);
      const active = REMOTE_TOOL_NAMES.filter((name) => pi.getActiveTools().includes(name));
      const safeOnlyNote =
        getToolSet().getMode() === "safe" ? "" : ` — ${SAFE_ONLY_REMOTE_TOOL_NAMES.join("/")} activate in SAFE mode`;
      ctx.ui.notify(
        `SSH session tools active: ${sessionSsh.remote}:${sessionSsh.remoteCwd} (${active.join("/")})${safeOnlyNote}`,
        "info",
      );
    },
  });

  // Handle user ! commands via SSH — only in CLI override mode, since in
  // session mode local bash remains the default and bash_remote is opt-in.
  pi.on("user_bash", (_event) => {
    if (!cliSsh) return;
    return { operations: createRemoteBashOps(cliSsh, localCwd) };
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
    await Promise.all([cliSsh?.close(), sessionSsh?.close()]);
    cliSsh = null;
    sessionSsh = null;
  });
}
