import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { AgentSnapshot, Message } from './types.js';

const ajv = new Ajv2020({ allErrors: true });
const schema = (name: string): object => JSON.parse(readFileSync(new URL(`../schemas/${name}.schema.json`, import.meta.url), 'utf8')) as object;
const messageValidator = ajv.compile<Message>(schema('publisher-message'));
const snapshotValidator = ajv.compile<AgentSnapshot>(schema('agent-snapshot'));

export function validateMessage(value: unknown): Message {
  if (!messageValidator(value)) throw new Error(`Invalid message: ${ajv.errorsText(messageValidator.errors)}`);
  return value;
}
export function validateSnapshot(value: unknown): AgentSnapshot {
  if (!snapshotValidator(value)) throw new Error(`Invalid snapshot: ${ajv.errorsText(snapshotValidator.errors)}`);
  return value;
}
export const MAX_MESSAGE_BYTES = 64 * 1024;
