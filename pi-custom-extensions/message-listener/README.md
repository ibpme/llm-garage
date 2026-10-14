# Message listener

Local, same-user messaging into an interactive Pi session. The extension starts
on `session_start` in **TUI mode only**, never when its factory is merely loaded.
RPC, JSON and print modes do not open a listener.

```text
/listen             toggle
/listen on          enable (idempotent)
/listen off         close socket and withdraw registration
/listen status      show the current socket path
```

The footer shows `● listening`, `○ listener off`, or `! listener error` through
Pi's extension-status API. This works in the default footer and the repository's
custom footer without taking over another extension's UI. The toggle lasts for
this extension runtime; `/reload` and a new process return to enabled. Session
replacement closes the old socket and creates a new one if enabled. Disabling
stops new receipts; it does not cancel messages already handed to Pi.

## Protocol: pi-listener-v1

Use a Unix-domain socket, **one UTF-8 JSON object followed by a newline per
connection**. The listener writes one newline-terminated ACK and closes. Requests
including the newline are limited to 64 KiB. Unknown fields are rejected.

```json
{
  "version": 1,
  "type": "message",
  "id": "a-unique-message-id",
  "from": {
    "id": "sender-agent-id",
    "name": "Reviewer",
    "harness": "pi"
  },
  "replyTo": {
    "transport": "unix",
    "path": "/absolute/path/to/sender.sock"
  },
  "content": "Please review the latest change.",
  "deliverAs": "followUp"
}
```

- Required: `version`, `type`, `id`, `from.id`, and nonblank string `content`.
- `id` and sender fields are nonblank strings of at most 256 characters. Use a
  UUID for the message ID; IDs share one namespace on each listener instance.
- `from.name` and `from.harness` are optional labels, not verified identities.
- `replyTo` is optional (or `null`), with an absolute Unix socket path of at most
  100 UTF-8 bytes. It is **metadata only**: the receiver chooses whether/how to
  reply. The extension does not connect to it, add a reply tool, or automatically
  forward model responses. Receivers must validate destinations before replying.
- `deliverAs` is `steer` or `followUp`, defaulting to `followUp`. Both start a turn
  when Pi is idle. While busy, steering is delivered at Pi's next steering
  boundary; follow-ups wait for queued follow-up delivery. Pi's queue settings
  determine whether queued messages are consumed individually or together.

The extension delivers a user message containing a JSON metadata header followed
by `content`. Metadata is explicitly labeled sender-supplied and unauthenticated,
so `from`, `replyTo`, and the message ID reach the model alongside the request.
Slash commands, skill expansion, and prompt-template expansion are disabled for
socket input; `/listen off` sent as content is literal text, not a local command.

### ACKs and retries

```json
{"version":1,"type":"ack","id":"a-unique-message-id","ok":true,"status":"accepted"}
```

`accepted` means validation succeeded and the extension handed the message to
Pi's delivery API. It does **not** guarantee model completion, a reply, durable
storage, or eventual delivery after an abort, queue clear, reload, or crash.

Resending the same normalized envelope with the same ID returns
`status: "duplicate"` without a second delivery. Changing the payload with a
recently accepted ID returns a negative ACK. Deduplication remembers the last
1,024 accepted IDs in memory, and resets when the socket is recreated. This is
bounded retry protection, not exactly-once delivery. A timeout is ambiguous;
retry with the same ID against the same socket, not a new ID.

```json
{"version":1,"type":"ack","id":null,"ok":false,"error":"Invalid JSON"}
```

Rejected requests use `ok: false` and `error`. `id` is available after envelope
validation, otherwise `null`. Clients should set their own connection/response
timeout. The server permits at most 32 active connections and gives each request
five seconds to finish. Connection limits do not bound Pi's downstream message
queue: trusted senders must pace traffic and avoid flooding the agent.

## Socket discovery and security

A fresh private `pi-listen-*` directory under the OS temporary directory contains
`in.sock`. The directory is `0700`, the socket `0600`. Graceful disable, shutdown,
and reload close connections and remove the directory. Hard crashes can leave an
unreachable temporary socket behind; later instances use a new directory rather
than deleting or reusing an unknown path. If the resulting Unix socket path
exceeds 100 bytes, use a shorter `TMPDIR` before launching Pi.

Programs running as your OS user are trusted. Socket permissions are not a
sandbox or authentication for sender metadata. An accepted message can start a
model turn and cause tools to run with Pi's permissions. Do not expose/proxy the
socket to untrusted clients. No TCP listener or token authentication is included.

## Registry integration

With `registry-publisher.ts` loaded and the explicitly started `agents-registry`
daemon running, the process snapshot gains:

```json
{
  "messaging": {
    "transport": "unix",
    "path": "/private/temp/pi-listen-example/in.sock",
    "protocol": "pi-listener-v1",
    "reportedAt": 1791367205000
  }
}
```

The listener and publisher communicate through stateless event contracts in
`../contracts/listener.ts`, not imports of one another's entry points. A startup
query makes registration independent of extension startup order. Listener
changes publish immediately; the existing five-second heartbeat restores
registration after daemon restarts. Turning off publishes `messaging: null`;
publisher shutdown also attempts a bounded explicit clear. Missing/rejected
registry requests never prevent local listening. The daemon is not auto-started.

Endpoint advertisements expire under the registry's activity TTL (20 seconds
by default), protecting against missing clears or disabled publishers. Expiry
appears on the next snapshot write. Readers should also check registry health,
reverify process identity, and handle socket connection failures; a snapshot is
not a guarantee of a reachable endpoint. Rebuild and restart the daemon to load
the updated schemas/store. Older strict snapshot readers must also be updated.

To load only the listener and publisher from the repository root:

```bash
pi -e ./pi-custom-extensions/message-listener/index.ts \
   -e ./pi-custom-extensions/registry-publisher.ts
```

### Send a message

Use `/listen status` or a fresh registry snapshot to get the path:

```bash
SOCKET=/absolute/path/to/in.sock node --input-type=module <<'JS'
import { randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';
const socket = createConnection(process.env.SOCKET);
socket.setTimeout(6000, () => socket.destroy(new Error('ACK timeout')));
socket.on('error', error => { console.error(error.message); process.exitCode = 1; });
socket.on('data', chunk => process.stdout.write(chunk));
socket.on('connect', () => socket.end(JSON.stringify({
  version: 1, type: 'message', id: randomUUID(),
  from: { id: 'manual-sender' }, content: 'Summarize your current progress.',
  deliverAs: 'followUp',
}) + '\n'));
JS
```
