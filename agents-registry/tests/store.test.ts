import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentStore } from '../src/store.js';
import type { AgentSnapshot, ProcessInfo, PublishMessage } from '../src/types.js';

const identity = { pid: 101, startedAt: 100 };
const processInfo: ProcessInfo = { ...identity, ppid: 1, command: 'pi', args: 'pi' };
const agent = (): AgentSnapshot => ({ schemaVersion: 1, harness: 'pi', observedAt: 1000,
  process: identity, session: { mode: 'interactive' }, activity: { state: 'unknown', source: 'process-only' } });
const message = (at: number, patch: PublishMessage['patch']): PublishMessage => ({
  version: 1, type: 'publish', harness: 'pi', process: identity, source: 'pi', reportedAt: at, patch,
});

test('publishing preserves independent fields and rejects older group updates', () => {
  const store = new AgentStore();
  store.reconcile({ observedAt: 1000, processes: new Map([[101, processInfo]]), agents: [agent()], errors: [], successfulTmuxServers: [] });
  store.publish(message(1100, { session: { name: 'Review', cwd: '/repo' }, activity: { state: 'busy', rawState: 'working' } }), processInfo, 1100);
  store.publish(message(1200, { model: { id: 'sonnet', provider: 'anthropic' } }), processInfo, 1200);
  store.publish(message(1050, { activity: { state: 'idle' } }), processInfo, 1300);
  const row = store.snapshot(1300)[0]!;
  assert.equal(row.activity.state, 'busy');
  assert.equal(row.model?.id, 'sonnet');
  assert.equal(row.session.name, 'Review');
  assert.equal(row.observedAt, 1300);
  store.publish(message(1400, { session: { name: null }, model: null }), processInfo, 1400);
  assert.equal(store.snapshot(1400)[0]!.session.name, undefined);
  assert.equal(store.snapshot(1400)[0]!.session.cwd, '/repo');
  assert.equal(store.snapshot(1400)[0]!.model, undefined);
});

test('PID reuse removes the old lifetime and rejects old publisher identities', () => {
  const store = new AgentStore();
  store.publish(message(1000, { activity: { state: 'busy' } }), processInfo, 1000);
  const reused = { ...processInfo, startedAt: 200 };
  assert.throws(() => store.publish(message(1100, { activity: { state: 'idle' } }), reused, 1100), /identity/);
  store.reconcile({ observedAt: 1200, processes: new Map([[101, reused]]), agents: [], errors: [], successfulTmuxServers: [] });
  assert.deepEqual(store.snapshot(1200), []);
});

test('process discovery refreshes liveness without resetting activity and expires stale reports', () => {
  const store = new AgentStore({ activityTtlMs: 20000 });
  store.publish(message(1000, { activity: { state: 'busy' } }), processInfo, 1000);
  store.reconcile({ observedAt: 1500, processes: new Map([[101, processInfo]]), agents: [{ ...agent(), observedAt: 1500 }], errors: [], successfulTmuxServers: [] });
  assert.equal(store.snapshot(1500)[0]!.activity.state, 'busy');
  assert.equal(store.snapshot(22000)[0]!.activity.state, 'unknown');
  store.reconcile({ observedAt: 23000, processes: new Map(), agents: [], errors: [], successfulTmuxServers: [] });
  assert.deepEqual(store.snapshot(23000), []);
});

test('failed ps discovery retains rows and failed tmux discovery retains the pane', () => {
  const store = new AgentStore();
  const pane = { server: '/tmp/tmux.sock', id: '%1', sessionId: '$1', sessionName: 'dev', windowIndex: '0', paneIndex: '0', cwd: '/repo' };
  store.reconcile({ observedAt: 1000, processes: new Map([[101, processInfo]]), agents: [{ ...agent(), pane }], errors: [], successfulTmuxServers: [pane.server] });
  store.reconcile({ observedAt: 2000, agents: [], errors: ['ps failed'], successfulTmuxServers: [] });
  assert.equal(store.snapshot(2000)[0]!.observedAt, 1000);
  store.reconcile({ observedAt: 3000, processes: new Map([[101, processInfo]]), agents: [{ ...agent(), observedAt: 3000 }], errors: ['tmux failed'], successfulTmuxServers: [] });
  assert.equal(store.snapshot(3000)[0]!.pane?.id, '%1');
  store.reconcile({ observedAt: 4000, processes: new Map([[101, processInfo]]), agents: [{ ...agent(), observedAt: 4000 }], errors: [], successfulTmuxServers: [pane.server] });
  assert.equal(store.snapshot(4000)[0]!.pane, undefined);
});

test('discovery captured before a hook cannot overwrite the newer activity', () => {
  const store = new AgentStore();
  const claudeProcess = { ...processInfo, command: 'claude' };
  store.publish({ ...message(2000, { activity: { state: 'busy' } }), harness: 'claude', source: 'claude-hook' }, claudeProcess, 2000);
  store.reconcile({ observedAt: 1500, processes: new Map([[101, claudeProcess]]), agents: [{ ...agent(), harness: 'claude', observedAt: 1500, activity: { state: 'idle', source: 'claude-cli' } }], errors: [], successfulTmuxServers: [] });
  assert.equal(store.snapshot(2100)[0]!.activity.state, 'busy');
  assert.equal(store.snapshot(2100)[0]!.observedAt, 2000);
});

test('an older discovery pass cannot resurrect a replaced PID lifetime', () => {
  const store = new AgentStore();
  const replacement = { ...processInfo, startedAt: 200 };
  store.publish({ ...message(2000, { activity: { state: 'busy' } }), process: { pid: 101, startedAt: replacement.startedAt } }, replacement, 2000);
  store.reconcile({ observedAt: 1500, processes: new Map([[101, processInfo]]), agents: [{ ...agent(), observedAt: 1500 }], errors: [], successfulTmuxServers: [] });
  const rows = store.snapshot(2100);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.process.startedAt, 200);
});

test('session clocks are per field so delayed independent metadata can still be added', () => {
  const store = new AgentStore();
  store.publish(message(2000, { session: { name: 'New name' } }), processInfo, 2000);
  store.publish(message(1500, { session: { name: 'Old name', cwd: '/repo' } }), processInfo, 2100);
  assert.equal(store.snapshot(2100)[0]!.session.name, 'New name');
  assert.equal(store.snapshot(2100)[0]!.session.cwd, '/repo');
});

test('cleared model tombstone prevents a delayed model event from restoring it', () => {
  const store = new AgentStore();
  store.publish(message(2000, { model: null }), processInfo, 2000);
  store.publish(message(1500, { model: { id: 'old-model' } }), processInfo, 2100);
  assert.equal(store.snapshot(2100)[0]!.model, undefined);
});

test('messaging endpoints are timestamped, cleared with tombstones and expire without heartbeat', () => {
  const store = new AgentStore({ activityTtlMs: 20000 });
  const endpoint = { transport: 'unix', path: '/tmp/pi.sock', protocol: 'pi-listener-v2' } as const;
  store.publish(message(1000, { messaging: endpoint }), processInfo, 1000);
  assert.deepEqual(store.snapshot(1000)[0]!.messaging, { ...endpoint, reportedAt: 1000 });
  assert.equal(store.snapshot(21001)[0]!.messaging, undefined);
  store.publish(message(22000, { messaging: endpoint }), processInfo, 22000);
  store.publish(message(23000, { messaging: null }), processInfo, 23000);
  store.publish(message(22500, { messaging: endpoint }), processInfo, 23000);
  assert.equal(store.snapshot(23000)[0]!.messaging, undefined);
});
