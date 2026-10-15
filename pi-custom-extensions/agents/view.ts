import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { AgentSnapshot, RegistryView } from "./reader.ts";
import type { Origin, PaneAction } from "./tmux-actions.ts";

export const clean = (value: string): string => value.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
export const agentKey = (agent: AgentSnapshot): string => `${agent.harness}:${agent.process.pid}:${agent.process.startedAt}`;
export const recentAgent = (agent: AgentSnapshot): boolean => agent.observedAt <= Date.now() + 5000 && Date.now() - agent.observedAt <= 30_000;

export function paneActionReason(view: RegistryView, agent: AgentSnapshot, origin: Origin | undefined, action: PaneAction): string | undefined {
  if (view.state === "stale" || view.state === "unavailable" || !recentAgent(agent)) return "Registry observations are stale; refresh before taking actions.";
  if (!origin) return "Pane actions require tmux.";
  if (agent.session.mode !== "interactive" || !agent.pane) return "No interactive tmux pane for this agent.";
  if (agent.pane.server !== origin.server) return "Agent is on another tmux server (read-only).";
  if (agent.pane.id === origin.paneId && action !== "attach") return "Cannot move or kill the current pane.";
  return undefined;
}

export function isCurrentAgent(agent: AgentSnapshot, origin?: Origin): boolean {
  return (agent.harness === "pi" && agent.process.pid === process.pid) ||
    !!(agent.pane && origin && agent.pane.server === origin.server && agent.pane.id === origin.paneId);
}

export function agentGroup(agent: AgentSnapshot, origin?: Origin): string {
  if (isCurrentAgent(agent, origin)) return "Current session";
  return agent.session.mode === "interactive" && agent.pane ? "Interactive (tmux)" : "Non-tmux";
}

export function sortAgents(agents: AgentSnapshot[], origin?: Origin): AgentSnapshot[] {
  const groups = ["Current session", "Interactive (tmux)", "Non-tmux"];
  const states = ["waiting", "busy", "idle", "unknown"];
  return [...agents].sort((a, b) =>
    groups.indexOf(agentGroup(a, origin)) - groups.indexOf(agentGroup(b, origin)) ||
    states.indexOf(a.activity.state) - states.indexOf(b.activity.state) ||
    clean(a.session.name ?? "").localeCompare(clean(b.session.name ?? "")) ||
    agentKey(a).localeCompare(agentKey(b)));
}

export function agentLabel(agent: AgentSnapshot, origin?: Origin): string {
  return `${agent.harness === "pi" ? "Pi" : "Claude"}  [${agent.activity.state}]` +
    (isCurrentAgent(agent, origin) ? " (current)" : "") + (!recentAgent(agent) ? " (stale)" : "");
}

function listenerStatus(agent: AgentSnapshot, registryState: RegistryView["state"]): "listening" | "off" | "stale" {
  if (!agent.messaging) return "off";
  const reportedAt = agent.messaging.reportedAt;
  const now = Date.now();
  return registryState === "stale" || registryState === "unavailable" || !recentAgent(agent) ||
    reportedAt > now + 5000 || now - reportedAt > 20_000 ? "stale" : "listening";
}

export function agentRow(agent: AgentSnapshot, selected: boolean, theme: Pick<Theme, "fg" | "bold">, origin?: Origin, registryState: RegistryView["state"] = "fresh"): string {
  const tone = { waiting: "warning", busy: "accent", idle: "success", unknown: "dim" } as const;
  const label = agentLabel(agent, origin);
  const state = `[${agent.activity.state}]`;
  const [before, after] = label.split(state);
  const listener = listenerStatus(agent, registryState);
  const listenerBadge = listener === "listening" ? "[listening]" : `[listener ${listener}]`;
  const listenerTone = listener === "listening" ? "success" : listener === "stale" ? "warning" : "dim";
  return `${theme.fg("accent", selected ? "→" : " ")} ${theme.bold(theme.fg(selected ? "accent" : "text", before))}` +
    theme.fg(tone[agent.activity.state], state) + theme.fg("muted", after) + ` ${theme.fg(listenerTone, listenerBadge)}` +
    ` · ${theme.fg(selected ? "accent" : "muted", agentDescription(agent))}`;
}

export const agentDescription = (agent: AgentSnapshot): string => clean([
  agent.session.name, agent.model ? `${agent.model.provider ? `${agent.model.provider}/` : ""}${agent.model.id}` : undefined,
  agent.session.cwd ?? agent.pane?.cwd, agent.activity.waitingFor,
].filter(Boolean).join(" · "));

export function detailLines(agent: AgentSnapshot, width: number, theme: Pick<Theme, "fg" | "bold">, listed: boolean, registryState: RegistryView["state"] = "fresh"): string[] {
  const pane = agent.pane;
  const listener = listenerStatus(agent, listed ? registryState : "stale");
  const listenerDescription = listener === "listening" ? "advertised (not probed)" :
    listener === "stale" ? "stale advertisement (not probed)" : "off (not advertised)";
  const fields: Array<[string, string | undefined]> = [
    ["harness", agent.harness], ["PID", String(agent.process.pid)], ["started", new Date(agent.process.startedAt).toISOString()],
    ["observed", new Date(agent.observedAt).toISOString()], ["mode", agent.session.mode],
    ["listener", listenerDescription],
    ["activity", agent.activity.state], ["activity source", agent.activity.source], ["raw state", agent.activity.rawState],
    ["waiting for", agent.activity.waitingFor], ["session", agent.session.id], ["name", agent.session.name],
    ["session file", agent.session.file], ["cwd", agent.session.cwd ?? pane?.cwd],
    ["model", agent.model?.id], ["model provider", agent.model?.provider], ["model name", agent.model?.displayName],
    ["tmux server", pane?.server], ["pane", pane ? `${pane.sessionName}:${pane.windowIndex}.${pane.paneIndex} ${pane.id}` : undefined],
  ];
  return [theme.bold("Metadata"), ...(listed ? [] : [theme.fg("warning", "This process is no longer listed.")]),
    ...fields.filter(([, value]) => value !== undefined).flatMap(([key, value]) =>
      wrapTextWithAnsi(`${theme.fg("dim", `${key}:`)} ${clean(value!)}`, Math.max(1, width)))];
}

export function frame(lines: string[], width: number, height: number, theme: Pick<Theme, "fg">): string[] {
  if (width < 3 || height < 3) return lines.slice(0, Math.max(1, height)).map(line => truncateToWidth(line, width));
  const inner = width - 2;
  const row = (line: string) => {
    const text = truncateToWidth(line, inner);
    return theme.fg("border", "│") + text + " ".repeat(Math.max(0, inner - visibleWidth(text))) + theme.fg("border", "│");
  };
  const body = lines.slice(0, height - 2);
  while (body.length < height - 2) body.push("");
  return [theme.fg("border", `╭${"─".repeat(inner)}╮`), ...body.map(row), theme.fg("border", `╰${"─".repeat(inner)}╯`)];
}
