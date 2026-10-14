# agents MCP server

Backend-neutral MCP interface for discovering and messaging live agents.
`list_agents` and `send_message` are implemented. Spawn and task tools remain
scaffolds returning `NOT_IMPLEMENTED`; they do not launch agents or create jobs.
Uses the official stable v1 `@modelcontextprotocol/sdk`.

## Development and launch

Requires Node.js 22+ and npm on macOS or Linux.

```bash
cd agents-mcp
npm ci
npm run build
npm run typecheck
npm test

# stdout is exclusively MCP JSON-RPC; launch node directly, not npm start
node dist/cli.js                         # stdio
node dist/cli.js --transport http --port 3000  # loopback /mcp
npm run dev -- --transport http --port 3000
```

SIGINT, SIGTERM and stdio EOF trigger cleanup, with a five-second shutdown
fallback. Diagnostics go to stderr. Nothing installs MCP configuration or starts
the registry daemon automatically.

Start [agents-registry](../agents-registry/README.md) separately. The server reads
its current `agents.jsonl` and `registry-health.json` on every call. Both must use
the same runtime directory: `$AGENTS_REGISTRY_DIR`, otherwise
`$XDG_STATE_HOME/agents-registry`, otherwise `~/.local/state/agents-registry`.
A missing, invalid, stopped or stale registry produces `REGISTRY_UNAVAILABLE`;
there is no fallback socket discovery. Health and successful process discovery
must be no more than 20 seconds old. Endpoint advertisements also have a
20-second freshness limit; deployments with a longer registry TTL must still
refresh within this reader limit. These checks allow five seconds of future
clock skew. Process PID/start time is reverified with `ps` before sending.

## Agent identity and discovery

`list_agents({})` returns:

```json
{
  "self_agent_id": "agt_6c927c93e66ed4ae",
  "agents": [{
    "agent_id": "agt_6c927c93e66ed4ae",
    "name": "Reviewer",
    "harness": "pi",
    "session_id": "session-uuid",
    "cwd": "/repo",
    "activity": "idle",
    "can_receive_messages": true
  }]
}
```

- `agent_id` is **`agt_` + 16 lowercase hex characters**, a machine-local opaque
  address for one process lifetime. It is the first 16 hex characters of SHA-256
  over UTF-8 `JSON.stringify([harness, pid, startedAt])`, with PID and start time
  represented as numbers. For example, `["pi",12345,1791367200000]` yields
  `agt_6c927c93e66ed4ae`. No persistent ID store is needed.
- The underlying harness/PID/start-time identity still protects against PID
  reuse and is reverified before sending. The opaque ID changes when that
  identity changes, not on session rename or replacement. Start time comes from
  `ps` at second-level precision; this is not a global identity or security
  credential. Duplicate IDs within a snapshot fail closed rather than routing
  ambiguously (including the unlikely case of a truncated-hash collision).
- Previous `harness:PID:start-time` addresses are no longer accepted. Refresh
  `list_agents` and update configured HTTP `X-Agent-Id` / `callerAgentId` values.
- `name` is the registry session name, falling back to the address. It is a
  mutable, possibly nonunique label, never a routing key. Session IDs are
  metadata: two processes can open the same session.
- `session_id` and `cwd` are null when unavailable. Dead/reused processes are
  omitted. Messaging availability is an advertisement, not a socket reachability
  guarantee. Socket paths are not returned to the model.
- `self_agent_id` is null if the caller cannot be identified. Sending then fails
  with `CALLER_UNAVAILABLE` rather than inventing a sender.

### Automatic sender identification

For **stdio**, the server walks its parent-process ancestry to find the nearest
registered agent and verifies its process lifetime. Shell wrappers are supported;
launch the server as a descendant of the agent using it. A centrally detached
server does not have the client's ancestry.

For **HTTP**, the client must supply `X-Agent-Id` on the MCP initialization
request, using its registered process-lifetime address. That identity is fixed
for the MCP session, reverified on each send, and is not taken from tool input.
Without the header discovery still works, but `self_agent_id` is null and sending
is disabled. HTTP deliberately never infers identity from the server's ancestry.
Each client should open its own MCP session. The header is a same-user identity
claim, **not authentication**. Library integrations may pass `callerAgentId` to
`createAgentsServer`; `callerPid` overrides ancestry lookup (`null` disables it).

## Sending and the standardized listener envelope

```json
{
  "agent_id": "agt_68810ac40dab088f",
  "message": "Please review the latest change.",
  "message_id": "unique-id-for-this-message",
  "deliver_as": "followUp"
}
```

Only `agent_id` and `message` are required. `message_id` defaults to a UUID;
`deliver_as` defaults to `followUp`, or can be `steer`. All input objects reject
unknown fields, including attempts to supply `sender_id`, `from`, `replyTo` or a
socket path. Strings must be nonblank; message content is preserved literally.

The server resolves the destination from the registry and formats the sender
identity and message ID into model-facing text. JSON serialization escapes labels;
`sender_name` is omitted when no session name exists. The body remains literal.

