import assert from 'node:assert/strict';
import test from 'node:test';
import { discover } from '../src/discovery/index.js';
import { parseProcesses } from '../src/discovery/processes.js';
import type { Runner } from '../src/types.js';

const ps = [
  '10 1 Wed Oct 7 09:00:00 2026 /bin/zsh -zsh',
  '101 10 Wed Oct 7 10:00:00 2026 /usr/bin/node node /x/pi-coding-agent/dist/cli.js',
  '102 10 Wed Oct 7 10:01:00 2026 claude claude',
  '103 1 Wed Oct 7 10:02:00 2026 pi pi --mode rpc',
].join('\n');
const claude = JSON.stringify([{ pid: 102, kind: 'interactive', cwd: '/repo', status: 'waiting', waitingFor: 'permission', sessionId: 'session-1' }, { pid: 999, kind: 'background', cwd: '/gone' }]);

test('joins only live agents and chooses the nearest pane ancestry across configured servers', async () => {
  const runner: Runner = async (command, args) => {
    if (command === 'claude') { assert.deepEqual(args, ['agents', '--json']); return claude; }
    if (command === 'ps') return ps;
    if (command === 'tmux') return args.includes('/tmp/inner')
      ? '$2\tinner\t0\t0\t%2\t101\t/inner'
      : '$1\touter\t0\t0\t%1\t10\t/repo';
    throw new Error('unexpected command');
  };
  const result = await discover({ tmuxServers: ['/tmp/outer', '/tmp/inner'], runner, now: () => 1000 });
  assert.equal(result.agents.length, 3);
  const pi = result.agents.find(a => a.process.pid === 101)!;
  assert.equal(pi.pane?.server, '/tmp/inner');
  assert.equal(pi.activity.state, 'unknown');
  const cc = result.agents.find(a => a.harness === 'claude')!;
  assert.equal(cc.activity.state, 'waiting');
  assert.equal(cc.activity.waitingFor, 'permission');
  assert.equal(cc.session.id, 'session-1');
  assert.equal(result.agents.find(a => a.process.pid === 103)!.session.mode, 'non-interactive');
});

test('command failures are not treated as successful empty discovery', async () => {
  const result = await discover({ tmuxServers: ['/tmp/tmux'], runner: async () => { throw new Error('unavailable'); }, now: () => 2000 });
  assert.equal(result.processes, undefined);
  assert.equal(result.errors.length, 3);
  assert.deepEqual(result.successfulTmuxServers, []);
});

test('malformed ps output is rejected rather than deleting all agents', () => {
  assert.throws(() => parseProcesses('garbage'), /process/);
});
