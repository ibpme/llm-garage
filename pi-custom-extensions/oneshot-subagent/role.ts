export const ROLE_ENTRY = "oneshot-subagent-role";
export const CHILD_ENV = "PI_ONESHOT_SUBAGENT_CHILD";
// Written by versions with a depth budget; still read so old sessions keep their identity.
export const LEGACY_ENTRY = "oneshot-subagent-context";
export const LEGACY_ENV = "PI_ONESHOT_SUBAGENT_CONTEXT";

export type Role = "root" | "child";

export interface SavedEntry {
  customType: string;
  data?: unknown;
}

export function envRole(env: NodeJS.ProcessEnv = process.env): Role {
  return env[CHILD_ENV] === "1" || env[LEGACY_ENV] !== undefined ? "child" : "root";
}

function legacyRole(raw: unknown): Role {
  const value = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  return value.version === 1 && value.depth === 0 ? "root" : "child";
}

/** Identity only ever tightens: any child evidence wins, and unreadable evidence counts as child. */
export function restoreRole(base: Role, saved: SavedEntry[]): Role {
  if (base === "child") return "child";
  for (const entry of saved) {
    if (entry.customType === ROLE_ENTRY) return "child";
    if (entry.customType === LEGACY_ENTRY && legacyRole(entry.data) === "child") return "child";
  }
  return "root";
}

export const hasRoleEntry = (saved: SavedEntry[]): boolean => saved.some((entry) => entry.customType === ROLE_ENTRY);
