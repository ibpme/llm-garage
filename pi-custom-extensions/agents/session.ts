import { open, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { AgentSnapshot } from "./reader.ts";

export interface SessionSnapshot {
  entries: Array<{ label: string; text: string }>;
  usage: string;
  warnings: string[];
}
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const safe = (value: string): string => stripVTControlCharacters(value).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
const count = (value: unknown): number | null => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
const cost = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const compact = (text: string): string => {
  const short = text.split("\n").slice(0, 5).join("\n").slice(0, 600);
  return short.length < text.length ? `${short}\n… [truncated]` : short;
};
function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(contentText).filter(Boolean).join("\n");
  const block = object(value);
  if (block.type === "text" && typeof block.text === "string") return block.text;
  if (block.type === "image" || block.type === "document") return `[${block.type}]`;
  return "";
}

function latestBranch(records: Record<string, unknown>[]): Record<string, unknown>[] {
  const tree = records.filter(record => record.type !== "session" && typeof record.id === "string");
  if (!tree.length || !tree.some(record => "parentId" in record)) return records;
  const byId = new Map(tree.map(record => [record.id, record]));
  const branch: Record<string, unknown>[] = [];
  const seen = new Set();
  let current: Record<string, unknown> | undefined = tree.at(-1);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    branch.push(current);
    current = byId.get(current.parentId);
  }
  return branch.reverse();
}

export function sessionSnapshot(harness: AgentSnapshot["harness"], values: readonly unknown[], branch?: readonly unknown[]): SessionSnapshot {
  const records = values.map(object);
  const entries: SessionSnapshot["entries"] = [];
  const tools = new Map<unknown, string>();
  const responses = new Map<unknown, Array<number | null>>();
  const costs: Array<number | null> = [];
  let loggedCost: number | null = null;
  let unknownCost = false;
  const add = (label: string, text: string, small = false) => {
    text = safe(text);
    if (small && !text) text = "[no output]";
    if (text) entries.push({ label: safe(label), text: small ? compact(text) : text });
  };
  for (const record of branch ? branch.map(object) : harness === "pi" ? latestBranch(records) : records) {
    if (record.type === "compaction" || record.type === "branch_summary") add("SUMMARY", contentText(record.summary));
    if (record.type === "custom_message" && record.display === true) add("CUSTOM", contentText(record.content));
    const message = object(record.message);
    const role = harness === "pi" ? message.role : record.type;
    if (role !== "user" && role !== "assistant" && role !== "toolResult") continue;
    if (role === "toolResult") {
      add(`RESULT ${message.toolName ?? tools.get(message.toolCallId) ?? "unknown"}${message.isError ? " ERROR" : ""}`, contentText(message.content), true);
      continue;
    }
    const blocks = typeof message.content === "string" ? [{ type: "text", text: message.content }] : Array.isArray(message.content) ? message.content : [];
    let text: string[] = [];
    const flush = () => { add(String(role).toUpperCase(), text.join("\n")); text = []; };
    for (const value of blocks) {
      const block = object(value);
      if (block.type === "tool_use" || block.type === "toolCall") {
        flush();
        const name = typeof block.name === "string" ? block.name : "unknown";
        tools.set(block.id, name);
        add(`TOOL ${name}`, JSON.stringify(block.input ?? block.arguments ?? {}), true);
      } else if (block.type === "tool_result") {
        flush();
        add(`RESULT ${tools.get(block.tool_use_id) ?? "unknown"}${block.is_error ? " ERROR" : ""}`, contentText(block.content), true);
      } else {
        const value = contentText(block);
        if (value) text.push(value);
      }
    }
    flush();
  }
  // Accounting covers observed records across branches, not only the displayed path.
  for (const [index, record] of records.entries()) {
    if (harness === "claude" && record.type === "cost-state") {
      loggedCost = cost(record.totalCostUSD);
      unknownCost = record.hasUnknownModelCost === true;
    }
    const message = object(record.message);
    const assistant = harness === "pi" ? message.role === "assistant" : record.type === "assistant";
    const usage = object(assistant || message.role === "toolResult" ? message.usage : record.usage);
    if (!assistant && !Object.keys(usage).length) continue;
    const fields = harness === "pi" ? ["input", "output", "cacheRead", "cacheWrite"] : ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"];
    const key = harness === "claude" ? message.id ?? record.uuid ?? index : record.id ?? index;
    const previous = responses.get(key);
    responses.set(key, fields.map((field, i) => count(usage[field]) ?? previous?.[i] ?? null));
    if (harness === "pi") costs.push(cost(object(usage.cost).total));
  }
  const totals = [0, 1, 2, 3].map(i => {
    const values = [...responses.values()].map(tokens => tokens[i]);
    const known = values.filter((value): value is number => value !== null);
    return known.length ? known.reduce((sum, value) => sum + value, 0) : null;
  });
  const partial = [...responses.values()].some(tokens => tokens.some(value => value === null));
  const dollars = harness === "claude" ? loggedCost : costs.some(value => value !== null) ? costs.reduce<number>((sum, value) => sum + (value ?? 0), 0) : null;
  const partialCost = harness === "claude" ? unknownCost : costs.some(value => value === null);
  const usage = `Observed tokens: ${["input", "output", "cache-read", "cache-write"].map((field, i) => `${field}=${totals[i] ?? "unavailable"}`).join(" ")}${partial ? " (partial)" : ""} · Recorded cost: ${dollars === null ? "unavailable" : `$${dollars.toFixed(6)}`}${harness === "claude" && dollars !== null ? " (latest snapshot; may lag)" : ""}${partialCost ? " (partial)" : ""}`;
  return { entries, usage, warnings: [] };
}

