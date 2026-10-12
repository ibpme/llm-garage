import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, type OverlayOptions } from "@earendil-works/pi-tui";
import { AgentJobs, type JobSnapshot } from "../shared/agent-jobs/jobs.ts";
import { tryGetForegroundWaits, type ForegroundWaits } from "../shared/agent-jobs/foreground.ts";
import { isTerminal } from "../shared/agent-jobs/store.ts";
import { act, isSelectable, parseProcesses, run, type Action, type Agent } from "./tmux.ts";
import { discover } from "./discovery.ts";
import { jobHeader, loadFiles, processHeader, processLines, sectionLines, SECTIONS, tabsLine, type JobFiles, type Section } from "./detail.ts";
import { registerClaudeEndpointsCommand } from "./endpoints.ts";
import { HEARTBEAT_MS, removeStatus, writeStatus } from "./registry.ts";
import { buildRows, canBackground, clean, FILTERS, providerName, RECENT_LIMIT, renderList, type Filter, type Row } from "./rows.ts";

const message = (error: unknown): string => clean(error instanceof Error ? error.message : String(error));

interface Choice { agent: Agent; action: Action }
type JobsApi = Pick<AgentJobs, "list" | "inspect" | "cancel" | "mark">;

interface Detail {
  row: Row;
  job?: JobSnapshot;
  agent?: Agent;
  files: JobFiles;
  filesVersion: number;
  section: Section;
  scroll: number;
  following: boolean;
  lastMax: number;
  lastPage: number;
  bottomTotal: number;
  cache?: { key: string; lines: string[] };
}

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
  ctx: ExtensionCommandContext, socket: string | undefined, originPane: string | undefined, directory: string,
  discoverAgents: (socket: string | undefined) => ReturnType<typeof discover> = (socket) => discover(socket, run, directory),
  performAction: typeof act = act,
  jobs: JobsApi = new AgentJobs(),
  // Read on each use: a reload replaces the agent-task extension's published service.
  foreground: () => ForegroundWaits | undefined = tryGetForegroundWaits,
): Promise<Choice | null> {
  let agents: Awaited<ReturnType<typeof discover>> = [];
  let jobList: JobSnapshot[] = [];
  let activeJobs: JobSnapshot[] = [];
  let timer: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  let terminal = { columns: 80, rows: 24 };
  const sessionId = ctx.sessionManager?.getSessionId() ?? "";
  try {
    return await ctx.ui.custom<Choice | null>((tui, theme, _kb, done) => {
      terminal = tui.terminal;
      const layout = agentsOverlayOptions(terminal);
      let refreshing = false;
      let loadingJobs = false;
      let loading = true;
      let filter: Filter = "session";
      let rows: Row[] = [];
      let selected = 0;
      let offset = 0;
      let detail: Detail | undefined;
      let pendingKill: Agent | undefined;
      let pendingCancel: JobSnapshot | undefined;
      let busy = "";
      let warning = agents.warning ? message(agents.warning) : "";
      let error = "";
      let notice = "";

      const attachedIds = () => new Set(sessionId ? foreground()?.attached(sessionId).map((job) => job.jobId) ?? [] : []);
      const rebuild = () => {
        const key = rows[selected]?.key;
        rows = buildRows(filter, jobList, activeJobs, agents, agents.processes, sessionId, attachedIds());
        const index = rows.findIndex((row) => row.key === key);
        selected = index >= 0 ? index : Math.min(selected, Math.max(0, rows.length - 1));
      };

      const loadJobs = async () => {
        if (loadingJobs || closed || busy) return;
        loadingJobs = true;
        const requested = filter;
        try {
          const shown = !sessionId && requested === "session" ? []
            : await jobs.list(requested === "session" ? { owner: sessionId } : requested === "live" ? { active: true } : { limit: RECENT_LIMIT });
          const active = requested === "live" ? shown : requested === "recent" ? [] : await jobs.list({ active: true });
          if (closed || requested !== filter) return;
          jobList = shown;
          activeJobs = active;
          rebuild();
        } catch (err) {
          if (!closed) error = message(err);
        } finally {
          loadingJobs = false;
          if (!closed) {
            if (requested !== filter) void loadJobs();
            tui.requestRender();
          }
        }
      };

      const refresh = async () => {
        if (refreshing || closed || pendingKill || busy) return;
        refreshing = true;
        try {
          const updated = await discoverAgents(socket);
          if (closed) return;
          agents = updated;
          warning = agents.warning ? message(agents.warning) : "";
          rebuild();
        } catch (err) {
          if (!closed) error = message(err);
        } finally {
          loading = false;
          refreshing = false;
          if (!closed) tui.requestRender();
        }
      };

      const refreshDetail = async () => {
        const current = detail;
        if (!current?.job || busy) return;
        try {
          const job = await jobs.inspect(current.job.id);
          if (closed || detail !== current) return;
          if (!job) { error = "Job record is no longer available."; return; }
          const needsResult = isTerminal(job.status.state) && !current.files.result;
          current.job = job;
          if (needsResult) {
            current.files = await loadFiles(job, current.files);
            current.filesVersion++;
          }
        } catch (err) {
          if (!closed) error = message(err);
        } finally {
          if (!closed) tui.requestRender();
        }
      };

      const paneAction = (action: Action, row: Row | undefined) => {
        if (row?.kind === "job") { error = "Background jobs have no tmux pane."; return; }
        const agent = row?.agent;
        if (!agent) return;
        if (!socket || !originPane) { error = "Pane actions require tmux."; return; }
        if (!isSelectable(agent)) { error = "No interactive tmux pane for this process."; return; }
        if (action === "kill" && agent.pane.id === originPane) { error = "Cannot kill the current pane."; return; }
        if (action === "kill") pendingKill = agent;
        else done({ agent, action });
      };

      const open = async (row: Row) => {
        const state: Detail = {
          row, files: {}, filesVersion: 0, lastMax: 0, lastPage: 8, bottomTotal: 0,
          section: row.kind === "job" ? "activity" : "result", scroll: 0, following: row.kind === "job",
          ...(row.kind === "job" ? { job: row.job } : { agent: row.agent }),
        };
        detail = state;
        error = "";
        notice = "";
        if (!state.job) return;
        try {
          state.files = await loadFiles(state.job);
          state.filesVersion++;
        } catch (err) { if (!closed) error = message(err); }
        if (!closed) tui.requestRender();
      };

      const enter = (row: Row | undefined) => {
        if (!row) return;
        if (row.kind === "agent" && socket && isSelectable(row.agent)) paneAction("attach", row);
        else void open(row);
      };

      const target = (): Row | undefined => detail ? detail.row : rows[selected];
      const ownedJob = (row: Row | undefined): JobSnapshot | undefined => row?.kind === "job" ? (detail?.job ?? row.job) : undefined;

      const askCancel = () => {
        const row = target();
        const job = ownedJob(row);
        if (!job) { error = "Only background jobs can be cancelled."; return; }
        if (!row || row.kind !== "job" || !row.owned) { error = "Only the session that started this job can cancel it."; return; }
        if (isTerminal(job.status.state)) { error = "This job has already finished."; return; }
        pendingCancel = job;
      };

      // The same transition as the agent-task shortcut; opening or closing this modal never changes waiting policy.
      const sendToBackground = async () => {
        const row = target();
        const job = ownedJob(row);
        const current = row?.kind === "job" && job ? { ...row, job, attached: attachedIds().has(job.id) } : row;
        const service = foreground();
        if (!job || !service || !canBackground(current)) { error = "Only a running foreground job attached to this session can be sent to the background."; return; }
        busy = `Sending ${clean(job.request.name)} to the background…`;
        tui.requestRender();
        try {
          const outcome = await service.sendToBackground(job.id, sessionId);
          notice = {
            backgrounded: `Sent ${clean(job.request.name)} to the background; its tool call returned a receipt.`,
            completed: `${clean(job.request.name)} already finished; its answer is being returned.`,
            "not-attached": `${clean(job.request.name)} is no longer waiting in the foreground.`,
          }[outcome];
        } catch (err) {
          if (!closed) error = message(err);
        } finally {
          busy = "";
          if (!closed) {
            await Promise.all([loadJobs(), refreshDetail()]);
            tui.requestRender();
          }
        }
      };

      const acknowledge = async () => {
        const row = target();
        const job = ownedJob(row);
        if (!job || row?.kind !== "job" || !row.owned) { error = "Only the owning session can acknowledge a job."; return; }
        if (!isTerminal(job.status.state)) { error = "Only finished jobs can be acknowledged."; return; }
        try {
          notice = await jobs.mark(job.id, "acknowledged") ? `Acknowledged ${clean(job.request.name)}.` : `${clean(job.request.name)} was already acknowledged.`;
          await loadJobs();
        } catch (err) { error = message(err); }
      };

      const cancel = async (job: JobSnapshot) => {
        pendingCancel = undefined;
        busy = `Cancelling ${clean(job.request.name)}…`;
        tui.requestRender();
        try {
          const { outcome } = await jobs.cancel(job.id, sessionId);
          notice = {
            cancelled: `Cancelled ${clean(job.request.name)}.`,
            requested: `Cancellation requested for ${clean(job.request.name)}; it is still stopping.`,
            "already-terminal": `${clean(job.request.name)} had already finished.`,
            "not-found": "Job record not found.",
            "not-owner": "Only the session that started this job can cancel it.",
          }[outcome];
        } catch (err) {
          if (!closed) error = message(err);
        } finally {
          busy = "";
          if (!closed) {
            await Promise.all([loadJobs(), refreshDetail()]);
            tui.requestRender();
          }
        }
      };

      const kill = async (agent: Agent) => {
        busy = "Killing pane…";
        pendingKill = undefined;
        tui.requestRender();
        try {
          await performAction(socket!, originPane!, agent, "kill");
          busy = "";
          if (!closed) await refresh();
        } catch (err) {
          if (!closed) error = message(err);
        } finally {
          busy = "";
          if (!closed) tui.requestRender();
        }
      };

      const setFilter = (next: Filter) => {
        filter = next;
        selected = 0;
        offset = 0;
        jobList = [];
        activeJobs = [];
        rebuild();
        void loadJobs();
      };

      const detailBody = (width: number): string[] => {
        const d = detail!;
        const key = `${d.section}|${width}|${d.job?.status.seq}|${d.job?.status.state}|${d.job?.liveness}|${d.filesVersion}|${d.agent ? agentLive(d.agent) : ""}`;
        if (d.cache?.key !== key) {
          d.cache = {
            key,
            lines: d.job ? sectionLines(d.section, d.job, d.files, width, theme) : processLines(d.agent!, width, theme, !agents.some((a) => a.process.pid === d.agent!.process.pid)),
          };
        }
        return d.cache.lines;
      };
      const agentLive = (agent: Agent): string => `${agents.some((a) => a.process.pid === agent.process.pid)}:${agent.metadata?.state}`;

      const frame = (body: string[], width: number, height: number): string[] => {
        const bordered = width >= 6 && height >= 4;
        const contentWidth = Math.max(1, width - (bordered ? 4 : 0));
        const bodyHeight = Math.max(1, height - (bordered ? 2 : 0));
        const lines = body.slice(0, bodyHeight);
        // Keep the centered modal stationary as discovery and confirmations change.
        while (lines.length < bodyHeight) lines.push(" ");
        if (!bordered) return lines.map((line) => truncateToWidth(line, width));
        const horizontal = "─".repeat(width - 2);
        return [
          theme.fg("border", `╭${horizontal}╮`),
          ...lines.map((line) => {
            if (!line) return theme.fg("border", `├${horizontal}┤`);
            const fitted = truncateToWidth(line, contentWidth);
            return theme.fg("border", "│") + ` ${fitted}${" ".repeat(Math.max(0, contentWidth - visibleWidth(fitted)))} ` + theme.fg("border", "│");
          }),
          theme.fg("border", `╰${horizontal}╯`),
        ];
      };

      const messages = (): string[] => [
        ...(error ? [theme.fg("error", error)] : notice ? [theme.fg("success", notice)] : warning ? [theme.fg("warning", warning)] : []),
      ];

      const detailView = (width: number, height: number): string[] => {
        const d = detail!;
        const bordered = width >= 6 && height >= 4;
        const contentWidth = Math.max(1, width - (bordered ? 4 : 0));
        const bodyHeight = Math.max(1, height - (bordered ? 2 : 0));
        const compact = height < 18;
        const now = Date.now();
        if (d.agent) d.agent = agents.find((a) => a.process.pid === d.agent!.process.pid && a.process.startedAt === d.agent!.process.startedAt) ?? d.agent;
        const header = d.job ? [...jobHeader(d.job, theme, now, attachedIds().has(d.job.id)), tabsLine(d.section, theme)] : processHeader(d.agent!, theme);
        const lines = detailBody(contentWidth);
        const footer = [...messages(), theme.fg("dim", d.job
          ? "↑↓/j/k PgUp/PgDn Home/End scroll · Tab section · b background · c cancel · a acknowledge · Esc back"
          : "↑↓/j/k PgUp/PgDn scroll · Enter attach · V/H split · Ctrl+X kill pane · Esc back")];
        const fixed = header.length + footer.length + 1 + (compact ? 0 : 2);
        const page = Math.max(1, bodyHeight - fixed);
        const max = Math.max(0, lines.length - page);
        d.lastMax = max;
        d.lastPage = page;
        d.scroll = d.following ? max : Math.max(0, Math.min(d.scroll, max));
        if (d.scroll >= max) d.bottomTotal = lines.length;
        const fresh = !d.following && lines.length > d.bottomTotal && d.section !== "task";
        const status = lines.length > page ? `${d.scroll + 1}–${Math.min(lines.length, d.scroll + page)}/${lines.length}${d.following ? " · following" : ""}` : "";
        return [
          ...header, ...(compact ? [] : [""]),
          ...lines.slice(d.scroll, d.scroll + page),
          ...(compact ? [] : [""]),
          theme.fg(fresh ? "warning" : "dim", fresh ? "new activity — End to follow" : status || " "),
          ...footer,
        ];
      };

      const listView = (width: number, height: number): string[] => {
        const bordered = width >= 6 && height >= 4;
        const contentWidth = Math.max(1, width - (bordered ? 4 : 0));
        const bodyHeight = Math.max(1, height - (bordered ? 2 : 0));
        const compact = height < 18;
        const now = Date.now();
        const label = FILTERS.find((item) => item.id === filter)!.label;
        const showDiscovering = loading && filter !== "recent";
        const msgs = messages();
        const hints = compact
          ? [theme.fg("dim", "Enter open · Tab filter · b/c/a job · V/H/^X pane · Esc close")]
          : [
            theme.fg("dim", "↑↓/j/k navigate · Enter attach/open · Tab filter · r refresh · Esc/q close"),
            theme.fg("dim", "b send to background · c cancel job · a acknowledge · Shift+V top/bottom · Ctrl+X kill pane (not current)"),
            theme.fg("dim", "Shift+H / Shift+Enter left/right · split moves the existing pane (does not clone it)"),
          ];
        const header = compact
          ? [theme.fg("accent", theme.bold(`Agents · ${label} (${rows.length})`))]
          : [
            theme.fg("accent", theme.bold(`Agents · ${label} (${rows.length})`)),
            theme.fg("muted", "Tab: ") + FILTERS.map((item) => item.id === filter ? theme.fg("accent", `‹${item.label}›`) : theme.fg("dim", item.label)).join("  "),
            "",
          ];
        const fixed = header.length + msgs.length + hints.length + (compact ? 1 : 3) + (showDiscovering && rows.length ? 1 : 0);
        const visible = Math.max(1, Math.min(14, bodyHeight - fixed));
        const view = renderList(rows, selected, offset, visible, contentWidth, theme, originPane, now);
        offset = view.offset;
        const empty = filter === "recent" ? "No recent jobs." : "No interactive agents or jobs here.";
        return [
          ...header,
          ...(rows.length ? view.lines : [theme.fg(showDiscovering ? "muted" : "warning", showDiscovering ? "Discovering agents…" : empty)]),
          ...(showDiscovering && rows.length ? [theme.fg("muted", "Discovering agents…")] : []),
          ...(view.info ? [theme.fg("dim", `  ${view.info}`)] : []),
          ...(compact ? [] : [""]),
          ...msgs,
          ...hints,
        ];
      };

      rebuild();
      // Let Pi mount the overlay before starting potentially slow process or job discovery.
      setImmediate(() => { void loadJobs(); void refresh(); });
      let ticks = 0;
      timer = setInterval(() => {
        void (detail ? refreshDetail() : loadJobs());
        if (++ticks % 2 === 0) void refresh();
      }, 1_000);
      timer.unref();
      return {
        render(width: number) {
          const height = layout.maxHeight as number;
          if (pendingKill) {
            return frame([
              theme.fg("warning", "Kill this entire tmux pane? [y/n]"),
              theme.fg("muted", clean(`${providerName(pendingKill)} · PID ${pendingKill.process.pid} · pane ${pendingKill.pane?.id}`)),
              theme.fg("dim", "All processes in the pane will be terminated. Esc cancels."),
            ], width, height);
          }
          if (pendingCancel) {
            return frame([
              theme.fg("warning", clean(`Cancel background job ${pendingCancel.request.name} (${pendingCancel.id})? [y/n]`)),
              theme.fg("muted", "The job's whole process group is stopped; a partial result may remain."),
              theme.fg("dim", "Esc cancels."),
            ], width, height);
          }
          if (busy) return frame([theme.fg("warning", busy)], width, height);
          return frame(detail ? detailView(width, height) : listView(width, height), width, height);
        },
        invalidate() {},
        dispose() {
          closed = true;
          if (timer) clearInterval(timer);
        },
        handleInput(data: string) {
          if (busy) return;
          const yes = data === "y" || data === "Y";
          const no = data === "n" || data === "N" || matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"));
          if (pendingKill) {
            if (yes) void kill(pendingKill);
            else if (no) pendingKill = undefined;
            tui.requestRender();
            return;
          }
          if (pendingCancel) {
            if (yes) void cancel(pendingCancel);
            else if (no) pendingCancel = undefined;
            tui.requestRender();
            return;
          }
          error = "";
          notice = "";
          const up = data === "k" || matchesKey(data, Key.up);
          const down = data === "j" || matchesKey(data, Key.down);
          if (matchesKey(data, Key.ctrl("x"))) paneAction("kill", target());
          else if (data === "V" || matchesKey(data, Key.shift("v"))) paneAction("vertical", target());
          else if (data === "H" || matchesKey(data, Key.shift("h")) || matchesKey(data, Key.shift("enter"))) paneAction("horizontal", target());
          else if (data === "c") askCancel();
          else if (data === "b") void sendToBackground();
          else if (data === "a") void acknowledge();
          else if (data === "r") { void refresh(); void (detail ? refreshDetail() : loadJobs()); }
          else if (detail) {
            const d = detail;
            if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || data === "q") detail = undefined;
            else if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab"))) {
              if (d.job) {
                const step = matchesKey(data, Key.tab) ? 1 : SECTIONS.length - 1;
                d.section = SECTIONS[(SECTIONS.findIndex((item) => item.id === d.section) + step) % SECTIONS.length].id;
                d.scroll = 0;
                d.following = d.section === "activity" || (d.section === "result" && !!d.job && !isTerminal(d.job.status.state));
                d.bottomTotal = 0;
              }
            } else if (matchesKey(data, Key.enter)) { if (d.agent) enter(d.row); }
            else {
              const to = up ? d.scroll - 1 : down ? d.scroll + 1 : matchesKey(data, Key.pageUp) ? d.scroll - d.lastPage
                : matchesKey(data, Key.pageDown) ? d.scroll + d.lastPage : matchesKey(data, Key.home) ? 0 : matchesKey(data, Key.end) ? d.lastMax : undefined;
              if (to !== undefined) {
                d.scroll = Math.max(0, Math.min(to, d.lastMax));
                d.following = d.scroll >= d.lastMax;
              }
            }
          } else if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || data === "q") done(null);
          else if (matchesKey(data, Key.tab)) setFilter(FILTERS[(FILTERS.findIndex((item) => item.id === filter) + 1) % FILTERS.length].id);
          else if (matchesKey(data, Key.shift("tab"))) setFilter(FILTERS[(FILTERS.findIndex((item) => item.id === filter) + FILTERS.length - 1) % FILTERS.length].id);
          else if (matchesKey(data, Key.enter)) enter(rows[selected]);
          else if (up) selected = Math.max(0, selected - 1);
          else if (down) selected = Math.min(rows.length - 1, selected + 1);
          else if (matchesKey(data, Key.pageUp)) selected = Math.max(0, selected - 8);
          else if (matchesKey(data, Key.pageDown)) selected = Math.max(0, Math.min(rows.length - 1, selected + 8));
          else if (matchesKey(data, Key.home)) selected = 0;
          else if (matchesKey(data, Key.end)) selected = Math.max(0, rows.length - 1);
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
    description: "Browse background jobs and live Pi/Claude agents; inspect, cancel jobs, attach or split tmux panes",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/agents requires interactive TUI mode.", "error");
        return;
      }
      const originPane = process.env.TMUX_PANE;
      const tmuxEnv = process.env.TMUX;
      // Browsing works anywhere; pane actions need the invoking tmux server.
      const inTmux = !!originPane && !!tmuxEnv;
      try {
        // Strip tmux server PID and session index without breaking commas in socket paths.
        const socket = inTmux ? tmuxEnv.replace(/,\d+,\d+$/, "") : undefined;
        const choice = await picker(ctx, socket, inTmux ? originPane : undefined, directory);
        if (choice && socket && originPane) await act(socket, originPane, choice.agent, choice.action);
      } catch (err) {
        ctx.ui.notify(`/agents: ${message(err)}`, "error");
      }
    },
  });
}
