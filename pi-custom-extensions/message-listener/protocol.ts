export interface IncomingMessage {
  version: 2;
  type: "message";
  id: string;
  content: string;
  deliverAs: "steer" | "followUp";
}
export interface Ack {
  version: 2;
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
  const m = object(value, ["version", "type", "id", "content", "deliverAs"]);
  if (m.version !== 2 || m.type !== "message" || !text(m.id) || !text(m.content, MAX_MESSAGE_BYTES)) throw new Error("Invalid version, type, id or content");
  const deliverAs = m.deliverAs === undefined ? "followUp" : m.deliverAs;
  if (deliverAs !== "steer" && deliverAs !== "followUp") throw new Error("Invalid deliverAs");
  return { version: 2, type: "message", id: m.id, content: m.content, deliverAs };
}
