import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, SelectList, truncateToWidth, visibleWidth, type OverlayOptions } from "@earendil-works/pi-tui";
import { act, isSelectable, parseProcesses, run, type Action, type Agent } from "./tmux.ts";
import { discover } from "./discovery.ts";
import { registerClaudeEndpointsCommand } from "./endpoints.ts";
import { HEARTBEAT_MS, removeStatus, writeStatus } from "./registry.ts";

const clean = (text: string): string => text.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
const agentKey = (agent: Agent): string => `${agent.provider}:${agent.pane?.sessionId ?? ""}:${agent.pane?.id ?? ""}:${agent.process.pid}`;
const agentState = (agent: Agent): string => agent.metadata?.state ?? "running (status unknown)";
const agentDescription = (agent: Agent): string => clean([
  agent.metadata?.model, agent.metadata?.name, agent.metadata?.cwd ?? agent.pane?.cwd, agent.metadata?.waitingFor,
].filter(Boolean).join(" · "));
const message = (error: unknown): string => clean(error instanceof Error ? error.message : String(error));

interface Choice { agent: Agent; action: Action }

export function agentsOverlayOptions(terminal: { columns: number; rows: number }): OverlayOptions {
  // Getters are evaluated by the TUI on each layout, including terminal resizes.
  return {
    anchor: "center",
    margin: 1,
    get width() {
      return Math.max(1, terminal.columns < 90 ? terminal.columns - 2 : Math.min(120, Math.floor(terminal.columns * 0.85)));
    },
    get maxHeight() {
      return Math.max(1, terminal.rows < 20 ? terminal.rows - 2 : Math.min(36, Math.floor(terminal.rows * 0.75)));
    },
  };
}

