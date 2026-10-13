#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { startHttpServer } from './http.js';
import { createAgentsServer } from './server.js';

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    transport: { type: 'string', default: 'stdio' },
    port: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  } });
  if (values.help) {
    process.stdout.write('Usage: agents-mcp [--transport stdio|http] [--port 3000]\n\nstdio is the default. HTTP binds to 127.0.0.1 and serves /mcp.\n');
    return;
  }
  if (values.transport !== 'stdio' && values.transport !== 'http') throw new Error('Invalid transport; expected stdio or http');
  const port = Number(values.port ?? '3000');
  if (!/^\d+$/.test(values.port ?? '3000') || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Port must be an integer between 1 and 65535');
  }
  if (values.port !== undefined && values.transport !== 'http') throw new Error('--port requires --transport http');

  let close: () => Promise<void>;
  if (values.transport === 'http') {
    const runtime = await startHttpServer(port);
    close = runtime.close;
    console.error(`agents MCP listening on ${runtime.url}`);
  } else {
    const server = createAgentsServer();
    await server.connect(new StdioServerTransport());
    close = () => server.close();
    process.stdin.once('end', () => { void shutdown(); });
  }

  let shuttingDown = false;
  async function shutdown(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    const timeout = setTimeout(() => process.exit(1), 5000);
    timeout.unref();
    try {
      await close();
      process.exit(0);
    } catch (error) {
      console.error('Error shutting down agents MCP:', error);
      process.exit(1);
    }
  }
  process.once('SIGINT', () => { void shutdown(); });
  process.once('SIGTERM', () => { void shutdown(); });
}

main().catch((error: unknown) => {
  console.error('Error starting agents MCP:', error);
  process.exitCode = 1;
});
