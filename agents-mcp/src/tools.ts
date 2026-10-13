import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

const nonBlank = z.string().min(1).regex(/\S/, 'Must contain a non-whitespace character');
const spawnFields = {
  agent_type: nonBlank.describe('Backend-neutral agent type or provider identifier.'),
  cwd: nonBlank.optional().describe('Working directory; defaults to the server working directory when implemented.'),
};

export const sendMessageSchema = z.strictObject({
  agent_id: nonBlank.describe('Opaque identifier of the recipient agent.'),
  message: nonBlank.describe('Message to deliver to the agent.'),
});
export const spawnAgentTaskSchema = z.strictObject({
  ...spawnFields,
  prompt: nonBlank.describe('Task instructions for a non-interactive agent.'),
});
export const spawnAgentSchema = z.strictObject({
  ...spawnFields,
  prompt: nonBlank.optional().describe('Optional initial instructions for the interactive agent.'),
});
export const listAgentTasksSchema = z.strictObject({});
export const agentTaskSchema = z.strictObject({
  action: z.enum(['check', 'fetch_answer', 'cancel']).describe('Inspect status, fetch the answer, or request cancellation.'),
  task_id: nonBlank.describe('Opaque task identifier returned by spawn_agent_task in this MCP session.'),
});

export type SendMessageInput = z.infer<typeof sendMessageSchema>;
export type SpawnAgentTaskInput = z.infer<typeof spawnAgentTaskSchema>;
export type SpawnAgentInput = z.infer<typeof spawnAgentSchema>;
export type ListAgentTasksInput = z.infer<typeof listAgentTasksSchema>;
export type AgentTaskInput = z.infer<typeof agentTaskSchema>;

function notImplemented(tool: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: `${tool} is not implemented. No message, agent, or job was created or modified.` }],
    structuredContent: { error: { code: 'NOT_IMPLEMENTED', tool } },
  };
}

export function registerAgentTools(server: McpServer): void {
  server.registerTool('send_message', {
    title: 'Send a message to an agent',
    description: 'Send a message to another agent identified by agent_id. Interface only; not implemented.',
    inputSchema: sendMessageSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async () => notImplemented('send_message'));

  server.registerTool('spawn_agent_task', {
    title: 'Spawn a non-interactive agent task',
    description: 'Start a non-interactive agent job owned by the current MCP session. Interface only; not implemented.',
    inputSchema: spawnAgentTaskSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async () => notImplemented('spawn_agent_task'));

  server.registerTool('spawn_agent', {
    title: 'Spawn an interactive agent',
    description: 'Start an interactive agent session, optionally with an initial prompt. Interface only; not implemented.',
    inputSchema: spawnAgentSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async () => notImplemented('spawn_agent'));

  server.registerTool('list_agent_tasks', {
    title: 'List agent tasks',
    description: 'List jobs spawned by spawn_agent_task in the current MCP session only. Interface only; not implemented.',
    inputSchema: listAgentTasksSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => notImplemented('list_agent_tasks'));

  server.registerTool('agent_task', {
    title: 'Manage an agent task',
    description: 'Check status, fetch the answer of, or cancel a job spawned by spawn_agent_task in the current MCP session only. Interface only; not implemented.',
    inputSchema: agentTaskSchema,
    // A single tool includes cancellation, so annotations must cover the mutating action.
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async () => notImplemented('agent_task'));
}
