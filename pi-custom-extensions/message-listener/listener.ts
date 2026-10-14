import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_MESSAGE_BYTES, parseMessage } from "./protocol.ts";
import type { Ack, IncomingMessage } from "./protocol.ts";

export interface Listener {
  path: string;
  directory: string;
  close(): Promise<void>;
}

export async function startListener(deliver: (message: IncomingMessage) => void): Promise<Listener> {
  const directory = await mkdtemp(join(tmpdir(), "pi-listen-"));
  const path = join(directory, "in.sock");
  const connections = new Set<Socket>();
  const accepted = new Map<string, string>();
  let closing = false;
  let closePromise: Promise<void> | undefined;
  const server = createServer({ allowHalfOpen: true }, socket => {
    socket.on("error", () => socket.destroy());
    if (closing || connections.size >= 32) { socket.end(`${JSON.stringify({ version: 2, type: "ack", id: null, ok: false, error: "Listener busy" })}\n`); socket.destroySoon(); return; }
    connections.add(socket);
    socket.on("close", () => connections.delete(socket));
    let chunks: Buffer[] = [];
    let bytes = 0;
    let done = false;
    const timer = setTimeout(() => finish({ version: 2, type: "ack", id: null, ok: false, error: "Request timeout" }), 5000);
    timer.unref();
    socket.on("close", () => clearTimeout(timer));
    function finish(ack: Ack): void {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chunks = [];
      socket.end(`${JSON.stringify(ack)}\n`);
      socket.destroySoon();
    }
    socket.on("end", () => { if (!done) finish({ version: 2, type: "ack", id: null, ok: false, error: "Incomplete request; newline required" }); });
    socket.on("data", (chunk: Buffer) => {
      if (done) return;
      bytes += chunk.length;
      if (bytes > MAX_MESSAGE_BYTES) { finish({ version: 2, type: "ack", id: null, ok: false, error: "Request exceeds 64 KiB" }); return; }
      chunks.push(chunk);
      if (!chunk.includes(10)) return;
      let id: string | null = null;
      try {
        const input = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
        const newline = input.indexOf("\n");
        if (input.slice(newline + 1).trim()) throw new Error("One request per connection required");
        const message = parseMessage(JSON.parse(input.slice(0, newline)));
        id = message.id;
        const hash = createHash("sha256").update(JSON.stringify(message)).digest("hex");
        const previous = accepted.get(id);
        if (previous !== undefined) {
          if (previous !== hash) throw new Error("Message id already used with different payload");
          finish({ version: 2, type: "ack", id, ok: true, status: "duplicate" });
          return;
        }
        deliver(message);
        accepted.set(id, hash);
        if (accepted.size > 1024) accepted.delete(accepted.keys().next().value!);
        finish({ version: 2, type: "ack", id, ok: true, status: "accepted" });
      } catch (error) {
        finish({ version: 2, type: "ack", id, ok: false, error: error instanceof SyntaxError ? "Invalid JSON" : error instanceof Error ? error.message : "Delivery failed" });
      }
    });
  });
  try {
    await chmod(directory, 0o700);
    if (Buffer.byteLength(path) > 100) throw new Error("Listener socket path exceeds 100 bytes; use a shorter TMPDIR");
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, () => { server.off("error", reject); resolve(); });
    });
    await chmod(path, 0o600);
  } catch (error) {
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    path, directory,
    close() {
      if (!closePromise) {
        closing = true;
        for (const socket of connections) socket.destroy();
        closePromise = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
          .finally(() => rm(directory, { recursive: true, force: true }));
      }
      return closePromise;
    },
  };
}
