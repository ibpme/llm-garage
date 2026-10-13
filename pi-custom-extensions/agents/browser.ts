import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, type OverlayOptions } from "@earendil-works/pi-tui";
import type { AgentSnapshot, RegistryView } from "./reader.ts";
import type { Origin, PaneAction, performPaneAction } from "./tmux-actions.ts";
import { agentDescription, agentKey, agentLabel, clean, detailLines, frame, paneActionReason } from "./view.ts";

export interface BrowserDependencies {
  readRegistry(): Promise<RegistryView>;
  origin?: Origin;
  performPaneAction: typeof performPaneAction;
}

export function overlayOptions(terminal: { columns: number; rows: number }): OverlayOptions {
  return {
    anchor: "center", margin: 1,
    get width() { return Math.max(1, terminal.columns < 90 ? terminal.columns - 2 : Math.min(120, Math.floor(terminal.columns * 0.85))); },
    get maxHeight() { return Math.max(1, terminal.rows < 20 ? terminal.rows - 2 : Math.min(36, Math.floor(terminal.rows * 0.75))); },
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
  const render = () => { if (!closed) requestRender(); };
  const finish = () => { if (!closed) { closed = true; done(); } };
  const apply = (next: RegistryView) => {
    const key = view.agents[selected] ? agentKey(view.agents[selected]) : undefined;
    view = next;
    const index = next.agents.findIndex(agent => agentKey(agent) === key);
    selected = index >= 0 ? index : Math.min(selected, Math.max(0, next.agents.length - 1));
    if (detail) detail = next.agents.find(agent => agentKey(agent) === agentKey(detail!)) ?? detail;
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
      const height = Math.max(1, terminal.rows < 20 ? terminal.rows - 2 : Math.min(36, Math.floor(terminal.rows * 0.75)));
      const inner = Math.max(1, width - 4);
      page = Math.max(1, height - 6);
      const title = theme.bold(`Agents · ${loading ? "Loading registry…" : view.state}`);
      const warning = error || view.warnings.join(" · ");
      let body: string[];
      if (detail) {
        const listed = view.agents.some(agent => agentKey(agent) === agentKey(detail!));
        const lines = detailLines(detail, inner, theme, listed);
        detailLength = lines.length;
        scroll = Math.max(0, Math.min(scroll, Math.max(0, lines.length - page)));
        body = lines.slice(scroll, scroll + page);
      } else {
        offset = Math.max(0, Math.min(offset, selected, Math.max(0, view.agents.length - page)));
        if (selected >= offset + page) offset = selected - page + 1;
        body = view.agents.slice(offset, offset + page).map((agent, i) => {
          const text = `${offset + i === selected ? "→" : " "} ${agentLabel(agent, deps.origin)} · ${agentDescription(agent)}`;
          return offset + i === selected ? theme.fg("accent", text) : text;
        });
        if (!body.length) body = [loading ? "Loading registry…" : view.state === "unavailable" ? "Start agents-registry to browse live agents." : "No agents recorded."];
      }
      while (body.length < page) body.push("");
      const target = detail ?? view.agents[selected];
      const eligible = target && !paneActionReason(view, target, deps.origin, "attach");
      const movable = target && !paneActionReason(view, target, deps.origin, "horizontal");
      const paneHints = movable ? " · V/H split · Ctrl+X kill" : "";
      const footer = pendingKill ? `Kill entire pane ${pendingKill.pane?.id} for PID ${pendingKill.process.pid} (${clean(pendingKill.session.name ?? pendingKill.harness)})? [y/n]`
        : busy ? "Checking and acting…" : detail ? `↑↓ scroll · Esc back · r refresh${paneHints}`
          : `↑↓ navigate · Enter ${eligible ? "attach" : "details"} · i details${paneHints} · r refresh · q close`;
      const lines = height < 7
        ? pendingKill ? [` ${footer}`] : [warning ? theme.fg("warning", clean(warning)) : body[0], ` ${footer}`]
        : [` ${title}`, ` ${theme.fg("warning", clean(warning))}`, ...body, ` ${footer}`];
      return frame(lines, width, height, theme);
    },
    handleInput(data: string): void {
      if (closed) return;
      const back = matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || data === "q";
      if (back) {
        if (pendingKill) pendingKill = undefined;
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
      browser = createBrowser(deps, terminal, theme, () => tui.requestRender(), () => done());
      void browser.refresh();
      timer = setInterval(() => { void browser?.refresh(); }, 2000);
      timer.unref();
      return browser;
    }, { overlay: true, overlayOptions: () => overlayOptions(terminal) });
  } finally { if (timer) clearInterval(timer); browser?.dispose(); }
}
