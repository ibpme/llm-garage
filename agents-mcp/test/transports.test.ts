import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { request } from 'node:http';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startHttpServer } from '../src/http.js';

const cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

test('stdio CLI negotiates MCP and reserves stdout for protocol messages', async t => {
  const transport = new StdioClientTransport({ command: process.execPath, args: [cliPath], stderr: 'pipe' });
  const client = new Client({ name: 'stdio-test', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(transport);
  assert.equal(client.getServerVersion()?.name, 'agents');
  assert.equal((await client.listTools()).tools.length, 6);
  assert.equal((await client.callTool({ name: 'list_agent_tasks', arguments: {} })).isError, true);
});

test('CLI documents both transports and rejects invalid options without stdout noise', () => {
  const help = spawnSync(process.execPath, [cliPath, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /stdio/);
  assert.match(help.stdout, /http/);
  for (const args of [['--transport', 'sse'], ['--port', 'nope'], ['--port', '65536'], ['--unknown']]) {
    const result = spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /Error/);
  }
});

test('HTTP creates separate MCP sessions and removes a terminated session', async t => {
  const runtime = await startHttpServer(0);
  t.after(runtime.close);
  const clients = [new Client({ name: 'http-a', version: '1' }), new Client({ name: 'http-b', version: '1' })];
  const transports = clients.map(() => new StreamableHTTPClientTransport(new URL(runtime.url)));
  t.after(async () => { for (const client of clients) await client.close(); });
  for (let i = 0; i < clients.length; i++) {
    await clients[i]!.connect(transports[i]!);
    assert.equal((await clients[i]!.listTools()).tools.length, 6);
    assert.equal((await clients[i]!.callTool({ name: 'list_agent_tasks', arguments: {} })).isError, true);
  }
  assert.ok(transports[0]!.sessionId);
  assert.notEqual(transports[0]!.sessionId, transports[1]!.sessionId);
  const oldSession = transports[0]!.sessionId!;
  await transports[0]!.terminateSession();
  const expired = await fetch(runtime.url, { headers: {
    'mcp-session-id': oldSession, accept: 'text/event-stream',
  } });
  assert.equal(expired.status, 404);
  assert.equal((await clients[1]!.listTools()).tools.length, 6);
});

test('HTTP validates session routing, Origin, and Host before serving MCP', async t => {
  const runtime = await startHttpServer(0);
  t.after(runtime.close);
  const post = (headers: Record<string, string> = {}, body: unknown = { jsonrpc: '2.0', id: 1, method: 'tools/list' }) => fetch(runtime.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(body),
  });
  assert.equal((await post()).status, 400);
  assert.equal((await post({ 'mcp-session-id': 'unknown' })).status, 404);
  assert.equal((await post({ origin: 'https://evil.example' })).status, 403);
  assert.equal((await post({ origin: 'null' })).status, 403);
  // Node fetch rewrites Host; use the HTTP client to send a real hostile header.
  const hostileHostStatus = await new Promise<number | undefined>((resolve, reject) => {
    const req = request(runtime.url, { method: 'POST', headers: { host: 'evil.example' } }, res => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(hostileHostStatus, 403);
  assert.equal((await post({ origin: new URL(runtime.url).origin })).status, 400);
  assert.equal((await fetch(runtime.url, { method: 'DELETE' })).status, 400);
  assert.equal((await fetch(runtime.url, { method: 'PUT' })).status, 405);
});

test('HTTP malformed JSON is a client error rather than an internal server failure', async t => {
  const runtime = await startHttpServer(0);
  t.after(runtime.close);
  const response = await fetch(runtime.url, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{broken',
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.message, 'Invalid JSON body');
});