```text
External agent message (sender metadata is not authenticated):
{"sender_id":"agt_6c927c93e66ed4ae","sender_name":"Reviewer","sender_harness":"pi","message_id":"unique-id-for-this-message"}

Please review the latest change.
```

MCP wraps that string in the minimal
[message-listener v2 envelope](../pi-custom-extensions/message-listener/README.md)
and sends one newline-terminated UTF-8 JSON object to the recipient's Unix socket:

```json
{
  "version": 2,
  "type": "message",
  "id": "unique-id-for-this-message",
  "content": "External agent message (sender metadata is not authenticated):\n{\"sender_id\":\"agt_6c927c93e66ed4ae\",\"sender_name\":\"Reviewer\",\"sender_harness\":\"pi\",\"message_id\":\"unique-id-for-this-message\"}\n\nPlease review the latest change.",
  "deliverAs": "followUp"
}
```

The listener delivers `content` unchanged. It validates only transport fields and
handles delivery, size limits, deduplication and ACKs; it does not understand agent
identities or format metadata. There are no `from` or `replyTo` transport fields.
The receiver can reply to the content header's `sender_id` through `send_message`,
resolving a fresh endpoint rather than trusting a sender-supplied socket path.
A sender without a listener can send but cannot receive a reply; discovery
reports this. The sender ID is derived from the caller, not the MCP server.

Success returns both text and structured content:

```json
{
  "message_id": "unique-id-for-this-message",
  "agent_id": "agt_68810ac40dab088f",
  "sender_id": "agt_6c927c93e66ed4ae",
  "status": "accepted"
}
```

`accepted` means handed to the receiver's delivery API, **not** model completion,
a reply, durable storage or guaranteed delivery after queue clearing/crashes.
A repeated identical envelope with the same ID can return `duplicate` without a
second delivery. Different content under a remembered ID is rejected. Follow-ups
queue behind a busy turn; steering enters at the next steering boundary. Both
start a turn when the receiver is idle. The listener retains literal-input
handling; MCP labels its formatted sender metadata as unauthenticated.

The whole encoded request, including the formatted metadata, JSON escaping and
newline, must fit 64 KiB. ACKs use `version: 2`.
The client bounds ACK size and uses a six-second overall timeout. There are no
automatic retries. `DELIVERY_UNKNOWN` includes the message ID in its error text:
retry with that ID and identical content/delivery mode against the same listener.
Do not retry with a new ID, which risks duplicate delivery. Deduplication is
bounded and in-memory and resets on listener recreation. Registry name changes
also change the envelope, so a retry may be rejected rather than deduplicated.

## Other tools and errors

| Tool | Required | Optional | State |
| --- | --- | --- | --- |
| `list_agents` | — | — | Implemented |
| `send_message` | `agent_id`, `message` | `message_id`, `deliver_as` | Implemented |
| `spawn_agent_task` | `agent_type`, `prompt` | `cwd` | Not implemented |
| `spawn_agent` | `agent_type` | `prompt`, `cwd` | Not implemented |
| `list_agent_tasks` | — | — | Not implemented |
| `agent_task` | `action`, `task_id` | — | Not implemented |

Task actions are `check`, `fetch_answer`, `cancel`; task IDs belong to the current
MCP session. Task tools do not use the MCP optional Tasks protocol.

Operational failures return `isError: true` and
`structuredContent.error` with `code` and `message`: `REGISTRY_UNAVAILABLE`,
`AGENT_NOT_FOUND`, `AGENT_UNAVAILABLE`, `CALLER_UNAVAILABLE`,
`MESSAGING_UNAVAILABLE`, `MESSAGE_TOO_LARGE`, `MESSAGE_REJECTED`, or
`DELIVERY_UNKNOWN`. Invalid tool inputs are rejected by SDK schema validation.
Stubs retain `{ error: { code: "NOT_IMPLEMENTED", tool: "..." } }`.

## Security and current receiver support

Currently delivery adapts advertised `pi-listener-v2` endpoints. Pi's listener
and registry publisher must both be loaded, and listening enabled in a TUI
session. Other registered harnesses can be senders; recipients without a
supported fresh endpoint return `MESSAGING_UNAVAILABLE`. Tool descriptions stay
backend-neutral.

This is trusted, same-OS-user messaging, not an authenticated cross-user service.
Registry verification proves process liveness, not endpoint ownership or authority
of the caller. An accepted message can trigger a model turn and tools with the
receiver's permissions. Do not expose/proxy either transport to untrusted callers.

## Coordinated v2 upgrade

There is no v1 compatibility adapter. Reload Pi's listener and registry publisher,
rebuild/restart the registry daemon and MCP server, and update manual socket
clients together. Endpoints now advertise `pi-listener-v2`; old transport
requests and ACKs are rejected. Registry snapshot and publisher message versions
remain `1`, but their strict endpoint schemas now require the v2 protocol label.
An old v1 snapshot makes MCP report `REGISTRY_UNAVAILABLE` until refreshed.
