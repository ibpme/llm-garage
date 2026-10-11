import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const DEPTH_ENTRY = "oneshot-subagent-context";
export const DEPTH_ENV = "PI_ONESHOT_SUBAGENT_CONTEXT";
export const DEFAULT_MAX_DEPTH = 2;

export interface DepthPolicy {
  version: 1;
  depth: number;
  maxDepth: number;
  runDir?: string;
}

function integer(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 16;
}

export function parsePolicy(raw: unknown): DepthPolicy {
  if (!raw || typeof raw !== "object") throw new Error("Invalid subagent depth metadata");
  const value = raw as Record<string, unknown>;
  if (value.version !== 1 || !integer(value.depth) || !integer(value.maxDepth) ||
      (value.runDir !== undefined && (typeof value.runDir !== "string" || !isAbsolute(value.runDir))))
    throw new Error("Invalid subagent depth metadata");
  return { version: 1, depth: value.depth, maxDepth: value.maxDepth,
    ...(value.runDir === undefined ? {} : { runDir: value.runDir as string }) };
}

export function loadMaxDepth(path = join(getAgentDir(), "oneshot-subagent.json")): number {
  let text: string;
  try { text = readFileSync(path, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return DEFAULT_MAX_DEPTH; throw error; }
  const raw = JSON.parse(text) as Record<string, unknown>;
  if (!raw || !integer(raw.maxDepth)) throw new Error("oneshot-subagent.json: maxDepth must be an integer from 0 to 16");
  return raw.maxDepth;
}

export function initialPolicy(env: NodeJS.ProcessEnv = process.env): DepthPolicy {
  if (env[DEPTH_ENV] !== undefined) return parsePolicy(JSON.parse(env[DEPTH_ENV]!));
  // A child launched by an older version must not silently become a root.
  if (env.PI_ONESHOT_SUBAGENT_CHILD === "1") return { version: 1, depth: 1, maxDepth: 1 };
  return { version: 1, depth: 0, maxDepth: loadMaxDepth() };
}

export function restorePolicy(base: DepthPolicy, saved: unknown[]): DepthPolicy {
  let policy = { ...base };
  for (const raw of saved) {
    const entry = parsePolicy(raw);
    policy = { version: 1, depth: Math.max(policy.depth, entry.depth),
      maxDepth: Math.min(policy.maxDepth, entry.maxDepth), runDir: base.runDir };
  }
  return policy;
}

export function childPolicy(parent: DepthPolicy, runDir: string): DepthPolicy {
  if (parent.depth >= parent.maxDepth) throw new Error(`Subagent depth limit reached (${parent.depth}/${parent.maxDepth})`);
  return { version: 1, depth: parent.depth + 1, maxDepth: parent.maxDepth, runDir };
}