export async function picker(
  ctx: ExtensionCommandContext, socket: string, originPane: string, directory: string,
  discoverAgents: typeof discover = (socket) => discover(socket, run, directory),
  performAction: typeof act = act,
): Promise<Choice | null> {
  let agents: Awaited<ReturnType<typeof discover>> = [];
  let selectable = agents.filter(isSelectable);
  let nonInteractive = agents.filter((agent) => !isSelectable(agent));
  let timer: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  let terminal = { columns: 80, rows: 24 };
  try {
    return await ctx.ui.custom<Choice | null>((tui, theme, _kb, done) => {
      terminal = tui.terminal;
      const layout = agentsOverlayOptions(terminal);
      let refreshing = false;
      let loading = true;
      let pendingKill: Agent | undefined;
      let killing = false;
      let error = agents.warning ? message(agents.warning) : "";
      let maxVisible = 8;
      let inactiveOffset = 0;
      let inactivePageSize = 4;
      let list: SelectList;

      const choose = (action: Action) => {
        const selected = list.getSelectedItem();
        const agent = selectable.find((item) => agentKey(item) === selected?.value);
        if (agent && isSelectable(agent)) {
          if (action === "kill" && agent.pane.id === originPane) {
            error = "Cannot kill the current pane.";
            return;
          }
          if (action === "kill") {
            pendingKill = agent;
            error = "";
          } else {
            done({ agent, action });
          }
        }
      };

      const rebuild = () => {
        const selected = list?.getSelectedItem()?.value;
        const items = selectable.map((agent) => {
          const state = agentState(agent);
          const pane = agent.pane;
          const location = `${pane.sessionName}:${pane.windowIndex}.${pane.paneIndex} ${pane.id}`;
          return {
            value: agentKey(agent),
            label: clean(`${agent.provider === "claude" ? "Claude" : "Pi"}  ${state}  ${location}  PID ${agent.process.pid}${pane.id === originPane ? " (current)" : ""}`),
            description: agentDescription(agent),
          };
        });
        list = new SelectList(items, maxVisible, {
          selectedPrefix: (text) => theme.fg("accent", text),
          selectedText: (text) => theme.fg("accent", text),
          description: (text) => theme.fg("muted", text),
          scrollInfo: (text) => theme.fg("dim", text),
          noMatch: (text) => theme.fg("warning", text),
        }, { minPrimaryColumnWidth: 32, maxPrimaryColumnWidth: 90 });
        const index = items.findIndex((item) => item.value === selected);
        if (index >= 0) list.setSelectedIndex(index);
        list.onSelect = () => choose("attach");
        list.onCancel = () => done(null);
      };

      const refresh = async () => {
        if (refreshing || closed || pendingKill || killing) return;
        refreshing = true;
        try {
          const updated = await discoverAgents(socket);
          if (closed) return;
          agents = updated;
          selectable = agents.filter(isSelectable);
          nonInteractive = agents.filter((agent) => !isSelectable(agent));
          error = agents.warning ? message(agents.warning) : "";
          rebuild();
        } catch (err) {
          if (!closed) error = message(err);
        } finally {
          loading = false;
          refreshing = false;
          if (!closed) tui.requestRender();
        }
      };

      const kill = async (agent: Agent) => {
        killing = true;
        pendingKill = undefined;
        tui.requestRender();
        try {
          await performAction(socket, originPane, agent, "kill");
          killing = false;
          if (!closed) await refresh();
        } catch (err) {
          if (!closed) error = message(err);
        } finally {
          killing = false;
          if (!closed) tui.requestRender();
        }
      };

      rebuild();
      // Let Pi mount the overlay before starting potentially slow process discovery.
      setImmediate(() => { void refresh(); });
      timer = setInterval(() => { void refresh(); }, 2_000);
      timer.unref();
      return {
        render(width: number) {
          const height = layout.maxHeight as number;
          const bordered = width >= 6 && height >= 4;
          const contentWidth = Math.max(1, width - (bordered ? 4 : 0));
          const compact = height < 18;
          inactivePageSize = compact ? 1 : Math.max(1, Math.min(4, Math.floor((height - 14) / 3)));
          inactiveOffset = Math.min(inactiveOffset, Math.max(0, nonInteractive.length - inactivePageSize));
          const inactiveLines = nonInteractive.length ? [
            "",
            theme.fg("muted", `Non-interactive (${nonInteractive.length}) · read-only`),
            ...nonInteractive.slice(inactiveOffset, inactiveOffset + inactivePageSize).map((agent) => {
              const reason = !agent.interactive ? "headless/background" : "no pane on this tmux server";
              return theme.fg("dim", clean(`  ${agent.provider === "claude" ? "Claude" : "Pi"}  ${agentState(agent)}  PID ${agent.process.pid} · ${reason} · ${agentDescription(agent)}`));
            }),
            ...(nonInteractive.length > inactivePageSize ? [theme.fg("dim",
              `  ${inactiveOffset + 1}–${Math.min(nonInteractive.length, inactiveOffset + inactivePageSize)}/${nonInteractive.length} · PgUp/PgDn to browse`)] : []),
          ] : [];
          const visible = Math.max(1, Math.min(12, height - (compact ? 6 : 12) - inactiveLines.length - (error ? 1 : 0)));
          if (visible !== maxVisible) {
            maxVisible = visible;
            rebuild();
          }
          const lines = [
            theme.fg("accent", theme.bold(`Agents (${agents.length}) · ${selectable.length} selectable`)),
            theme.fg("muted", "Live process discovery · refreshes every 2s"),
            "",
            ...(selectable.length ? list.render(contentWidth) : [theme.fg(loading ? "muted" : "warning", loading ? "Discovering agents…" : "No interactive agents in this tmux server.")]),
            ...inactiveLines,
            "",
            ...(error ? [theme.fg("error", error)] : []),
            theme.fg("dim", "↑↓/j/k navigate · Enter attach · Shift+V top/bottom"),
            theme.fg("dim", "Shift+H / Shift+Enter left/right · Ctrl+X kill pane (not current)"),
            theme.fg("dim", "r refresh · Esc/q close · split moves the existing pane (does not clone it)"),
          ];
          const confirmation = pendingKill ? [
            theme.fg("warning", "Kill this entire tmux pane? [y/n]"),
            theme.fg("muted", clean(`${pendingKill.provider === "claude" ? "Claude" : "Pi"} · PID ${pendingKill.process.pid} · pane ${pendingKill.pane?.id}`)),
            theme.fg("dim", "All processes in the pane will be terminated. Esc cancels."),
          ] : killing ? [theme.fg("warning", "Killing pane…")] : undefined;
          const bodyHeight = Math.max(1, height - (bordered ? 2 : 0));
          const body = (confirmation ?? (compact
            ? [...(selectable.length ? list.render(contentWidth) : [theme.fg("muted", loading ? "Discovering agents…" : "No interactive agents.")]), ...inactiveLines.filter(Boolean),
              ...(error ? [theme.fg("error", error)] : []),
              theme.fg("dim", "Enter attach · V/H split · Ctrl+X kill · Esc close")]
            : lines)).slice(0, bodyHeight);
          // Keep the centered modal stationary as discovery and confirmations change.
          while (body.length < bodyHeight) body.push(" ");
          if (!bordered) return body.map((line) => truncateToWidth(line, width));
          const horizontal = "─".repeat(width - 2);
          return [
            theme.fg("border", `╭${horizontal}╮`),
            ...body.map((line) => {
              if (!line) return theme.fg("border", `├${horizontal}┤`);
              const fitted = truncateToWidth(line, contentWidth);
              const padding = " ".repeat(Math.max(0, contentWidth - visibleWidth(fitted)));
              return theme.fg("border", "│") + ` ${fitted}${padding} ` + theme.fg("border", "│");
            }),
            theme.fg("border", `╰${horizontal}╯`),
          ];
        },
        invalidate() { list.invalidate(); },
        dispose() {
          closed = true;
          if (timer) clearInterval(timer);
        },
        handleInput(data: string) {
          if (killing) return;
          if (pendingKill) {
            if (data === "y" || data === "Y") {
              void kill(pendingKill);
            } else if (data === "n" || data === "N" || matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
              pendingKill = undefined;
            }
            tui.requestRender();
            return;
          }
          if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || data === "q") {
            done(null);
          } else if (matchesKey(data, Key.ctrl("x"))) {
            choose("kill");
          } else if (data === "V" || matchesKey(data, Key.shift("v"))) {
            choose("vertical");
          } else if (data === "H" || matchesKey(data, Key.shift("h")) || matchesKey(data, Key.shift("enter"))) {
            choose("horizontal");
          } else if (matchesKey(data, Key.pageDown)) {
            inactiveOffset = Math.min(Math.max(0, nonInteractive.length - inactivePageSize), inactiveOffset + inactivePageSize);
          } else if (matchesKey(data, Key.pageUp)) {
            inactiveOffset = Math.max(0, inactiveOffset - inactivePageSize);
          } else if (data === "r") {
            void refresh();
          } else {
            list.handleInput(data === "j" ? "\x1b[B" : data === "k" ? "\x1b[A" : data);
          }
          tui.requestRender();
        },
      };
    }, { overlay: true, overlayOptions: () => agentsOverlayOptions(terminal) });
  } finally {
    closed = true;
    if (timer) clearInterval(timer);
  }
}

