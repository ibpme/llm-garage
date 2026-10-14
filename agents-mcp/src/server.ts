import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAgentTools } from './tools.js';
import type { MessagingOptions } from './messaging.js';

export function createAgentsServer(options: MessagingOptions = {}): McpServer {
  const server = new McpServer({ name: 'agents', version: '0.1.0' }, {
    instructions: 'Use list_agents to discover agent IDs and send_message to communicate. Spawn and task tools remain NOT_IMPLEMENTED. Agent-task jobs belong to the current MCP session; no backend or job storage exists yet.',
  });
  registerAgentTools(server, options);
  return server;
}
