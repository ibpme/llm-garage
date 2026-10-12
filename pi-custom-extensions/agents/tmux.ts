import { basename } from "node:path";
import { isDescendant, listProcesses, parseProcesses, run, type ProcessInfo, type Runner } from "../shared/process-identity.ts";

export { isDescendant, listProcesses, parseProcesses, run, type ProcessInfo, type Runner };

export interface Pane {
  sessionId: string;
  sessionName: string;
  windowIndex: string;
  paneIndex: string;
  id: string;
  pid: number;
  cwd: string;
}

export interface Agent {
  provider: "pi" | "claude";
  interactive: boolean;
  pane?: Pane;
  process: ProcessInfo;
  metadata?: {
    state?: string;
    waitingFor?: string;
    cwd?: string;
    name?: string;
    model?: string;
    modelDisplayName?: string;
    sessionId?: string;
  };
}

export type PaneAgent = Agent & { pane: Pane };
export const isSelectable = (agent: Agent): agent is PaneAgent => agent.interactive && !!agent.pane;

export function isInteractive(info: ProcessInfo): boolean {
  return !/(?:^|\s)(?:-p|--print)(?:\s|=|$)/.test(info.args) &&
    !/(?:^|\s)--mode(?:\s+|=)(?:rpc|json)(?:\s|$)/.test(info.args);
}

export type Action = "attach" | "vertical" | "horizontal" | "kill";

const PANE_FORMAT = [
  "#{session_id}", "#{session_name}", "#{window_index}", "#{pane_index}",
  "#{pane_id}", "#{pane_pid}", "#{pane_current_path}",
].join("\t");

export function isPi(info: ProcessInfo): boolean {
  const command = basename(info.command);
  if (command === "pi") return true;
  if (command !== "node" && command !== "bun") return false;
  const entrypoint = info.args.trim().split(/\s+/)[1];
  return !!entrypoint && (basename(entrypoint) === "pi" ||
    /\/pi-coding-agent\/(?:dist\/(?:bundle\/)?cli\.js|src\/cli\.ts)$/.test(entrypoint));
}

export function parsePanes(output: string): Pane[] {
  return output.trimEnd().split("\n").flatMap((line) => {
    const [sessionId, sessionName, windowIndex, paneIndex, id, pid, ...cwd] = line.split("\t");
    if (!/^%\d+$/.test(id ?? "") || !/^\d+$/.test(pid ?? "")) return [];
    return [{ sessionId, sessionName, windowIndex, paneIndex, id, pid: Number(pid), cwd: cwd.join("\t") }];
  });
}

export function findAgents(panes: Pane[], processes: Map<number, ProcessInfo>): PaneAgent[] {
  const piProcesses = [...processes.values()].filter(isPi);
  return panes.flatMap((pane) => piProcesses
    .filter((info) => isDescendant(info.pid, pane.pid, processes))
    .map((info) => ({ provider: "pi" as const, interactive: isInteractive(info), pane, process: info })));
}

export async function listPanes(socket: string, runner: Runner = run): Promise<Pane[]> {
  return parsePanes(await runner("tmux", ["-S", socket, "list-panes", "-a", "-F", PANE_FORMAT]));
}

export async function snapshot(socket: string, runner: Runner = run): Promise<{ panes: Pane[]; processes: Map<number, ProcessInfo> }> {
  const [panes, processes] = await Promise.all([listPanes(socket, runner), listProcesses(runner)]);
  return { panes, processes };
}

export async function act(
  socket: string, originPane: string, agent: Agent, action: Action, runner: Runner = run,
): Promise<void> {
  if (!isSelectable(agent)) throw new Error("Non-interactive processes cannot be attached, split or killed.");
  if (action === "kill" && agent.pane.id === originPane) throw new Error("Cannot kill the current pane.");
  // Revalidate both PID and start time: the picker may outlive a process or pane.
  const { panes, processes } = await snapshot(socket, runner);
  const info = processes.get(agent.process.pid);
  const pane = panes.find((item) => item.id === agent.pane.id);
  if (!info || info.startedAt !== agent.process.startedAt || !pane ||
    !isDescendant(info.pid, pane.pid, processes)) {
    throw new Error("That agent process has exited or moved. Reopen /agents.");
  }
  const current = { pane, process: info };
  if (current.pane.id === originPane) {
    if (action !== "attach") throw new Error("Cannot split the current pane into itself.");
    return;
  }
  const tmux = (args: string[]) => runner("tmux", ["-S", socket, ...args]);
  if (action === "kill") {
    await tmux(["kill-pane", "-t", current.pane.id]);
    return;
  }
  if (action !== "attach") {
    await tmux(["join-pane", action === "vertical" ? "-v" : "-h", "-s", current.pane.id, "-t", originPane]);
    return;
  }

  const originSession = (await tmux(["display-message", "-p", "-t", originPane, "#{session_id}"])).trim();
  const clients = (await tmux(["list-clients", "-F", "#{client_name}\t#{session_id}\t#{client_activity}"]))
    .trim().split("\n").map((line) => line.split("\t"))
    .filter((client) => client[1] === originSession)
    .sort((a, b) => Number(b[2]) - Number(a[2]));
  if (!clients[0]?.[0]) throw new Error("No attached tmux client in the current session.");
  // Switch the existing client instead of spawning a nested tmux attachment.
  await tmux(["switch-client", "-c", clients[0][0], "-t",
    `${current.pane.sessionId}:${current.pane.windowIndex}.${current.pane.paneIndex}`]);
}
