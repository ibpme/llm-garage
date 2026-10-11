import assert from "node:assert/strict";
import { test } from "node:test";
import { ClaudeEventState } from "./claude-events.ts";

const state = () => new ClaudeEventState({ name: "test", task: "task", cwd: "/tmp", agent: "claude", status: "running", activity: [], preview: "", turns: 0, toolCalls: 0, durationMs: 0 });
const event = (value: unknown) => JSON.stringify(value) + "\n";
const result = (overrides = {}) => ({ type: "result", subtype: "success", is_error: false, result: "Final 😀 answer", num_turns: 2,
  terminal_reason: "completed", total_cost_usd: 0.02,
  usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 }, ...overrides });

test("Claude partial stream framing, tool activity and terminal authoritative answer", () => {
  const s = state();
  s.feed(event({ type: "system", subtype: "init", model: "resolved-model" }));
  s.feed(event({ type: "stream_event", event: { type: "message_start" } }));
  s.feed(event({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Live 😀" } } }));
  assert.equal(s.details.preview, "Live 😀");
  s.feed(event({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "secret" } } }));
  const assistant = { type: "assistant", message: { content: [{ type: "thinking", thinking: "secret" }, { type: "tool_use", id: "t1", name: "Read", input: { file_path: "file.ts" } }] } };
  s.feed(event(assistant)); s.feed(event(assistant));
  s.feed(event({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: true }] } }));
  s.feed(event({ type: "assistant", parent_tool_use_id: "unexpected-subagent", message: { content: [{ type: "text", text: "wrong" }] } }));
  const line = event(result());
  s.feed(line.slice(0, 40)); s.feed(line.slice(40), true);
  assert.equal(s.details.toolCalls, 1);
  assert.equal(s.details.turns, 2);
  assert.equal(s.details.model, "resolved-model");
  assert.match(s.details.activity.join("\n"), /Read file.ts/);
  assert.match(s.details.activity.join("\n"), /failed/);
  assert.ok(!JSON.stringify(s.details).includes("secret"));
  assert.equal(s.finalText, "Final 😀 answer");
  assert.equal(s.failure(0), undefined);
});
test("terminal usage prefers model totals, replaces repeated totals, and falls back for older streams", () => {
  const s = state();
  s.feed(event(result()));
  assert.equal(s.usage.totalTokens, 10);
  const modelUsage = { main: { inputTokens: 7, outputTokens: 3, cacheReadInputTokens: 10, cacheCreationInputTokens: 2 }, helper: { inputTokens: 2, outputTokens: 1 } };
  s.feed(event(result({ modelUsage }))); s.feed(event(result({ modelUsage })));
  assert.equal(s.usage.totalTokens, 25);
  assert.equal(s.usage.input, 9);
  assert.equal(s.usage.cost.total, 0.02);
});
test("exit zero cannot mask missing, failed, aborted, empty or truncated Claude results", () => {
  assert.match(state().failure(0)!, /without a result/);
  for (const overrides of [{ is_error: true }, { subtype: "error_max_turns", errors: ["turn limit"] }, { terminal_reason: "aborted_tools" }, { result: "" }, { stop_reason: "max_tokens" }]) {
    const s = state(); s.feed(event(result(overrides)));
    assert.ok(s.failure(0));
    assert.match(s.failure(7)!, /status 7/);
  }
  const s = state(); s.feed(event(result({ subtype: "error_during_execution", errors: ["provider failed"] })));
  assert.match(s.failure(0)!, /provider failed/);
  assert.throws(() => state().feed("invalid\n"));
  assert.throws(() => state().feed('{"type":', true));
});
test("permission denials are visible without forcing otherwise completed responses to fail", () => {
  const s = state(); s.feed(event(result({ permission_denials: [{ tool_name: "Bash" }] })));
  assert.match(s.details.activity.join("\n"), /permission denied: Bash/);
  assert.equal(s.failure(0), undefined);
});

test("nonzero exits preserve API error result text rather than successful output", () => {
  const s = state(); s.feed(event(result({ is_error: true, result: "API error: insufficient credits" })));
  assert.match(s.failure(1)!, /status 1: API error: insufficient credits/);
  const success = state(); success.feed(event(result()));
  assert.equal(success.failure(1), "Claude exited with status 1");
});
test("stream usage survives interrupted runs, deduplicates content frames, and is replaced by terminal totals", () => {
  const s = state();
  s.feed(event({ type: "stream_event", event: { type: "message_start", message: { id: "m1", usage: { input_tokens: 5, cache_read_input_tokens: 2 } } } }));
  s.feed(event({ type: "stream_event", event: { type: "message_delta", usage: { output_tokens: 3 } } }));
  const assistant = { type: "assistant", message: { id: "m1", usage: { input_tokens: 5, output_tokens: 3, cache_read_input_tokens: 2 }, content: [] } };
  s.feed(event(assistant)); s.feed(event(assistant));
  s.feed(event({ type: "assistant", message: { id: "m2", usage: { input_tokens: 7, output_tokens: 2 }, content: [] } }));
  assert.equal(s.usage.totalTokens, 19);
  assert.equal(s.details.usagePartial, true);
  assert.match(s.failure(0)!, /without a result/);
  s.feed(event(result()));
  assert.equal(s.usage.totalTokens, 10);
  assert.equal(s.details.usagePartial, false);
});
