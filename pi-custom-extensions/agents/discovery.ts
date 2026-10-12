import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readClaudeModel, readStatus } from "./registry.ts";
import { isDescendant, isInteractive, isPi, listPanes, listProcesses, run, type Agent, type ProcessInfo, type Runner } from "./tmux.ts";

interface ClaudeSession {
  pid: number;
  kind: "interactive" | "background";
  cwd: string;
  status?: "busy" | "waiting" | "idle";
  state?: string;
  waitingFor?: string;
  name?: string;
  sessionId?: string;
}

export function parseClaudeSessions(output: string): ClaudeSession[] {
  const data: unknown = JSON.parse(output);
  if (!Array.isArray(data)) throw new Error("claude agents --json did not return an array.");
  const sessions = new Map<number, ClaudeSession>();
  for (const entry of data) {
    if (!entry || typeof entry !== "object" || !Number.isSafeInteger(entry.pid) || entry.pid <= 0 ||
      (entry.kind !== "interactive" && entry.kind !== "background") || typeof entry.cwd !== "string") continue;
    const string = (key: string): string | undefined => typeof entry[key] === "string" ? entry[key] : undefined;
    sessions.set(entry.pid, {
      pid: entry.pid, kind: entry.kind, cwd: entry.cwd,
      status: ["busy", "waiting", "idle"].includes(entry.status) ? entry.status : undefined,
      state: string("state"), waitingFor: string("waitingFor"), name: string("name"), sessionId: string("sessionId"),
    });
  }
  return [...sessions.values()];
}

export type Discovery = Agent[] & { warning?: string; processes?: Map<number, ProcessInfo> };

export async function discover(
  socket: string | undefined, runner: Runner = run, directory = join(getAgentDir(), "agents-live"),
): Promise<Discovery> {
  // Read Claude first so the subsequent process snapshot cannot include the discovery CLI itself.
  let claude: ClaudeSession[] = [];
  let warning: string | undefined;
  try {
    claude = parseClaudeSessions(await runner("claude", ["agents", "--json"]));
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
      warning = `Claude discovery unavailable: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  const [panes, processes] = await Promise.all([socket ? listPanes(socket, runner) : [], listProcesses(runner)]);
  const agents: Discovery = [];
  agents.processes = processes;
  for (const info of processes.values()) {
    if (!isPi(info)) continue;
    const status = readStatus(directory, info);
    const base: Agent = {
      provider: "pi", process: info, interactive: status?.interactive ?? isInteractive(info),
      metadata: status ? { state: status.state, cwd: status.cwd, name: status.name, model: status.model, sessionId: status.sessionId } : undefined,
    };
    const matches = panes.filter((pane) => isDescendant(info.pid, pane.pid, processes));
    if (matches.length) agents.push(...matches.map((pane) => ({ ...base, pane })));
    else agents.push(base);
  }
  for (const session of claude) {
    const info = processes.get(session.pid);
    if (!info) continue;
    const model = readClaudeModel(directory, session.sessionId, info);
    const base: Agent = {
      provider: "claude", process: info, interactive: session.kind === "interactive" && isInteractive(info),
      metadata: {
        state: session.status ?? session.state, cwd: session.cwd, name: session.name,
        waitingFor: session.waitingFor, sessionId: session.sessionId,
        model: model?.model, modelDisplayName: model?.displayName,
      },
    };
    const matches = panes.filter((pane) => isDescendant(info.pid, pane.pid, processes));
    if (matches.length) agents.push(...matches.map((pane) => ({ ...base, pane })));
    else agents.push(base);
  }
  if (warning) agents.warning = warning;
  return agents;
}
