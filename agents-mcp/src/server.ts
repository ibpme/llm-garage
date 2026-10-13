import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAgentTools } from './tools.js';

export function createAgentsServer(): McpServer {
  const server = new McpServer({ name: 'agents', version: '0.1.0' }, {
    instructions: 'Agent orchestration interface scaffold. All tools return NOT_IMPLEMENTED errors. Agent-task jobs belong to the current MCP session; no backend or job storage exists yet.',
  });
  registerAgentTools(server);
  return server;
}
