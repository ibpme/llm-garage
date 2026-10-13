import { createConnection } from 'node:net';
import { join } from 'node:path';
import type { Response } from './types.js';
import { MAX_MESSAGE_BYTES } from './protocol.js';

export async function request(directory: string, message: unknown, timeoutMs = 1000): Promise<Response> {
  const input = `${JSON.stringify(message)}\n`;
  if (Buffer.byteLength(input) > MAX_MESSAGE_BYTES) throw new Error('Message exceeds size limit');
  return new Promise((resolve, reject) => {
    const socket = createConnection(join(directory, 'registry.sock'));
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const timer = setTimeout(() => finish(new Error('Registry request timed out')), timeoutMs);
    const finish = (error?: Error, response?: Response): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); socket.destroy();
      if (error) reject(error); else resolve(response!);
    };
    socket.on('error', error => finish(error));
    socket.on('connect', () => socket.write(input));
    socket.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 256 * 1024) { finish(new Error('Registry response exceeds size limit')); return; }
      chunks.push(chunk);
      if (!chunk.includes(10)) return;
      try {
        const response: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8').split('\n')[0]!);
        if (!response || typeof response !== 'object' || typeof (response as Response).ok !== 'boolean') throw new Error('Invalid registry response');
        finish(undefined, response as Response);
      } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
    });
    socket.on('end', () => finish(new Error('Registry closed without a response')));
  });
}
