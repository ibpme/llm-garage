#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const events = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'Notification', 'Stop', 'SessionEnd'];
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
    else throw new Error('Usage: install.mjs [--settings <file>] [--uninstall]');
  }
  settings = resolve(settings);
  if (existsSync(settings) && lstatSync(settings).isSymbolicLink()) throw new Error('Settings is a symlink; install against its source file instead.');
  const originalText = existsSync(settings) ? readFileSync(settings, 'utf8') : undefined;
  const config = originalText === undefined ? {} : JSON.parse(originalText);
  if (!object(config) || (config.hooks !== undefined && !object(config.hooks))) throw new Error('Settings and hooks must be JSON objects.');
  for (const event of events) {
    if (config.hooks?.[event] !== undefined && !Array.isArray(config.hooks[event])) throw new Error(`hooks.${event} must be an array.`);
  }
  const stateFile = `${settings}.agents-registry-hooks.json`;
  const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : undefined;
  if (state && (state.version !== 1 || typeof state.command !== 'string' || !Array.isArray(state.originalEvents) || typeof state.hadHooks !== 'boolean')) throw new Error('Invalid hook installation backup; refusing to modify settings.');
  if (uninstall && !state) {
    console.log('Claude registry hooks are not installed.');
  } else {
    const command = state?.command ?? `${quote(process.execPath)} ${quote(join(dirname(fileURLToPath(import.meta.url)), 'hook.mjs'))}`;
    const hooks = config.hooks ?? {};
    const originalEvents = state?.originalEvents ?? Object.keys(hooks);
    const hadHooks = state?.hadHooks ?? config.hooks !== undefined;
    for (const event of events) {
      if (uninstall) {
        if (!hooks[event]) continue;
        hooks[event] = hooks[event].flatMap(group => {
          if (!Array.isArray(group?.hooks)) return [group];
          const remaining = group.hooks.filter(handler => handler?.type !== 'command' || handler.command !== command);
          if (remaining.length === group.hooks.length) return [group];
          return remaining.length ? [{ ...group, hooks: remaining }] : [];
        });
        if (!hooks[event].length && !originalEvents.includes(event)) delete hooks[event];
      } else {
        const groups = hooks[event] ?? [];
        if (!groups.some(group => group?.hooks?.some(handler => handler?.type === 'command' && handler.command === command))) {
          groups.push({ hooks: [{ type: 'command', command, timeout: 2 }] });
        }
        hooks[event] = groups;
      }
    }
    if (!uninstall || hadHooks || Object.keys(hooks).length) config.hooks = hooks;
    else delete config.hooks;
    // Save recovery information before touching settings; a repeated install completes a pending write.
    if (!uninstall && !state) atomicWrite(stateFile, { version: 1, command, originalEvents, hadHooks, originalSettings: originalText ?? null });
    const currentText = existsSync(settings) ? readFileSync(settings, 'utf8') : undefined;
    if (currentText !== originalText) throw new Error('Settings changed during installation; refusing to overwrite them.');
    atomicWrite(settings, config, existsSync(settings) ? statSync(settings).mode & 0o777 : 0o600);
    if (uninstall) rmSync(stateFile);
    console.log(`${uninstall ? 'Removed' : 'Installed'} Claude registry hooks: ${settings}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
