import { SSH_STATUS_KEY, SSH_REMOTE_TOOLS_STATUS_KEY } from "../contracts/status-keys.ts";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import {
  createStylishBashTool,
  createStylishEditTool,
  createStylishFindTool,
  createStylishGrepTool,
  createStylishLsTool,
  createStylishReadTool,
  createStylishWriteTool,
} from "../stylish-tools/factories.ts";
import { clearOperationsOverride, setOperationsOverride } from "../stylish-tools/overrides.ts";
import { getRequiredToolSet } from "../tool-set/service.ts";
import { connectSsh, listSshConfigHosts } from "./connection.ts";
import {
  createRemoteBashOps,
  createRemoteEditOps,
  createRemoteFindOps,
  createRemoteGrepOps,
  createRemoteLsOps,
  createRemoteReadOps,
  createRemoteWriteOps,
} from "./operations.ts";
import { integrateRemoteTools, REMOTE_TOOL_NAMES, SAFE_ONLY_REMOTE_TOOL_NAMES } from "./tool-set-integration.ts";
import { SshConnection } from "./transport.ts";

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

export default function (pi: ExtensionAPI) {
  pi.registerFlag("ssh", { description: "SSH remote: user@host or user@host:/path", type: "string" });

  const localCwd = process.cwd();
  const timers = new Set<NodeJS.Timeout>();

  // CLI override mode — resolved once at session_start, redirects the base
  // read/write/edit/bash tools via stylish-tools/overrides.ts.
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
  // tool.sourceInfo.source === "builtin" — but stylish-tools/index.ts re-registers
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
      lastStatusCtx.ui.setStatus(SSH_REMOTE_TOOLS_STATUS_KEY, undefined);
      return;
    }
    const active = REMOTE_TOOL_NAMES.filter((name) => pi.getActiveTools().includes(name));
    lastStatusCtx.ui.setStatus(
      SSH_REMOTE_TOOLS_STATUS_KEY,
      active.length > 0
        ? lastStatusCtx.ui.theme.fg("dim", "remote: ") + lastStatusCtx.ui.theme.fg("muted", active.join(", "))
        : undefined,
    );
  }

  function activateRemoteTools(ctx: StatusUiCtx) {
    remoteTools!.activate();
    ctx.ui.setStatus(SSH_STATUS_KEY, sshStatusText(ctx.ui.theme as Theme, "SSH", sessionSsh!));
    lastStatusCtx = ctx;
    updateRemoteToolsStatus();
  }

  function deactivateRemoteTools(ctx: StatusUiCtx) {
    remoteTools!.deactivate();
    ctx.ui.setStatus(SSH_STATUS_KEY, undefined);
    lastStatusCtx = ctx;
    updateRemoteToolsStatus();
  }

  let remoteTools: ReturnType<typeof integrateRemoteTools> | undefined;

  pi.on("session_start", async (_event, ctx) => {
    lastStatusCtx = ctx;

    if (!remoteTools) {
      remoteTools = integrateRemoteTools(getRequiredToolSet(), () => sessionSsh !== null, updateRemoteToolsStatus);
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
    ctx.ui.setStatus(SSH_STATUS_KEY, sshStatusText(ctx.ui.theme as Theme, "SSH", cliSsh));
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
        getRequiredToolSet().getMode() === "safe" ? "" : ` — ${SAFE_ONLY_REMOTE_TOOL_NAMES.join("/")} activate in SAFE mode`;
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
    remoteTools?.dispose();
    remoteTools = undefined;
    lastStatusCtx = undefined;
    for (const timer of timers) clearInterval(timer);
    timers.clear();
    if (cliSsh) clearOperationsOverride();
    await Promise.all([cliSsh?.close(), sessionSsh?.close()]);
    cliSsh = null;
    sessionSsh = null;
  });
}
