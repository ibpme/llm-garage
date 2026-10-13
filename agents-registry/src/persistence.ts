import { chmod, lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { AgentSnapshot, Health } from './types.js';
import { validateSnapshot } from './protocol.js';

export async function privateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || (process.getuid && info.uid !== process.getuid())) throw new Error('Registry directory must be an owned directory, not a symlink');
  await chmod(directory, 0o700);
}
async function replace(directory: string, name: string, contents: string): Promise<void> {
  const temporary = join(directory, `.${name}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, contents, { flag: 'wx', mode: 0o600 });
    await rename(temporary, join(directory, name));
  } finally { await rm(temporary, { force: true }); }
}
export async function persist(directory: string, agents: AgentSnapshot[], health: Health): Promise<void> {
  const lines = agents.map(agent => JSON.stringify(validateSnapshot(agent)));
  await replace(directory, 'agents.jsonl', lines.length ? `${lines.join('\n')}\n` : '');
  // Health follows the snapshot, but these two files are not a transactional pair.
  await replace(directory, 'registry-health.json', `${JSON.stringify(health, null, 2)}\n`);
}