export default function agentsExtension(pi: ExtensionAPI) {
  const directory = join(getAgentDir(), "agents-live");
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let startedAt: string | undefined;
  let warned = false;

  const publish = (ctx: ExtensionContext, state?: "idle" | "working") => {
    if (!startedAt) return;
    try {
      writeStatus(directory, {
        pid: process.pid,
        startedAt,
        updatedAt: Date.now(),
        state: state ?? (ctx.isIdle() ? "idle" : "working"),
        interactive: ctx.mode === "tui",
        sessionId: ctx.sessionManager.getSessionId(),
        sessionFile: ctx.sessionManager.getSessionFile(),
        name: pi.getSessionName(),
        cwd: ctx.cwd,
        model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
      });
    } catch (err) {
      if (!warned) ctx.ui.notify(`Agents status unavailable: ${message(err)}`, "warning");
      warned = true;
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    if (heartbeat) clearInterval(heartbeat);
    try {
      const processes = parseProcesses(await run("ps", ["-axo", "pid=,ppid=,lstart=,comm=,args="]));
      startedAt = processes.get(process.pid)?.startedAt;
      publish(ctx);
      // Heartbeat might not be necessary once we sorted out which pi events changes which state
      heartbeat = setInterval(() => publish(ctx), HEARTBEAT_MS);
      heartbeat.unref();
    } catch (err) {
      ctx.ui.notify(`Agents status unavailable: ${message(err)}`, "warning");
    }
  });
  pi.on("agent_start", (_event, ctx) => publish(ctx, "working"));
  pi.on("agent_settled", (_event, ctx) => publish(ctx));
  pi.on("session_info_changed", (_event, ctx) => publish(ctx));
  pi.on("session_shutdown", () => {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = undefined;
    startedAt = undefined;
    try { removeStatus(directory, process.pid); } catch { /* Best-effort cleanup; stale records expire. */ }
  });

  registerClaudeEndpointsCommand(pi, directory);

  pi.registerCommand("agents", {
    description: "Browse live Pi and Claude agents; attach, split or kill interactive tmux panes",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/agents requires interactive TUI mode.", "error");
        return;
      }
      const originPane = process.env.TMUX_PANE;
      const tmuxEnv = process.env.TMUX;
      if (!originPane || !tmuxEnv) {
        ctx.ui.notify("/agents requires Pi to be running inside tmux.", "error");
        return;
      }
      try {
        // Strip tmux server PID and session index without breaking commas in socket paths.
        const socket = tmuxEnv.replace(/,\d+,\d+$/, "");
        const choice = await picker(ctx, socket, originPane, directory);
        if (choice) await act(socket, originPane, choice.agent, choice.action);
      } catch (err) {
        ctx.ui.notify(`/agents: ${message(err)}`, "error");
      }
    },
  });
}
