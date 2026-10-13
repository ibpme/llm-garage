import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, appendFile, rename, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSnapshot } from "./reader.ts";
import * as session from "./session.ts";

const agent = (file?: string, harness: "pi" | "claude" = "pi"): AgentSnapshot => ({ schemaVersion: 1, harness, observedAt: Date.now(), process: { pid: 123, startedAt: 1 }, session: { mode: "interactive", file, id: "test-id" }, activity: { state: "busy", source: "pi-registry" } });
const jsonl = (records: unknown[]) => records.map(record => JSON.stringify(record)).join("\n") + "\n";
const piMessage = (id: string, parentId: string | null, role: string, content: unknown, extra = {}) => ({ type: "message", id, parentId, message: { role, content, ...extra } });

test("Pi preview reconstructs the latest branch, hides thinking, summarizes tools and reports recorded usage", () => {
  const result = session.sessionSnapshot("pi", [
    piMessage("u", null, "user", "hello\x1b[2J"),
    piMessage("abandoned", "u", "assistant", [{ type: "text", text: "abandoned answer" }]),
    piMessage("a", "u", "assistant", [{ type: "thinking", thinking: "secret" }, { type: "text", text: "answer" }, { type: "toolCall", id: "call", name: "bash", arguments: { command: "x".repeat(2000) } }], { usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 3, cost: { total: 0.02 } } }),
    piMessage("r", "a", "toolResult", [{ type: "text", text: "result" }], { toolCallId: "call", toolName: "bash", isError: true }),
  ]);
  const text = JSON.stringify(result);
  assert.ok(text.includes("hello") && text.includes("answer") && text.includes("RESULT bash") && text.includes("ERROR"));
  assert.ok(!text.includes("abandoned answer") && !text.includes("secret") && !text.includes("\\u001b") && !text.includes("x".repeat(1000)));
  assert.match(result.usage, /input=10.*output=5.*cache-read=2.*cache-write=3/);
  assert.match(result.usage, /\$0\.020000/);
});

test("Claude tools are not user prompts and revised response usage and cumulative costs are not double counted", () => {
  const result = session.sessionSnapshot("claude", [
    { type: "assistant", message: { id: "a", content: [{ type: "tool_use", id: "c", name: "Read", input: { file_path: "/tmp/a" } }], usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "c", content: [{ type: "text", text: "contents" }, { type: "image", source: { data: "base64-secret" } }] }] } },
    { type: "assistant", message: { id: "a", content: [{ type: "text", text: "done" }], usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
    { type: "cost-state", totalCostUSD: 0.1 }, { type: "cost-state", totalCostUSD: 0.2 },
  ]);
  assert.ok(result.entries.some(entry => entry.label === "RESULT Read" && entry.text.includes("contents") && entry.text.includes("[image]")));
  assert.ok(!result.entries.some(entry => entry.label === "USER"));
  assert.ok(!JSON.stringify(result).includes("base64-secret"));
  assert.match(result.usage, /input=10.*output=5/);
  assert.match(result.usage, /\$0\.200000.*latest snapshot/);
  assert.match(session.sessionSnapshot("claude", []).usage, /unavailable/);
});

test("file reader handles split UTF-8 records, malformed lines, truncation and replacement", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agents-preview-"));
  try {
    const file = join(dir, "session.jsonl");
    await writeFile(file, jsonl([piMessage("u", null, "user", "first")]));
    const read = session.createSessionReader();
    assert.equal((await read(agent(file))).entries[0].text, "first");
    const next = Buffer.from(jsonl([piMessage("a", "u", "assistant", [{ type: "text", text: "你好" }])]));
    const split = next.indexOf(Buffer.from("你好")) + 1;
    await appendFile(file, next.subarray(0, split));
    assert.equal((await read(agent(file))).entries.length, 1);
    await appendFile(file, next.subarray(split));
    assert.equal((await read(agent(file))).entries[1].text, "你好");
    await appendFile(file, "bad json\n");
    assert.match((await read(agent(file))).warnings.join(" "), /malformed/i);
    await writeFile(file, jsonl([piMessage("new", null, "user", "reset")]));
    assert.equal((await read(agent(file))).entries[0].text, "reset");
    const replacement = join(dir, "replacement");
    await writeFile(replacement, jsonl([piMessage("other", null, "user", "replacement")]));
    await rename(replacement, file);
    assert.equal((await read(agent(file))).entries[0].text, "replacement");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("Claude resolves a unique top-level session by ID and rejects ambiguous or unsafe IDs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "claude-preview-"));
  try {
    await mkdir(join(dir, "project"));
    await writeFile(join(dir, "project", "test-id.jsonl"), jsonl([{ type: "user", message: { content: "found" } }]));
    const read = session.createSessionReader({ claudeRoots: [dir] });
    assert.equal((await read(agent(undefined, "claude"))).entries[0].text, "found");
    await mkdir(join(dir, "second"));
    await writeFile(join(dir, "second", "test-id.jsonl"), "");
    await assert.rejects(session.createSessionReader({ claudeRoots: [dir] })(agent(undefined, "claude")), /multiple|ambiguous/i);
    await assert.rejects(read({ ...agent(undefined, "claude"), session: { mode: "interactive", id: "../bad" } }), /invalid/i);
    await assert.rejects(read(agent()), /session file/i);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("current Pi preview reads the actual in-memory leaf even when a newer abandoned branch exists on disk", async () => {
  const records = [piMessage("u", null, "user", "root"), piMessage("a", "u", "assistant", [{ type: "text", text: "abandoned" }])];
  const read = session.createSessionReader({ currentPi: () => ({ records, branch: [records[0]] }) });
  const result = await read({ ...agent("/does/not/exist"), process: { pid: process.pid, startedAt: 1 } });
  assert.deepEqual(result.entries, [{ label: "USER", text: "root" }]);
});

test("Pi usage includes tool nested work, summaries and usage entries across branches without counting reasoning twice", () => {
  const usage = { input: 1, output: 2, reasoning: 2, cacheRead: 3, cacheWrite: 4, cost: { total: 0.01 } };
  const result = session.sessionSnapshot("pi", [
    piMessage("a", null, "assistant", [], { usage }),
    piMessage("r", "a", "toolResult", [], { usage }),
    { type: "usage", id: "warm", parentId: "a", usage },
    { type: "compaction", id: "summary", parentId: "warm", summary: "summary", usage },
  ]);
  assert.match(result.usage, /input=4.*output=8.*cache-read=12.*cache-write=16/);
  assert.match(result.usage, /\$0\.040000/);
  assert.ok(result.entries.some(entry => entry.label === "SUMMARY"));
});

test("empty failed tool results still expose their error marker", () => {
  const result = session.sessionSnapshot("pi", [piMessage("r", null, "toolResult", [], { toolName: "bash", isError: true })]);
  assert.ok(result.entries.some(entry => entry.label === "RESULT bash ERROR"));
});
