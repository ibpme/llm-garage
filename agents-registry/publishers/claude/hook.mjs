#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { basename, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 4096 ? value : undefined;

function activity(data) {
  const event = data.hook_event_name;
  switch (event) {
    case 'SessionStart': case 'Stop':
      return { state: 'idle', rawState: event };
    case 'SessionEnd':
      return { state: 'unknown', rawState: event };
    case 'PreToolUse':
      if (data.tool_name === 'AskUserQuestion') return { state: 'waiting', rawState: event, waitingFor: 'user_input' };
      return { state: 'busy', rawState: event };
    case 'UserPromptSubmit': case 'PostToolUse': case 'PostToolUseFailure':
      return { state: 'busy', rawState: event };
    case 'PermissionRequest':
      return { state: 'waiting', rawState: event, waitingFor: 'permission' };
    case 'Notification':
      if (data.notification_type === 'permission_prompt') return { state: 'waiting', rawState: event, waitingFor: 'permission' };
      if (data.notification_type === 'idle_prompt') return { state: 'waiting', rawState: event, waitingFor: 'idle_prompt' };
      return undefined;
    default:
      return undefined;
  }
}

function isClaude(info) {
  if (basename(info.command) === 'claude') return true;
  // npm installations run Claude's entrypoint under Node, not a native claude binary.
  return /^node(?:js)?$/.test(basename(info.command)) &&
    /^\S+\s+\S*\/node_modules\/@anthropic-ai\/claude-code\/cli\.js(?:\s|$)/.test(info.args);
}

async function identify(parseProcesses, fields) {
  const { stdout } = await execute('ps', ['-axo', fields], {
    encoding: 'utf8', timeout: 1000, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' },
  });
  const processes = parseProcesses(stdout);
  const seen = new Set([process.pid]);
  let pid = processes.get(process.pid)?.ppid;
  while (pid > 1 && !seen.has(pid)) {
    seen.add(pid);
    const info = processes.get(pid);
    if (!info) return undefined;
    if (isClaude(info)) return { pid: info.pid, startedAt: info.startedAt };
    pid = info.ppid;
  }
  return undefined;
}

try {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    // Tool payloads can exceed the registry's message limit; only small metadata is forwarded.
    if (bytes > 8 * 1024 * 1024) break;
    chunks.push(chunk);
  }
  if (bytes <= 8 * 1024 * 1024) {
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (data && typeof data === 'object' && !Array.isArray(data) && !data.agent_id) {
      const state = activity(data);
      if (state) {
        // Keep even a missing/unbuilt daemon dependency from breaking Claude's hook.
        const [{ request }, { parseProcesses, PS_FIELDS }] = await Promise.all([
          import('../../dist/client.js'), import('../../dist/discovery/processes.js'),
        ]);
        const reportedAt = Date.now();
        const identity = await identify(parseProcesses, PS_FIELDS);
        if (identity) {
          const session = {};
          for (const [target, source] of [['id', 'session_id'], ['file', 'transcript_path'], ['cwd', 'cwd']]) {
            const value = text(data[source]);
            if (value !== undefined) session[target] = value;
          }
          const directory = resolve(process.env.AGENTS_REGISTRY_DIR ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'agents-registry'));
          await request(directory, {
            version: 1, type: 'publish', harness: 'claude', source: 'claude-hook',
            process: identity, reportedAt,
            patch: { ...(Object.keys(session).length ? { session } : {}), activity: state },
          }, 500);
        }
      }
    }
  }
} catch { /* Best-effort telemetry must never output hook decisions or interrupt Claude. */ }
