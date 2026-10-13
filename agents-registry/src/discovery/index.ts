import type { ActivityState, AgentSnapshot, DiscoveryResult, Runner } from '../types.js';
import { listProcesses, run } from './processes.js';
import { parseClaudeSessions, type ClaudeSession } from './claude.js';
import { isInteractive, isPi } from './pi.js';
import { listPanes, matchPane } from './tmux.js';

export async function discover(options: { tmuxServers: string[]; runner?: Runner; now?: () => number }): Promise<DiscoveryResult> {
  const runner = options.runner ?? run;
  const now = options.now ?? Date.now;
  // Timestamp at collection start prevents a slow pass from superseding newer hook events.
  const result: DiscoveryResult = { observedAt: now(), agents: [], errors: [], successfulTmuxServers: [] };
  let claude: ClaudeSession[] = [];
  try { claude = parseClaudeSessions(await runner('claude', ['agents', '--json'])); }
  catch (error) { result.errors.push(`claude: ${String(error)}`); }
  const [processes, paneResults] = await Promise.all([
    listProcesses(runner).catch(error => { result.errors.push(`ps: ${String(error)}`); return undefined; }),
    Promise.all([...new Set(options.tmuxServers)].map(async server => {
      try { const panes = await listPanes(server, runner); result.successfulTmuxServers.push(server); return panes; }
      catch (error) { result.errors.push(`tmux ${server}: ${String(error)}`); return []; }
    })),
  ]);
  if (!processes) return result;
  result.processes = processes;
  const panes = paneResults.flat();
  for (const info of processes.values()) {
    if (!isPi(info)) continue;
    result.agents.push({ schemaVersion: 1, harness: 'pi', observedAt: result.observedAt,
      process: { pid: info.pid, startedAt: info.startedAt }, session: { mode: isInteractive(info) ? 'interactive' : 'non-interactive' },
      activity: { state: 'unknown', source: 'process-only' } });
  }
  for (const session of claude) {
    const info = processes.get(session.pid);
    if (!info) continue;
    const rawState = session.status ?? session.state;
    const state: ActivityState = rawState === 'busy' || rawState === 'waiting' || rawState === 'idle' ? rawState : 'unknown';
    result.agents.push({ schemaVersion: 1, harness: 'claude', observedAt: result.observedAt,
      process: { pid: info.pid, startedAt: info.startedAt },
      session: { id: session.sessionId, name: session.name, cwd: session.cwd, mode: session.kind === 'background' ? 'background' : isInteractive(info) ? 'interactive' : 'non-interactive' },
      activity: { state, rawState, waitingFor: state === 'waiting' ? session.waitingFor : undefined, source: 'claude-cli' } });
  }
  for (const agent of result.agents) {
    const pane = matchPane(agent.process.pid, panes, processes);
    if (pane) agent.pane = pane;
  }
  return result;
}
