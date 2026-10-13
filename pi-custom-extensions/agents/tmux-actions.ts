import { ancestryDistance, listProcesses, run } from "../../agents-registry/src/discovery/processes.ts";
import type { Runner } from "../../agents-registry/src/types.ts";
import type { AgentSnapshot } from "./reader.ts";

export interface Origin { server: string; paneId: string }
export type PaneAction = "attach" | "vertical" | "horizontal" | "kill";

export async function performPaneAction(origin: Origin, agent: AgentSnapshot, action: PaneAction, runner: Runner = run): Promise<void> {
  const pane = agent.pane;
  if (agent.session.mode !== "interactive" || !pane) throw new Error("No interactive pane for this agent.");
  if (pane.server !== origin.server) throw new Error("Pane belongs to another tmux server.");
  if (pane.id === origin.paneId && action !== "attach") throw new Error("Cannot move or kill the current pane.");
  const tmux = (args: string[]) => runner("tmux", ["-S", origin.server, ...args]);
  const [processes, paneText] = await Promise.all([
    listProcesses(runner),
    tmux(["-u", "list-panes", "-a", "-F", "#{session_id}\t#{session_name}\t#{window_index}\t#{pane_index}\t#{pane_id}\t#{pane_pid}\t#{pane_current_path}"]),
  ]);
  const live = processes.get(agent.process.pid);
  const panes = paneText.trimEnd().split("\n").map(line => line.split("\t"));
  const target = panes.find(fields => fields[4] === pane.id);
  if (!panes.some(fields => fields[4] === origin.paneId) || !target || !/^\d+$/.test(target[5] ?? "") ||
    !live || live.startedAt !== agent.process.startedAt || ancestryDistance(live.pid, Number(target[5]), processes) === undefined) {
    throw new Error("Agent or invoking pane has exited or moved; refresh /agents.");
  }
  if (pane.id === origin.paneId) return;
  if (action === "kill") { await tmux(["kill-pane", "-t", pane.id]); return; }
  if (action !== "attach") {
    await tmux(["join-pane", action === "vertical" ? "-v" : "-h", "-s", pane.id, "-t", origin.paneId]);
    return;
  }
  const session = (await tmux(["display-message", "-p", "-t", origin.paneId, "#{session_id}"])).trim();
  const clients = (await tmux(["-u", "list-clients", "-F", "#{client_name}\t#{session_id}\t#{client_activity}"]))
    .trim().split("\n").map(line => line.split("\t"))
    .filter(fields => fields[1] === session).sort((a, b) => Number(b[2]) - Number(a[2]));
  if (!clients[0]?.[0]) throw new Error("No attached tmux client in the invoking session.");
  await tmux(["switch-client", "-c", clients[0][0], "-t", pane.id]);
}
