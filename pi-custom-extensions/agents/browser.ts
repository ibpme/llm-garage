import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, wrapTextWithAnsi, type OverlayOptions } from "@earendil-works/pi-tui";
import type { AgentSnapshot, RegistryView } from "./reader.ts";
import { createSessionReader, type SessionSnapshot, type SessionReaderOptions } from "./session.ts";
import type { Origin, PaneAction, performPaneAction } from "./tmux-actions.ts";
import { agentGroup, agentKey, agentRow, sortAgents, clean, detailLines, frame, paneActionReason } from "./view.ts";

export interface BrowserDependencies {
  readRegistry(): Promise<RegistryView>;
  readSession?(agent: AgentSnapshot): Promise<SessionSnapshot>;
  currentPi?: SessionReaderOptions["currentPi"];
  origin?: Origin;
  performPaneAction: typeof performPaneAction;
}

interface SessionPreview {
  read: (agent: AgentSnapshot) => Promise<SessionSnapshot>;
  agent: AgentSnapshot;
  snapshot?: SessionSnapshot;
  loading: boolean;
  reading: boolean;
  follow: boolean;
  scroll: number;
  length: number;
  error: string;
}

export function overlayOptions(terminal: { columns: number; rows: number }): OverlayOptions {
  return {
    anchor: "center", margin: 1,
    get width() { return Math.max(1, terminal.columns - 2); },
    get maxHeight() { return Math.max(1, terminal.rows - 2); },
  };
}

