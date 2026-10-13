import assert from 'node:assert/strict';
import test from 'node:test';
import { validateMessage, validateSnapshot } from '../src/protocol.js';
const base = { version: 1, type: 'publish', provider: 'claude', process: { pid: 1, startedAt: 'start' }, source: 'claude-hook', reportedAt: 1000, patch: { activity: { state: 'busy' } } };

test('validates publisher input and rejects invalid source combinations and pane injection', () => {
  assert.equal(validateMessage(base).type, 'publish');
  for (const invalid of [
    { ...base, process: { pid: 0, startedAt: 'start' } },
    { ...base, provider: 'pi' },
    { ...base, patch: { pane: { id: '%1' } } },
    { ...base, patch: {} },
    { ...base, patch: { activity: { state: 'working' } } },
    { ...base, source: 'claude-statusline', patch: { activity: { state: 'busy' } } },
  ]) assert.throws(() => validateMessage(invalid), /Invalid/);
});

test('snapshot validates optional singular pane and rejects plural panes', () => {
  const row = { schemaVersion: 1, provider: 'pi', observedAt: 1000, process: { pid: 1, startedAt: 'start' }, session: { mode: 'unknown' }, activity: { state: 'unknown', source: 'process-only' } };
  assert.doesNotThrow(() => validateSnapshot(row));
  assert.throws(() => validateSnapshot({ ...row, panes: [] }), /Invalid/);
  assert.throws(() => validateSnapshot({ ...row, pane: null }), /Invalid/);
});