async function claudeFile(id: string | undefined, roots: string[]): Promise<string> {
  if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Missing or invalid Claude session ID.");
  const matches = new Set<string>();
  for (const root of roots) {
    let projects;
    try { projects = await readdir(root, { withFileTypes: true }); }
    catch (error) { if (object(error).code === "ENOENT") continue; throw error; }
    for (const project of projects) {
      if (!project.isDirectory() && !project.isSymbolicLink()) continue;
      const file = join(root, project.name, `${id}.jsonl`);
      try { if ((await stat(file)).isFile()) matches.add(await realpath(file)); }
      catch (error) { if (!["ENOENT", "ENOTDIR"].includes(String(object(error).code))) throw error; }
    }
  }
  if (matches.size !== 1) throw new Error(matches.size ? "Multiple files match this Claude session ID." : "Claude session file not found.");
  return [...matches][0];
}

export interface SessionReaderOptions {
  claudeRoots?: string[];
  currentPi?: () => { records: readonly unknown[]; branch: readonly unknown[] };
}

export function createSessionReader(options: SessionReaderOptions = {}) {
  const roots = options.claudeRoots ?? [join(homedir(), ".claude", "projects"), join(homedir(), ".claude", "project")];
  let file: string | undefined;
  let target = "";
  let identity = "";
  let offset = 0;
  let pending = Buffer.alloc(0);
  let records: unknown[] = [];
  let malformed = 0;
  let snapshot: SessionSnapshot | undefined;
  return async (agent: AgentSnapshot): Promise<SessionSnapshot> => {
    if (agent.harness === "pi" && agent.process.pid === process.pid && options.currentPi) {
      const current = options.currentPi();
      return sessionSnapshot("pi", current.records, current.branch);
    }
    const key = `${agent.harness}:${agent.process.pid}:${agent.process.startedAt}:${agent.session.id}:${agent.session.file}`;
    if (key !== target) { target = key; file = undefined; identity = ""; }
    file ??= agent.session.file ?? (agent.harness === "claude" ? await claudeFile(agent.session.id, roots) : undefined);
    if (!file) throw new Error("No session file recorded for this Pi agent.");
    const handle = await open(file, "r");
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new Error("Session path is not a regular file.");
      const nextIdentity = `${info.dev}:${info.ino}`;
      if (identity !== nextIdentity || info.size < offset) {
        identity = nextIdentity; offset = 0; pending = Buffer.alloc(0); records = []; malformed = 0; snapshot = undefined;
      }
      if (snapshot && info.size === offset) return snapshot;
      const buffer = Buffer.alloc(64 * 1024);
      while (offset < info.size) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, info.size - offset), offset);
        if (!bytesRead) break;
        offset += bytesRead;
        pending = Buffer.concat([pending, buffer.subarray(0, bytesRead)]);
        let start = 0;
        let end;
        while ((end = pending.indexOf(10, start)) !== -1) {
          const line = pending.subarray(start, end).toString("utf8");
          start = end + 1;
          if (!line.trim()) continue;
          try { records.push(JSON.parse(line)); } catch { malformed++; }
        }
        pending = Buffer.from(pending.subarray(start));
      }
      snapshot = sessionSnapshot(agent.harness, records);
      if (malformed) snapshot.warnings.push(`Skipped ${malformed} malformed session records.`);
      return snapshot;
    } finally { await handle.close(); }
  };
}
