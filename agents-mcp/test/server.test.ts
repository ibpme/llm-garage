import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createAgentsServer } from '../src/server.js';

const calls = [
  { name: 'spawn_agent_task', arguments: { agent_type: 'any-backend', prompt: 'Review this', cwd: '/tmp' } },
  { name: 'spawn_agent', arguments: { agent_type: 'any-backend', prompt: 'Start here' } },
  { name: 'list_agent_tasks', arguments: {} },
  ...['check', 'fetch_answer', 'cancel'].map(action => ({
    name: 'agent_task', arguments: { action, task_id: 'task-1' },
  })),
];

async function connect() {
  const server = createAgentsServer();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { server, client, close: async () => { await client.close(); await server.close(); } };
}

test('discovery exposes the agents interface and session-scoped job descriptions', async t => {
  const connection = await connect();
  t.after(connection.close);
  assert.equal(connection.client.getServerVersion()?.name, 'agents');
  assert.ok(connection.client.getServerCapabilities()?.tools);
  assert.equal(connection.client.getServerCapabilities()?.tasks, undefined);
  const { tools } = await connection.client.listTools();
  assert.deepEqual(tools.map(tool => tool.name).sort(), [
    'agent_task', 'list_agent_tasks', 'list_agents', 'send_message', 'spawn_agent', 'spawn_agent_task',
  ]);
  for (const tool of tools) {
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.ok(tool.description);
    if (tool.name === 'agent_task' || tool.name === 'list_agent_tasks') {
      assert.match(tool.description!, /session/i);
    }
  }
  assert.deepEqual(tools.find(tool => tool.name === 'agent_task')?.inputSchema.required, ['action', 'task_id']);
  assert.equal(tools.find(tool => tool.name === 'list_agent_tasks')?.annotations?.readOnlyHint, true);
  assert.equal(tools.find(tool => tool.name === 'agent_task')?.annotations?.readOnlyHint, false);
});

for (const call of calls) {
  test(`${call.name} ${'action' in call.arguments ? call.arguments.action : ''} returns a tool error, not a fake success`, async t => {
    const connection = await connect();
    t.after(connection.close);
    const result = await connection.client.callTool(call);
    assert.equal(result.isError, true);
    assert.deepEqual(result.structuredContent, { error: { code: 'NOT_IMPLEMENTED', tool: call.name } });
    assert.match(JSON.stringify(result.content), /not implemented/i);
  });
}

for (const call of [
  { name: 'send_message', arguments: { agent_id: '', message: 'hello' } },
  { name: 'send_message', arguments: { agent_id: 'agent' } },
  { name: 'spawn_agent_task', arguments: { agent_type: 'pi', prompt: '   ' } },
  { name: 'spawn_agent', arguments: { agent_type: 'pi', cwd: '' } },
  { name: 'list_agent_tasks', arguments: { session_id: 'other-session' } },
  { name: 'agent_task', arguments: { action: 'list', task_id: 'task-1' } },
  { name: 'agent_task', arguments: { action: 'cancel' } },
]) {
  test(`rejects invalid ${call.name} arguments ${JSON.stringify(call.arguments)}`, async t => {
    const connection = await connect();
    t.after(connection.close);
    const result = await connection.client.callTool(call);
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /validation/i);
    assert.equal(result.structuredContent, undefined);
  });
}
