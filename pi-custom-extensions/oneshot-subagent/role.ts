export const ROLE_ENTRY = "oneshot-subagent-role";
export const CHILD_ENV = "PI_ONESHOT_SUBAGENT_CHILD";

export type Role = "root" | "child";

export interface SavedEntry {
  customType: string;
  data?: unknown;
}

export function envRole(env: NodeJS.ProcessEnv = process.env): Role {
  return env[CHILD_ENV] === "1" ? "child" : "root";
}

export const hasRoleEntry = (saved: SavedEntry[]): boolean => saved.some((entry) => entry.customType === ROLE_ENTRY);

/** Identity only ever tightens: a child by environment or by any saved role entry stays a child. */
export function restoreRole(base: Role, saved: SavedEntry[]): Role {
  return base === "child" || hasRoleEntry(saved) ? "child" : "root";
}
