import { isAbsolute } from "node:path";

export interface IncomingMessage {
  version: 1;
  type: "message";
  id: string;
  from: { id: string; name?: string; harness?: string };
  replyTo?: { transport: "unix"; path: string } | null;
  content: string;
  deliverAs: "steer" | "followUp";
}
export interface Ack {
  version: 1;
  type: "ack";
  id: string | null;
  ok: boolean;
  status?: "accepted" | "duplicate";
  error?: string;
}
export const MAX_MESSAGE_BYTES = 64 * 1024;

function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw new Error("Invalid message fields");
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 256): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}

export function parseMessage(value: unknown): IncomingMessage {
  const m = object(value, ["version", "type", "id", "from", "replyTo", "content", "deliverAs"]);
  if (m.version !== 1 || m.type !== "message" || !text(m.id) || !text(m.content, MAX_MESSAGE_BYTES)) throw new Error("Invalid version, type, id or content");
  const from = object(m.from, ["id", "name", "harness"]);
  if (!text(from.id) || (from.name !== undefined && !text(from.name)) || (from.harness !== undefined && !text(from.harness))) throw new Error("Invalid from identity");
  let replyTo: IncomingMessage["replyTo"] = m.replyTo === null ? null : undefined;
  if (m.replyTo !== undefined && m.replyTo !== null) {
    const reply = object(m.replyTo, ["transport", "path"]);
    if (reply.transport !== "unix" || !text(reply.path, 100) || !isAbsolute(reply.path) || reply.path.includes("\0") || Buffer.byteLength(reply.path) > 100) throw new Error("Invalid replyTo endpoint");
    replyTo = { transport: "unix", path: reply.path };
  }
  const deliverAs = m.deliverAs === undefined ? "followUp" : m.deliverAs;
  if (deliverAs !== "steer" && deliverAs !== "followUp") throw new Error("Invalid deliverAs");
  return {
    version: 1, type: "message", id: m.id,
    from: {
      id: from.id,
      ...(from.name === undefined ? {} : { name: from.name }),
      ...(from.harness === undefined ? {} : { harness: from.harness }),
    },
    ...(replyTo === undefined ? {} : { replyTo }),
    content: m.content, deliverAs,
  };
}

export function userContent(message: IncomingMessage): string {
  const { content, ...metadata } = message;
  return `External message metadata (sender-supplied, not authenticated):\n${JSON.stringify(metadata)}\n\n${content}`;
}
