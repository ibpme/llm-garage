import assert from 'node:assert/strict';
import test from 'node:test';
import { listProcesses, parseProcesses } from '../src/discovery/processes.js';

test('UTC ps start time becomes epoch milliseconds regardless of reader timezone', () => {
  const previous = process.env.TZ;
  try {
    for (const timezone of ['America/New_York', 'Asia/Jakarta', 'Etc/UTC']) {
      process.env.TZ = timezone;
      const processes = parseProcesses('101 1 Wed Oct  7 10:00:00 2026 pi pi');
      assert.equal(processes.get(101)!.startedAt, 1791367200000);
    }
  } finally {
    if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous;
  }
});

test('invalid process start dates reject the scan rather than publishing a bad timestamp', () => {
  for (const start of ['Wed Bad 7 10:00:00 2026', 'Wed Oct 7 99:00:00 2026', 'Wed Dec 31 23:59:59 1969']) {
    assert.throws(() => parseProcesses(`101 1 ${start} pi pi`), /process start time/i);
  }
});

test('real ps collection keeps process identity stable across caller timezone changes', async () => {
  const previous = process.env.TZ;
  try {
    process.env.TZ = 'Asia/Jakarta';
    const first = (await listProcesses()).get(process.pid)!;
    process.env.TZ = 'America/New_York';
    const second = (await listProcesses()).get(process.pid)!;
    assert.equal(typeof first.startedAt, 'number');
    assert.equal(first.startedAt, second.startedAt);
    assert.equal(first.startedAt % 1000, 0);
    assert.ok(first.startedAt <= Date.now());
  } finally {
    if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous;
  }
});
