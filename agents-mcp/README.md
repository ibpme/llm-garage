# agents MCP server

TypeScript interface scaffold for a backend-neutral MCP server named `agents`.
Uses the official `@modelcontextprotocol/sdk` (stable v1) for initialization,
protocol negotiation, tool discovery, schema validation, and transports.

**No agent functionality is implemented.** Valid calls return MCP tool results
with `isError: true`, a human-readable message, and
`structuredContent: { error: { code: "NOT_IMPLEMENTED", tool: "<tool name>" } }`.
Nothing sends messages, launches processes, creates jobs, or fabricates answers.
Success output schemas are intentionally deferred until the backend contract is
implemented. Invalid inputs are rejected by the SDK before reaching a stub.

## Development

Requires Node.js 22+ and npm.

```bash
cd agents-mcp
npm ci
npm run build
npm run typecheck
npm test
```

```bash
# Default: stdio (stdout is exclusively MCP JSON-RPC)
node dist/cli.js
node dist/cli.js --transport stdio

# Stateful Streamable HTTP, loopback-only
node dist/cli.js --transport http --port 3000
# Endpoint: http://127.0.0.1:3000/mcp

# Run from source
npm run dev -- --transport http --port 3000
```

For stdio clients, launch `node` directly rather than `npm start`, whose npm
banner can pollute the protocol channel. Diagnostics go to stderr. SIGINT,
SIGTERM, and stdio EOF trigger cleanup; signal shutdown has a five-second
fallback deadline. `--help` prints usage and exits without starting MCP.

## Tool interface

All input objects reject unknown fields. Required strings must contain at least
one non-whitespace character. Prompts and messages are preserved, not trimmed.
Agent IDs, task IDs, and agent types are opaque, backend-neutral strings.

| Tool | Required arguments | Optional arguments | Intended operation |
| --- | --- | --- | --- |
| `send_message` | `agent_id`, `message` | — | Send a message to another agent |
| `spawn_agent_task` | `agent_type`, `prompt` | `cwd` | Launch a non-interactive job owned by this session |
| `spawn_agent` | `agent_type` | `prompt`, `cwd` | Launch an interactive agent |
| `list_agent_tasks` | — | — | List this session's non-interactive jobs |
| `agent_task` | `action`, `task_id` | — | Check, fetch the answer of, or cancel this session's job |

`agent_task.action` is `check`, `fetch_answer`, or `cancel`. Listing is separate
because it does not require a task ID. Interactive spawning permits an omitted
prompt so a future backend can open an empty interactive session. `cwd` is an
opaque path string; path existence/permissions are future backend concerns.
When implemented, omission will mean the server's working directory.

Examples of `tools/call` parameters:

```json
{ "name": "send_message", "arguments": { "agent_id": "reviewer", "message": "Please review the changes." } }
```

```json
{ "name": "spawn_agent_task", "arguments": { "agent_type": "provider-name", "prompt": "Review the changes.", "cwd": "/path/to/repo" } }
```

```json
{ "name": "spawn_agent", "arguments": { "agent_type": "provider-name" } }
```

```json
{ "name": "list_agent_tasks", "arguments": {} }
```

```json
{ "name": "agent_task", "arguments": { "action": "fetch_answer", "task_id": "task-id" } }
```

These jobs are **application-level agent jobs**, not MCP's experimental Tasks
extension. The server does not advertise protocol Tasks, resources, prompts,
logging, or any other unimplemented capability. Tool annotations describe the
intended operation; `agent_task` is conservatively mutating/destructive because
it includes cancellation. Annotations are client hints, not access controls.

## Sessions and HTTP safety

- One server instance per stdio connection or initialized HTTP session.
- HTTP initialization issues a cryptographically random `Mcp-Session-Id`.
  Subsequent POST, GET (SSE), and DELETE requests route to that session's SDK
  transport. DELETE terminates the session. Unknown IDs return HTTP 404;
  missing IDs on non-initialization requests return HTTP 400.
- Job tools accept no caller-supplied session selector. Future storage must
  scope task lookup to the owning server/session; transport isolation alone
  does **not** implement job ownership checks. No storage exists yet.
- HTTP binds only to `127.0.0.1`. SDK middleware validates Host against loopback
  hostnames. Present Origin headers must exactly match `http://<Host>`; absent
  Origin is permitted for native MCP clients. No cross-origin CORS is enabled.
- The SDK handles Accept headers, protocol-version validation, JSON-RPC
  framing, and SSE. Unsupported endpoint methods return 405. Malformed JSON
  and oversized bodies return client errors. Session cleanup closes active
  transports and HTTP connections.
- There is no authentication, persistence, idle-session expiry, SSE replay
  store, or remote deployment configuration. Do not expose this server through
  a public bind/proxy without designing authentication, authorization, origin
  policy, and resource limits first. HTTP session IDs are not authentication.
- MCP session means the transport session, not a provider's conversation ID.
  Reconnection with a new MCP session will not automatically recover jobs.

## Client configuration

Typical stdio configuration (replace the absolute path):

```json
{
  "mcpServers": {
    "agents": {
      "command": "node",
      "args": ["/absolute/path/to/llm-garage/agents-mcp/dist/cli.js"]
    }
  }
}
```

For HTTP, start the server separately and configure your client's Streamable
HTTP connection to `http://127.0.0.1:3000/mcp`. Client-specific config formats
vary. This scaffold does not modify any synced/global MCP configuration.

## Layout

```text
src/cli.ts       CLI options, transport selection, process shutdown
src/server.ts    fresh MCP server factory and identity
src/tools.ts     exported Zod input schemas/types, registration, error stubs
src/http.ts      stateful Streamable HTTP routing and lifecycle
test/            real MCP client integration tests (in-memory, stdio, HTTP)
```

Transport code is independent of tool behavior. Implement handlers in
`src/tools.ts` (or delegate from there) without reimplementing MCP framing.
Tests exercise discovery, strict validation, stub results, session routing,
HTTP safety, and real subprocess stdio communication.

References: [official SDK](https://github.com/modelcontextprotocol/typescript-sdk/tree/v1.x),
[MCP transport specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports),
[MCP tools specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools).
