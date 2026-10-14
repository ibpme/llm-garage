import assert from 'node:assert/strict';
import test from 'node:test';
import { validateMessage, validateSnapshot } from '../src/protocol.js';
const base = { version: 1, type: 'publish', harness: 'claude', process: { pid: 1, startedAt: 100 }, source: 'claude-hook', reportedAt: 1000, patch: { activity: { state: 'busy' } } };

test('validates publisher input and rejects invalid source combinations and pane injection', () => {
  assert.equal(validateMessage(base).type, 'publish');
  for (const invalid of [
    { ...base, process: { pid: 0, startedAt: 100 } },
    { ...base, harness: 'pi' },
    { ...base, patch: { pane: { id: '%1' } } },
    { ...base, patch: {} },
    { ...base, patch: { activity: { state: 'working' } } },
    { ...base, source: 'claude-statusline', patch: { activity: { state: 'busy' } } },
  ]) assert.throws(() => validateMessage(invalid), /Invalid/);
});

test('snapshot validates optional singular pane and rejects plural panes', () => {
  const row = { schemaVersion: 1, harness: 'pi', observedAt: 1000, process: { pid: 1, startedAt: 100 }, session: { mode: 'unknown' }, activity: { state: 'unknown', source: 'process-only' } };
  assert.doesNotThrow(() => validateSnapshot(row));
  assert.throws(() => validateSnapshot({ ...row, panes: [] }), /Invalid/);
  assert.throws(() => validateSnapshot({ ...row, pane: null }), /Invalid/);
});

test('process start times require non-negative safe integer epoch milliseconds', () => {
  const row = { schemaVersion: 1, harness: 'pi', observedAt: 1791367205000, process: { pid: 1, startedAt: 1791367200000 }, session: { mode: 'unknown' }, activity: { state: 'unknown', source: 'process-only' } };
  assert.doesNotThrow(() => validateSnapshot(row));
  assert.doesNotThrow(() => validateMessage({ ...base, process: row.process, reportedAt: 1791367205000 }));
  for (const startedAt of ['Wed Oct 7 10:00:00 2026', -1, 1.5, Number.MAX_SAFE_INTEGER + 1, null]) {
    assert.throws(() => validateSnapshot({ ...row, process: { pid: 1, startedAt } }), /Invalid/);
    assert.throws(() => validateMessage({ ...base, process: { pid: 1, startedAt } }), /Invalid/);
  }
});

test('publisher harness is distinct from model provider and rejects the legacy agent field', () => {
  const message = { ...base, patch: { model: { id: 'sonnet', provider: 'anthropic' } } };
  assert.doesNotThrow(() => validateMessage(message));
  const { harness, ...legacy } = message;
  assert.throws(() => validateMessage({ ...legacy, provider: harness }), /Invalid/);
  assert.throws(() => validateMessage({ ...message, provider: harness }), /Invalid/);
  assert.throws(() => validateMessage({ ...message, harness: 'anthropic' }), /Invalid/);
});

test('snapshot harness is distinct from model provider and rejects the legacy agent field', () => {
  const row = { schemaVersion: 1, harness: 'pi', observedAt: 1000,
    process: { pid: 1, startedAt: 100 }, session: { mode: 'unknown' },
    activity: { state: 'unknown', source: 'process-only' },
    model: { id: 'sonnet', provider: 'anthropic', source: 'pi-registry', reportedAt: 1000 } };
  assert.doesNotThrow(() => validateSnapshot(row));
  const { harness, ...legacy } = row;
  assert.throws(() => validateSnapshot({ ...legacy, provider: harness }), /Invalid/);
  assert.throws(() => validateSnapshot({ ...row, provider: harness }), /Invalid/);
  assert.throws(() => validateSnapshot({ ...row, harness: 'anthropic' }), /Invalid/);
});

test('only Pi can publish a versioned absolute Unix messaging endpoint', () => {
  const endpoint = { transport: 'unix', path: '/tmp/pi.sock', protocol: 'pi-listener-v2' };
  const pi = { ...base, harness: 'pi', source: 'pi', patch: { messaging: endpoint } };
  assert.doesNotThrow(() => validateMessage(pi));
  assert.doesNotThrow(() => validateMessage({ ...pi, patch: { messaging: null } }));
  for (const messaging of [{ ...endpoint, path: 'relative' }, { ...endpoint, transport: 'tcp' }, { ...endpoint, protocol: 'other' }, { ...endpoint, protocol: 'pi-listener-v1' }, { ...endpoint, extra: true }]) {
    assert.throws(() => validateMessage({ ...pi, patch: { messaging } }), /Invalid/);
  }
  assert.throws(() => validateMessage({ ...base, patch: { messaging: endpoint } }), /Invalid/);
  const row = { schemaVersion: 1, harness: 'pi', observedAt: 1000, process: { pid: 1, startedAt: 100 }, session: { mode: 'unknown' }, activity: { state: 'unknown', source: 'process-only' }, messaging: { ...endpoint, reportedAt: 1000 } };
  assert.doesNotThrow(() => validateSnapshot(row));
  assert.throws(() => validateSnapshot({ ...row, messaging: endpoint }), /Invalid/);
  assert.throws(() => validateSnapshot({ ...row, messaging: { ...row.messaging, protocol: 'pi-listener-v1' } }), /Invalid/);
});
