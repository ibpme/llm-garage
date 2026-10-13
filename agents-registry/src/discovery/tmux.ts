import type { Pane, ProcessInfo, Runner } from '../types.js';
import { ancestryDistance } from './processes.js';
interface RootPane extends Pane { pid: number }
const FORMAT = ['#{session_id}', '#{session_name}', '#{window_index}', '#{pane_index}', '#{pane_id}', '#{pane_pid}', '#{pane_current_path}'].join('\t');
export async function listPanes(server: string, runner: Runner): Promise<RootPane[]> {
  const output = await runner('tmux', ['-S', server, '-u', 'list-panes', '-a', '-F', FORMAT]);
  return output.split('\n').filter(line => line.trim()).map(line => {
    const [sessionId, sessionName, windowIndex, paneIndex, id, pid, ...cwd] = line.split('\t');
    if (!sessionId || !sessionName || windowIndex === undefined || paneIndex === undefined || !/^%\d+$/.test(id ?? '') || !/^\d+$/.test(pid ?? '')) throw new Error('Invalid tmux pane listing');
    return { server, sessionId, sessionName, windowIndex, paneIndex, id: id!, pid: Number(pid), cwd: cwd.join('\t') };
  });
}
export function matchPane(pid: number, panes: RootPane[], processes: Map<number, ProcessInfo>): Pane | undefined {
  const matches = panes.flatMap(pane => {
    const distance = ancestryDistance(pid, pane.pid, processes);
    return distance === undefined ? [] : [{ pane, distance }];
  }).sort((a, b) => a.distance - b.distance || a.pane.server.localeCompare(b.pane.server) || a.pane.id.localeCompare(b.pane.id));
  if (!matches[0]) return undefined;
  const { pid: _pid, ...pane } = matches[0].pane;
  return pane;
}
