import { basename } from 'node:path';
import type { ProcessInfo } from '../types.js';
export function isPi(info: ProcessInfo): boolean {
  const command = basename(info.command);
  if (command === 'pi') return true;
  if (command !== 'node' && command !== 'bun') return false;
  const entrypoint = info.args.trim().split(/\s+/)[1];
  return !!entrypoint && (basename(entrypoint) === 'pi' || /\/pi-coding-agent\/(?:dist\/(?:bundle\/)?cli\.js|src\/cli\.ts)$/.test(entrypoint));
}
export function isInteractive(info: ProcessInfo): boolean {
  return !/(?:^|\s)(?:-p|--print)(?:\s|=|$)/.test(info.args) && !/(?:^|\s)--mode(?:\s+|=)(?:rpc|json)(?:\s|$)/.test(info.args);
}
