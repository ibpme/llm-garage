import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { Request, Response } from 'express';
import { createAgentsServer } from './server.js';

interface Session {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
}

function errorResponse(res: Response, status: number, message: string, code = -32000): void {
  res.status(status).json({ jsonrpc: '2.0', error: { code, message }, id: null });
}

export async function startHttpServer(port = 3000): Promise<{ url: string; close: () => Promise<void> }> {
  const app = createMcpExpressApp({ host: '127.0.0.1' });
  const sessions = new Map<string, Session>();
  const activeServers = new Set<McpServer>();
  let stopping = false;

  app.use('/mcp', (req, res, next) => {
    // Non-browser clients omit Origin. Browser requests must be same-origin.
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== `http://${req.headers.host}`) {
      errorResponse(res, 403, 'Forbidden Origin');
      return;
    }
    if (stopping) {
      errorResponse(res, 503, 'Server is shutting down');
      return;
    }
    next();
  });

  const handle = async (req: Request, res: Response): Promise<void> => {
    const sessionId = req.headers['mcp-session-id'];
    if (sessionId !== undefined) {
      if (typeof sessionId !== 'string' || !sessions.has(sessionId)) {
        errorResponse(res, 404, 'Session not found');
        return;
      }
      await sessions.get(sessionId)!.transport.handleRequest(req, res, req.body);
      return;
    }
    if (req.method !== 'POST' || !isInitializeRequest(req.body)) {
      errorResponse(res, 400, 'Initialize first or supply Mcp-Session-Id');
      return;
    }

    const callerId = req.headers['x-agent-id'];
    if (callerId !== undefined && (typeof callerId !== 'string' || callerId.length > 256 || !callerId.trim())) {
      errorResponse(res, 400, 'Invalid X-Agent-Id');
      return;
    }
    const server = createAgentsServer({ callerPid: null, ...(typeof callerId === 'string' ? { callerAgentId: callerId } : {}) });
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      onsessioninitialized: id => { sessions.set(id, { server, transport }); },
    });
    activeServers.add(server);
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
      activeServers.delete(server);
    };
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } finally {
      // Rejected initialization must not leave an orphaned server/transport.
      if (!transport.sessionId) {
        await server.close();
        activeServers.delete(server);
      }
    }
  };

  app.post('/mcp', handle);
  app.get('/mcp', handle);
  app.delete('/mcp', handle);
  app.all('/mcp', (_req, res) => {
    res.setHeader('Allow', 'GET, POST, DELETE');
    errorResponse(res, 405, 'Method not allowed');
  });
  app.use((error: unknown, _req: Request, res: Response, _next: unknown) => {
    if (res.headersSent) {
      res.end();
      return;
    }
    if (typeof error === 'object' && error !== null && 'type' in error) {
      if (error.type === 'entity.parse.failed') {
        errorResponse(res, 400, 'Invalid JSON body', -32700);
        return;
      }
      if (error.type === 'entity.too.large') {
        errorResponse(res, 413, 'Request body too large');
        return;
      }
    }
    console.error('agents HTTP request failed:', error);
    errorResponse(res, 500, 'Internal server error');
  });

  const listener = createServer(app);
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(port, '127.0.0.1', () => {
      listener.off('error', reject);
      resolve();
    });
  });
  const address = listener.address();
  if (!address || typeof address === 'string') throw new Error('No HTTP address');

  let closing: Promise<void> | undefined;
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    close: () => closing ??= (async () => {
      stopping = true;
      // Stop accepting requests before closing sessions and their SSE streams.
      const closed = new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
      const results = await Promise.allSettled([...activeServers].map(server => server.close()));
      listener.closeAllConnections();
      await closed;
      sessions.clear();
      activeServers.clear();
      const failure = results.find(result => result.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
    })(),
  };
}
