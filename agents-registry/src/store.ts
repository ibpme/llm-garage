import type { AgentSnapshot, DiscoveryResult, ProcessInfo, PublishMessage } from './types.js';

type Stamp = { at: number; priority: number };
interface Entry { row: AgentSnapshot; clocks: Map<string, Stamp> }
const key = (row: Pick<AgentSnapshot, 'harness' | 'process'>): string => JSON.stringify([row.harness, row.process.pid, row.process.startedAt]);

export class AgentStore {
  private readonly entries = new Map<string, Entry>();
  private readonly activityTtlMs: number;
  constructor(options: { activityTtlMs?: number } = {}) { this.activityTtlMs = options.activityTtlMs ?? 20_000; }

  private entry(row: AgentSnapshot): Entry {
    const id = key(row);
    let entry = this.entries.get(id);
    if (!entry) {
      entry = { row: { schemaVersion: 1, harness: row.harness, process: { ...row.process }, observedAt: row.observedAt,
        session: { mode: 'unknown' }, activity: { state: 'unknown', source: 'process-only' } }, clocks: new Map() };
      this.entries.set(id, entry);
    }
    return entry;
  }

  private accept(entry: Entry, field: string, at: number, priority: number): boolean {
    const previous = entry.clocks.get(field);
    if (previous && (at < previous.at || (at === previous.at && priority <= previous.priority))) return false;
    entry.clocks.set(field, { at, priority });
    return true;
  }

  private session(entry: Entry, patch: PublishMessage['patch']['session'], at: number, priority: number): void {
    const target = entry.row.session as unknown as Record<string, unknown>;
    for (const [field, value] of Object.entries(patch ?? {})) {
      if (value === undefined || !this.accept(entry, `session.${field}`, at, priority)) continue;
      if (value === null) delete target[field];
      else target[field] = value;
    }
  }

  publish(message: PublishMessage, live: ProcessInfo | undefined, receivedAt: number): void {
    if (!live || live.pid !== message.process.pid || live.startedAt !== message.process.startedAt) throw new Error('Process identity is no longer live');
    if (message.reportedAt > receivedAt + 5000) throw new Error('Publisher timestamp is in the future');
    // A verified replacement lifetime must not leave its predecessor in the public snapshot.
    for (const [id, entry] of this.entries) {
      if (entry.row.process.pid === live.pid && entry.row.process.startedAt !== live.startedAt) this.entries.delete(id);
    }
    const entry = this.entry({ schemaVersion: 1, harness: message.harness, process: message.process, observedAt: receivedAt,
      session: { mode: 'unknown' }, activity: { state: 'unknown', source: 'process-only' } });
    entry.row.observedAt = Math.max(entry.row.observedAt, receivedAt);
    const at = message.reportedAt;
    const source = message.source === 'pi' ? 'pi-registry' : message.source;
    this.session(entry, message.patch.session, at, 2);
    if ('messaging' in message.patch && this.accept(entry, 'messaging', at, 2)) {
      if (message.patch.messaging) entry.row.messaging = { ...message.patch.messaging, reportedAt: at };
      else delete entry.row.messaging;
    }
    if (message.patch.activity && source !== 'claude-statusline' && this.accept(entry, 'activity', at, 2)) {
      entry.row.activity = { ...message.patch.activity, source, reportedAt: at };
    }
    if ('model' in message.patch && this.accept(entry, 'model', at, 2)) {
      if (message.patch.model) entry.row.model = { ...message.patch.model, source, reportedAt: at };
      else delete entry.row.model;
    }
  }

  reconcile(result: DiscoveryResult): void {
    if (!result.processes) return;
    for (const [id, entry] of this.entries) {
      // A discovery pass may have started before a publisher verified this process.
      if (entry.row.observedAt > result.observedAt) continue;
      const live = result.processes.get(entry.row.process.pid);
      if (!live || live.startedAt !== entry.row.process.startedAt) { this.entries.delete(id); continue; }
      entry.row.observedAt = result.observedAt;
      if (entry.row.pane && result.successfulTmuxServers.includes(entry.row.pane.server) && this.accept(entry, 'pane', result.observedAt, 1)) delete entry.row.pane;
    }
    for (const row of result.agents) {
      const newerLifetime = [...this.entries.values()].some(entry =>
        entry.row.process.pid === row.process.pid && entry.row.process.startedAt !== row.process.startedAt && entry.row.observedAt > result.observedAt);
      if (newerLifetime) continue;
      const existing = this.entries.get(key(row));
      if (existing && existing.row.observedAt > result.observedAt) continue;
      const entry = this.entry(row);
      entry.row.observedAt = Math.max(entry.row.observedAt, result.observedAt);
      this.session(entry, row.session, result.observedAt, 1);
      if (row.activity.source !== 'process-only' && this.accept(entry, 'activity', result.observedAt, 1)) {
        entry.row.activity = { ...row.activity, reportedAt: row.activity.reportedAt ?? result.observedAt };
      }
      if (row.model && this.accept(entry, 'model', row.model.reportedAt, 1)) entry.row.model = { ...row.model };
      // Pane deletion and replacement are one observation, not two competing updates.
      if (row.pane) {
        const stamp = entry.clocks.get('pane');
        if (!stamp || stamp.at <= result.observedAt) {
          entry.row.pane = { ...row.pane };
          entry.clocks.set('pane', { at: result.observedAt, priority: 1 });
        }
      }
    }
  }

  snapshot(now: number): AgentSnapshot[] {
    return [...this.entries.values()].map(({ row }) => {
      const copy = structuredClone(row);
      if (copy.messaging && now - copy.messaging.reportedAt > this.activityTtlMs) delete copy.messaging;
      if (copy.activity.reportedAt !== undefined && now - copy.activity.reportedAt > this.activityTtlMs) {
        copy.activity.state = 'unknown';
        delete copy.activity.waitingFor;
      }
      return copy;
    }).sort((a, b) => a.harness.localeCompare(b.harness) || a.process.pid - b.process.pid || a.process.startedAt - b.process.startedAt);
  }
}