export function createBrowser(
  deps: BrowserDependencies, terminal: { columns: number; rows: number }, theme: Pick<Theme, "fg" | "bold">,
  requestRender: () => void, done: () => void,
) {
  let view: RegistryView = { state: "unavailable", agents: [], warnings: [] };
  let loading = true;
  let reading = false;
  let closed = false;
  let busy = false;
  let selected = 0;
  let offset = 0;
  let detail: AgentSnapshot | undefined;
  let scroll = 0;
  let pendingKill: AgentSnapshot | undefined;
  let error = "";
  let page = 8;
  let detailLength = 0;
  let preview: SessionPreview | undefined;
  const refreshPreview = async () => {
    const current = preview;
    if (closed || !current || current.reading) return;
    current.reading = true;
    try {
      const snapshot = await current.read(current.agent);
      if (!closed && preview === current) { current.snapshot = snapshot; current.error = ""; }
    } catch (err) {
      if (!closed && preview === current) current.error = clean(err instanceof Error ? err.message : String(err));
    } finally {
      current.reading = false;
      current.loading = false;
      if (preview === current) render();
    }
  };
  const render = () => { if (!closed) requestRender(); };
  const finish = () => { if (!closed) { closed = true; done(); } };
  const apply = (next: RegistryView) => {
    const key = view.agents[selected] ? agentKey(view.agents[selected]) : undefined;
    view = { ...next, agents: sortAgents(next.agents, deps.origin) };
    const index = view.agents.findIndex(agent => agentKey(agent) === key);
    selected = index >= 0 ? index : 0;
    if (detail) detail = next.agents.find(agent => agentKey(agent) === agentKey(detail!)) ?? detail;
    if (preview) preview.agent = next.agents.find(agent => agentKey(agent) === agentKey(preview!.agent)) ?? preview.agent;
  };
  const refresh = async () => {
    if (closed || reading || busy || pendingKill) return;
    reading = true;
    try {
      const next = await deps.readRegistry();
      if (!closed) apply(next);
    } catch (err) {
      if (!closed) view = { state: "unavailable", agents: view.agents, warnings: [clean(String(err))] };
    } finally { reading = false; loading = false; render(); }
    await refreshPreview();
  };
  const action = async (agent: AgentSnapshot, kind: PaneAction) => {
    const reason = paneActionReason(view, agent, deps.origin, kind);
    if (reason) { error = reason; render(); return; }
    busy = true;
    error = "";
    render();
    try {
      // The writer may have stopped since the modal's last refresh. Reopen health before every action.
      const next = await deps.readRegistry();
      if (closed) return;
      apply(next);
      const current = next.agents.find(item => agentKey(item) === agentKey(agent));
      const invalid = current ? paneActionReason(next, current, deps.origin, kind) : "Agent is no longer listed.";
      if (invalid) throw new Error(invalid);
      if (current!.pane?.id !== agent.pane?.id || current!.pane?.server !== agent.pane?.server) throw new Error("Agent pane changed; refresh before acting.");
      await deps.performPaneAction(deps.origin!, current!, kind);
    } catch (err) { if (!closed) error = clean(err instanceof Error ? err.message : String(err)); }
    finally { busy = false; if (!closed) { await refresh(); render(); } }
  };

  return {
    refresh,
    render(width: number): string[] {
      const height = Math.max(1, terminal.rows - 2);
      const inner = Math.max(1, width - 4);
      const usageLines = preview ? wrapTextWithAnsi(preview.snapshot?.usage ?? "Usage/cost: unavailable", inner).slice(0, Math.max(1, Math.min(4, height - 7))) : [];
      page = Math.max(1, height - 6 - usageLines.length);
      const healthTone = view.state === "fresh" ? "success" : view.state === "unavailable" ? "error" : "warning";
      const title = theme.fg("accent", theme.bold("Agents")) + ` · ${theme.fg(healthTone, loading ? "Loading registry…" : view.state)} · ${theme.fg("muted", `${view.agents.length} sessions`)}`;
      const warning = error || preview?.error || [view.warnings.join(" · "), preview?.snapshot?.warnings.join(" · ")].filter(Boolean).join(" · ");
      let body: string[];
      if (preview) {
        const lines = (preview.snapshot?.entries ?? []).flatMap(entry => {
          const tone = entry.label.includes("ERROR") ? "error" : entry.label.startsWith("TOOL") || entry.label.startsWith("RESULT") ? "dim" : "accent";
          let text = wrapTextWithAnsi(entry.text, inner);
          if ((entry.label.startsWith("TOOL") || entry.label.startsWith("RESULT")) && text.length > 6) text = [...text.slice(0, 5), "… [truncated]"];
          return [theme.fg(tone, theme.bold(entry.label)), ...text, ""];
        });
        if (!lines.length) lines.push(preview.loading ? "Loading session…" : preview.error ? "Session preview unavailable." : "No visible session messages yet.");
        preview.length = lines.length;
        const bottom = Math.max(0, lines.length - page);
        preview.scroll = preview.follow ? bottom : Math.max(0, Math.min(preview.scroll, bottom));
        body = lines.slice(preview.scroll, preview.scroll + page);
      } else if (detail) {
        const listed = view.agents.some(agent => agentKey(agent) === agentKey(detail!));
        const lines = detailLines(detail, inner, theme, listed, view.state);
        detailLength = lines.length;
        scroll = Math.max(0, Math.min(scroll, Math.max(0, lines.length - page)));
        body = lines.slice(scroll, scroll + page);
      } else {
        const rows: Array<{ index?: number; text: string }> = [];
        let group = "";
        view.agents.forEach((agent, index) => {
          const nextGroup = agentGroup(agent, deps.origin);
          if (nextGroup !== group) {
            group = nextGroup;
            const count = view.agents.filter(item => agentGroup(item, deps.origin) === group).length;
            rows.push({ text: theme.fg("accent", theme.bold(` ── ${group} · ${count} ──`)) });
          }
          rows.push({ index, text: agentRow(agent, index === selected, theme, deps.origin, view.state) });
        });
        const selectedRow = Math.max(0, rows.findIndex(row => row.index === selected));
        offset = Math.max(0, Math.min(offset, selectedRow, Math.max(0, rows.length - page)));
        if (selectedRow >= offset + page) offset = selectedRow - page + 1;
        body = rows.slice(offset, offset + page).map(row => row.text);
        if (!body.length) body = [loading ? "Loading registry…" : view.state === "unavailable" ? "Start agents-registry to browse live agents." : "No agents recorded."];
      }
      while (body.length < page) body.push("");
      const target = preview?.agent ?? detail ?? view.agents[selected];
      const eligible = target && !paneActionReason(view, target, deps.origin, "attach");
      const movable = target && !paneActionReason(view, target, deps.origin, "horizontal");
      const paneHints = movable ? " · V/H split · Ctrl+X kill" : "";
      const footer = pendingKill ? `Kill entire pane ${pendingKill.pane?.id} for PID ${pendingKill.process.pid} (${clean(pendingKill.session.name ?? pendingKill.harness)})? [y/n]`
        : busy ? "Checking and acting…" : preview ? `↑↓ scroll · End follow · ←/Esc back · r refresh · ${preview.follow ? "Following" : "Paused"}`
          : detail ? `↑↓ scroll · Esc back · r refresh${paneHints}`
          : `↑↓ navigate · → session · Enter ${eligible ? "attach" : "details"} · i details${paneHints} · r refresh · q close`;
      const lines = height < 7
        ? pendingKill ? [` ${footer}`] : [warning ? theme.fg("warning", clean(warning)) : body[0], ` ${footer}`]
        : [` ${preview ? theme.fg("accent", theme.bold(`Session · ${clean(preview.agent.session.name ?? preview.agent.session.id ?? preview.agent.harness)}`)) : title}`, ` ${theme.fg("warning", clean(warning))}`, ...usageLines.map(line => ` ${theme.fg("muted", line)}`), ...body, ` ${theme.fg(pendingKill ? "warning" : "muted", footer)}`];
      return frame(lines, width, height, theme);
    },
    handleInput(data: string): void {
      if (closed) return;
      const back = matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || data === "q" || (!!preview && matchesKey(data, Key.left));
      if (back) {
        if (pendingKill) pendingKill = undefined;
        else if (preview) preview = undefined;
        else if (detail) { detail = undefined; scroll = 0; }
        else finish();
        render(); return;
      }
      if (busy) return;
      if (pendingKill) {
        const target = pendingKill;
        if (data === "y" || data === "Y") { pendingKill = undefined; void action(target, "kill"); }
        else if (data === "n" || data === "N") pendingKill = undefined;
        render(); return;
      }
      error = "";
      const target = detail ?? view.agents[selected];
      if (data === "r") { void refresh(); return; }
      if (preview) {
        const delta = data === "k" || matchesKey(data, Key.up) ? -1 : data === "j" || matchesKey(data, Key.down) ? 1 : matchesKey(data, Key.pageUp) ? -page : matchesKey(data, Key.pageDown) ? page : 0;
        const bottom = Math.max(0, preview.length - page);
        if (matchesKey(data, Key.end)) { preview.follow = true; preview.scroll = bottom; }
        else if (matchesKey(data, Key.home) || delta) {
          preview.scroll = matchesKey(data, Key.home) ? 0 : Math.max(0, Math.min(bottom, preview.scroll + delta));
          preview.follow = !matchesKey(data, Key.home) && preview.scroll === bottom;
        }
        render(); return;
      }
      if (target && matchesKey(data, Key.right)) {
        preview = { read: deps.readSession ?? createSessionReader({ currentPi: deps.currentPi }), agent: target, loading: true, reading: false, follow: true, scroll: 0, length: 0, error: "" };
        void refreshPreview(); render(); return;
      }
      if (target && (data === "i" || matchesKey(data, Key.enter))) {
        if (!detail && data !== "i" && !paneActionReason(view, target, deps.origin, "attach")) void action(target, "attach");
        else { detail = target; scroll = 0; }
      } else if (target && (data === "V" || data === "H" || matchesKey(data, Key.shift("enter")))) {
        void action(target, data === "V" ? "vertical" : "horizontal");
      } else if (target && matchesKey(data, Key.ctrl("x"))) {
        const reason = paneActionReason(view, target, deps.origin, "kill");
        if (reason) error = reason; else pendingKill = target;
      } else {
        const up = data === "k" || matchesKey(data, Key.up);
        const down = data === "j" || matchesKey(data, Key.down);
        const delta = up ? -1 : down ? 1 : matchesKey(data, Key.pageUp) ? -page : matchesKey(data, Key.pageDown) ? page : 0;
        if (detail) {
          scroll = matchesKey(data, Key.home) ? 0 : matchesKey(data, Key.end) ? Math.max(0, detailLength - page) : Math.max(0, scroll + delta);
        } else {
          selected = matchesKey(data, Key.home) ? 0 : matchesKey(data, Key.end) ? Math.max(0, view.agents.length - 1)
            : Math.max(0, Math.min(view.agents.length - 1, selected + delta));
        }
      }
      render();
    },
    invalidate() {},
    dispose() { closed = true; },
  };
}

export async function openBrowser(ctx: ExtensionCommandContext, deps: BrowserDependencies): Promise<void> {
  let browser: ReturnType<typeof createBrowser> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let terminal = { columns: 80, rows: 24 };
  try {
    await ctx.ui.custom<void>((tui, theme, _keys, done) => {
      terminal = tui.terminal;
      browser = createBrowser({ ...deps, currentPi: deps.currentPi ?? (() => ({ records: ctx.sessionManager.getEntries(), branch: ctx.sessionManager.getBranch() })) }, terminal, theme, () => tui.requestRender(), () => done());
      void browser.refresh();
      timer = setInterval(() => { void browser?.refresh(); }, 2000);
      timer.unref();
      return browser;
    }, { overlay: true, overlayOptions: () => overlayOptions(terminal) });
  } finally { if (timer) clearInterval(timer); browser?.dispose(); }
}
