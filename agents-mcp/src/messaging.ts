import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { SendMessageInput } from './tools.js';
import { formatAgentMessage } from './message-format.js';

const execute = promisify(execFile);
const timestamp = z.number().int().nonnegative().safe();
const rowSchema = z.object({
  schemaVersion: z.literal(1), harness: z.enum(['pi', 'claude']), observedAt: timestamp,
  process: z.object({ pid: z.number().int().positive().safe(), startedAt: timestamp }),
  session: z.object({ name: z.string().max(256).optional(), id: z.string().optional(), cwd: z.string().optional(), mode: z.string() }),
  activity: z.object({ state: z.string() }),
  messaging: z.object({ transport: z.literal('unix'), protocol: z.literal('pi-listener-v2'), path: z.string().refine(p => isAbsolute(p) && !p.includes('\0') && Buffer.byteLength(p) <= 100), reportedAt: timestamp }).optional(),
});
type Agent = z.infer<typeof rowSchema>;
export interface MessagingOptions { registryDirectory?: string; callerAgentId?: string; callerPid?: number | null }
export class MessagingError extends Error {
  constructor(public code: string, message: string) { super(message); }
}
const fail = (code: string, message: string): never => { throw new MessagingError(code, message); };
const agentId = (a: Agent): string => {
  const identity = JSON.stringify([a.harness, a.process.pid, a.process.startedAt]);
  return `agt_${createHash('sha256').update(identity).digest('hex').slice(0, 16)}`;
};
const fresh = (time: number): boolean => time <= Date.now() + 5000 && Date.now() - time <= 20000;

