export interface ClaudeSession { pid: number; kind: 'interactive' | 'background'; cwd: string; status?: string; state?: string; waitingFor?: string; name?: string; sessionId?: string }
export function parseClaudeSessions(output: string): ClaudeSession[] {
  const data: unknown = JSON.parse(output);
  if (!Array.isArray(data)) throw new Error('Claude session listing must be an array');
  const sessions = new Map<number, ClaudeSession>();
  for (const value of data) {
    if (!value || typeof value !== 'object') continue;
    const entry = value as Record<string, unknown>;
    if (!Number.isSafeInteger(entry.pid) || Number(entry.pid) <= 0 || (entry.kind !== 'interactive' && entry.kind !== 'background') || typeof entry.cwd !== 'string') continue;
    const row: ClaudeSession = { pid: Number(entry.pid), kind: entry.kind, cwd: entry.cwd };
    for (const field of ['status', 'state', 'waitingFor', 'name', 'sessionId'] as const) if (typeof entry[field] === 'string') row[field] = entry[field];
    sessions.set(row.pid, row);
  }
  return [...sessions.values()];
}
