import type { MessagingEndpoint } from "../../agents-registry/src/types.ts";

export const LISTENER_CHANGED_EVENT = "message-listener:changed";
export const LISTENER_QUERY_EVENT = "message-listener:query";
export const LISTENER_STATUS_KEY = "message-listener";

export function isListenerEndpoint(value: unknown): value is MessagingEndpoint | null {
  if (value === null) return true;
  if (!value || typeof value !== "object") return false;
  const e = value as MessagingEndpoint;
  return e.transport === "unix" && e.protocol === "pi-listener-v1" && typeof e.path === "string" &&
    e.path.startsWith("/") && !e.path.includes("\0") && Buffer.byteLength(e.path) <= 100;
}