export function createMessaging(options: MessagingOptions = {}) {
  const directory = resolve(options.registryDirectory ?? process.env.AGENTS_REGISTRY_DIR ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'agents-registry'));
  async function readAgents(): Promise<Agent[]> {
    try {
      const health = z.object({ version: z.literal(1), state: z.literal('running'), updatedAt: timestamp, lastSuccessfulProcessDiscoveryAt: timestamp }).parse(JSON.parse(await readFile(join(directory, 'registry-health.json'), 'utf8')));
      if (!fresh(health.updatedAt) || !fresh(health.lastSuccessfulProcessDiscoveryAt)) fail('REGISTRY_UNAVAILABLE', 'Registry health or process discovery is stale.');
      const rows = (await readFile(join(directory, 'agents.jsonl'), 'utf8')).split('\n').filter(line => line.trim()).map(line => rowSchema.parse(JSON.parse(line)));
      const ids = rows.map(agentId);
      if (new Set(ids).size !== ids.length) fail('REGISTRY_UNAVAILABLE', 'Registry contains duplicate identities.');
      return rows;
    } catch (error) {
      if (error instanceof MessagingError) throw error;
      return fail('REGISTRY_UNAVAILABLE', 'Registry is missing or invalid. Start the registry daemon and refresh discovery.');
    }
  }
  async function verify(agent: Agent): Promise<void> {
    try {
      const { stdout } = await execute('ps', ['-p', String(agent.process.pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 1000, maxBuffer: 4096, env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' } });
      const startedAt = Date.parse(`${stdout.trim().replace(/\s+/g, ' ')} UTC`);
      if (startedAt !== agent.process.startedAt) throw new Error('Process lifetime changed');
    } catch { fail('AGENT_UNAVAILABLE', `Agent ${agentId(agent)} exited or its process identity changed.`); }
  }
  function endpoint(agent: Agent): Agent['messaging'] {
    return agent.harness === 'pi' && agent.messaging && fresh(agent.messaging.reportedAt) ? agent.messaging : undefined;
  }
  async function identifyCaller(rows: Agent[]): Promise<Agent | undefined> {
    if (options.callerAgentId) {
      const caller = rows.find(a => agentId(a) === options.callerAgentId);
      if (caller) await verify(caller);
      return caller;
    }
    let pid = options.callerPid === undefined ? process.ppid : options.callerPid;
    const visited = new Set<number>();
    while (pid && pid > 1 && !visited.has(pid) && visited.size < 64) {
      visited.add(pid);
      const caller = rows.find(a => a.process.pid === pid);
      if (caller) { await verify(caller); return caller; }
      try {
        const { stdout } = await execute('ps', ['-p', String(pid), '-o', 'ppid='], { encoding: 'utf8', timeout: 1000, maxBuffer: 4096 });
        pid = Number(stdout.trim());
      } catch { return undefined; }
    }
    return undefined;
  }
  return {
    async listAgents() {
      const rows = await readAgents();
      const live = await Promise.all(rows.map(async a => { try { await verify(a); return a; } catch { return undefined; } }));
      const self = await identifyCaller(rows).catch(() => undefined);
      return { self_agent_id: self ? agentId(self) : null, agents: live.filter((a): a is Agent => !!a).map(a => ({ agent_id: agentId(a), name: a.session.name ?? agentId(a), harness: a.harness, session_id: a.session.id ?? null, cwd: a.session.cwd ?? null, activity: a.activity.state, can_receive_messages: !!endpoint(a) })) };
    },
    async sendMessage(input: SendMessageInput) {
      const rows = await readAgents();
      const recipient = rows.find(a => agentId(a) === input.agent_id) ?? fail('AGENT_NOT_FOUND', 'Recipient agent_id was not found. Refresh list_agents.');
      const sender = await identifyCaller(rows) ?? fail('CALLER_UNAVAILABLE', 'Caller identity could not be determined. Configure the MCP client identity or launch stdio from a registered agent.');
      await Promise.all([verify(recipient), verify(sender)]);
      const destination = endpoint(recipient) ?? fail('MESSAGING_UNAVAILABLE', 'Recipient has no fresh messaging endpoint.');
      const messageId = input.message_id ?? randomUUID();
      const content = formatAgentMessage(messageId, { id: agentId(sender), ...(sender.session.name ? { name: sender.session.name } : {}), harness: sender.harness }, input.message);
      const envelope = { version: 2, type: 'message', id: messageId, content, deliverAs: input.deliver_as ?? 'followUp' };
      const frame = Buffer.from(JSON.stringify(envelope) + '\n');
      if (frame.length > 65536) fail('MESSAGE_TOO_LARGE', 'Encoded message exceeds the 64 KiB listener limit.');
      const status = await deliver(destination.path, frame, messageId);
      return { message_id: messageId, agent_id: input.agent_id, sender_id: agentId(sender), status };
    },
  };
}

function deliver(path: string, frame: Buffer, id: string): Promise<'accepted' | 'duplicate'> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let response = Buffer.alloc(0);
    let settled = false;
    const timer = setTimeout(() => finish(new MessagingError('DELIVERY_UNKNOWN', `ACK timeout; delivery is unknown. Retry message_id ${id} with the same payload.`)), 6000);
    function finish(error?: Error, status?: 'accepted' | 'duplicate'): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer); socket.destroy();
      if (error) reject(error); else resolve(status!);
    }
    socket.on('connect', () => socket.write(frame));
    socket.on('error', () => finish(new MessagingError('DELIVERY_UNKNOWN', `Socket failure; delivery is unknown. Retry message_id ${id} with the same payload.`)));
    socket.on('close', () => finish(new MessagingError('DELIVERY_UNKNOWN', `Connection closed before ACK. Retry message_id ${id} with the same payload.`)));
    socket.on('data', chunk => {
      response = Buffer.concat([response, chunk]);
      if (response.length > 65536) { finish(new MessagingError('DELIVERY_UNKNOWN', `Oversized ACK for message_id ${id}.`)); return; }
      const newline = response.indexOf(10);
      if (newline < 0) return;
      try {
        const ack = z.object({ version: z.literal(2), type: z.literal('ack'), id: z.string().nullable(), ok: z.boolean(), status: z.enum(['accepted', 'duplicate']).optional(), error: z.string().optional() }).parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(response.subarray(0, newline))));
        if (!ack.ok && (ack.id === null || ack.id === id)) { finish(new MessagingError('MESSAGE_REJECTED', ack.error ?? 'Listener rejected message.')); return; }
        if (ack.id !== id || !ack.ok || !ack.status) throw new Error('Invalid ACK');
        finish(undefined, ack.status);
      } catch { finish(new MessagingError('DELIVERY_UNKNOWN', `Invalid ACK; delivery is unknown for message_id ${id}.`)); }
    });
  });
}
