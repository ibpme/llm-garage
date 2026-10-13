#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const expand = path => path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
const quote = text => `'${text.replace(/'/g, "'\\''")}'`;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
function atomicWrite(path, data, mode = 0o600) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(data, null, 2) + '\n', { mode, flag: 'wx' });
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
}

try {
  let settings = join(expand(process.env.CLAUDE_CONFIG_DIR || '~/.claude'), 'settings.json');
  let uninstall = false;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--uninstall') uninstall = true;
    else if (args[i] === '--settings' && args[i + 1]) settings = expand(args[++i]);
    else throw new Error('Usage: install-statusline.mjs [--settings <file>] [--uninstall]');
  }
  settings = resolve(settings);
  if (existsSync(settings) && lstatSync(settings).isSymbolicLink()) throw new Error('Settings is a symlink; install against its source file instead.');
  const originalText = existsSync(settings) ? readFileSync(settings, 'utf8') : undefined;
  const config = originalText === undefined ? {} : JSON.parse(originalText);
  if (!object(config)) throw new Error('Settings must be a JSON object.');
  const stateFile = `${settings}.agents-registry-statusline.json`;
  if (existsSync(stateFile) && lstatSync(stateFile).isSymbolicLink()) throw new Error('Installation backup is a symlink; refusing to modify settings.');
  const hasState = existsSync(stateFile);
  const state = hasState ? JSON.parse(readFileSync(stateFile, 'utf8')) : undefined;
  if (hasState && (!object(state) || state.version !== 1 || typeof state.installedCommand !== 'string' || !state.installedCommand.trim() ||
      !object(state.originalStatusLine) || state.originalStatusLine.type !== 'command' ||
      typeof state.originalStatusLine.command !== 'string' || !state.originalStatusLine.command.trim())) {
    throw new Error('Invalid status-line installation backup; refusing to modify settings.');
  }
  if (uninstall && !state) {
    console.log('Claude registry status-line publisher is not installed.');
  } else {
    if (state && config.statusLine?.command !== state.installedCommand &&
        config.statusLine?.command !== state.originalStatusLine.command) {
      throw new Error('Status-line command changed since installation; refusing to overwrite it.');
    }
    if (!state && (config.statusLine?.type !== 'command' ||
        typeof config.statusLine.command !== 'string' || !config.statusLine.command.trim())) {
      throw new Error('Configure an existing command status line before installing this publisher.');
    }
    if (state && config.statusLine?.type !== 'command') throw new Error('Status-line type changed since installation; refusing to overwrite it.');
    const originalStatusLine = state?.originalStatusLine ?? config.statusLine;
    const installedCommand = state?.installedCommand ?? `${quote(process.execPath)} ${quote(join(dirname(fileURLToPath(import.meta.url)), 'statusline-wrapper.mjs'))} --command ${quote(originalStatusLine.command)}`;
    // Save recovery information first; repeated installation can finish an interrupted write.
    if (!uninstall && !state) atomicWrite(stateFile, { version: 1, originalStatusLine, installedCommand });
    config.statusLine = { ...config.statusLine, command: uninstall ? originalStatusLine.command : installedCommand };
    const currentText = existsSync(settings) ? readFileSync(settings, 'utf8') : undefined;
    if (currentText !== originalText) throw new Error('Settings changed during installation; refusing to overwrite them.');
    atomicWrite(settings, config, existsSync(settings) ? statSync(settings).mode & 0o777 : 0o600);
    if (uninstall) rmSync(stateFile);
    console.log(`${uninstall ? 'Removed' : 'Installed'} Claude registry status-line publisher: ${settings}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
