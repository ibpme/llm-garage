import assert from "node:assert/strict";
import { test } from "node:test";
import { EventState, emptyUsage, type RunDetails } from "./events.ts";

function state() {
  const details: RunDetails = { name: "test", task: "task", cwd: "/tmp", status: "running", activity: [], preview: "", turns: 0, toolCalls: 0, durationMs: 0 };
  return new EventState(details);
}
const message = (text: string, stopReason = "stop") => ({ role: "assistant", content: [{ type: "text", text }], stopReason,
  usage: { ...emptyUsage(), input: 2, output: 3, totalTokens: 5 } });
const event = (value: unknown) => JSON.stringify(value) + "\n";

test("LF framing handles partial records and Unicode separators without exposing thinking", () => {
  const s = state();
  const line = event({ type: "message_end", message: { ...message("Hello\u2028world\u2029!"), content: [
    { type: "thinking", thinking: "secret" }, { type: "text", text: "Hello\u2028world\u2029!" }] } });
  s.feed(line.slice(0, 27));
  assert.equal(s.finalText, "");
  s.feed(line.slice(27));
  s.feed(event({ type: "agent_settled", aborted: false }));
  assert.equal(s.finalText, "Hello\u2028world\u2029!");
  assert.equal(s.failure(0), undefined);
});

test("final authoritative response replaces earlier output; usage counts only completed messages", () => {
  const s = state();
  s.feed(event({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "partial" } }));
  s.feed(event({ type: "message_end", message: message("Working", "toolUse") }));
  s.feed(event({ type: "agent_end", messages: [message("Working", "toolUse")] }));
  s.feed(event({ type: "message_end", message: { role: "toolResult", usage: { ...emptyUsage(), input: 1, totalTokens: 1 } } }));
  s.feed(event({ type: "message_end", message: message("Final answer") }));
  s.feed(event({ type: "agent_settled", aborted: false }));
  assert.equal(s.finalText, "Final answer");
  assert.equal(s.usage.input, 5);
  assert.equal(s.usage.totalTokens, 11);
});

test("zero exit code does not mask failed, truncated, aborted, empty or unfinished responses", () => {
  for (const stopReason of ["error", "aborted", "length", "toolUse", "pending"]) {
    const s = state();
    s.feed(event({ type: "message_end", message: message("Partial", stopReason) }));
    s.feed(event({ type: "agent_settled", aborted: false }));
    assert.ok(s.failure(0), stopReason);
  }
  const s = state();
  assert.ok(s.failure(0));
  s.feed(event({ type: "message_end", message: message("") }));
  s.feed(event({ type: "agent_settled", aborted: false }));
  assert.match(s.failure(0)!, /no final text/);
  assert.match(s.failure(7)!, /status 7/);
});

test("recovered retries succeed and activity stays bounded", () => {
  const s = state();
  s.feed(event({ type: "message_end", message: { ...message("", "error"), errorMessage: "overloaded" } }));
  for (let i = 0; i < 100; i++) s.feed(event({ type: "tool_execution_start", toolName: "read", args: { path: `${i}.ts` } }));
  s.feed(event({ type: "message_end", message: message("Recovered") }));
  s.feed(event({ type: "agent_settled", aborted: false }));
  assert.equal(s.failure(0), undefined);
  assert.equal(s.details.activity.length, 80);
  assert.equal(s.details.toolCalls, 100);
});

test("malformed records fail rather than silently dropping protocol data", () => {
  assert.throws(() => state().feed("not json\n"));
  assert.throws(() => state().feed('{"type":', true));
});

test("oneshot_subagent tool events are ordinary activity and never create nested runs", () => {
  const s = state();
  s.feed(event({ type: "tool_execution_start", toolName: "oneshot_subagent", toolCallId: "nested-1", args: { name: "grandchild", task: "Inspect files" } }));
  s.feed(event({ type: "tool_execution_end", toolName: "oneshot_subagent", toolCallId: "nested-1", result: {}, isError: true }));
  assert.equal(s.details.children, undefined);
  assert.equal(s.details.toolCalls, 1);
  assert.deepEqual(s.details.activity, ["→ oneshot_subagent grandchild", "✗ oneshot_subagent failed"]);
});

const callUsage = (input: number, output: number, cacheRead: number, cacheWrite: number) =>
  ({ ...emptyUsage(), input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite });

test("latest model call replaces the display breakdown while run accounting keeps summing", () => {
  const s = state();
  s.feed(event({ type: "message_end", message: { ...message("Calling tool", "toolUse"), usage: callUsage(10, 1, 100, 5) } }));
  s.feed(event({ type: "message_end", message: { ...message("Final answer"), usage: callUsage(2, 3, 4, 0) } }));
  s.feed(event({ type: "agent_settled", aborted: false }));
  assert.deepEqual(s.details.latestCallUsage, { input: 2, output: 3, cacheRead: 4, cacheWrite: 0 });
  assert.equal(s.usage.input, 12);
  assert.equal(s.usage.output, 4);
  assert.equal(s.usage.cacheRead, 104);
  assert.equal(s.usage.cacheWrite, 5);
  assert.equal(s.usage.totalTokens, 125);
});

test("tool result usage is counted in run accounting but never replaces the latest model call", () => {
  const s = state();
  s.feed(event({ type: "message_end", message: { ...message("Calling tool", "toolUse"), usage: callUsage(2, 3, 4, 0) } }));
  s.feed(event({ type: "message_end", message: { role: "toolResult", usage: callUsage(50, 60, 0, 7) } }));
  assert.deepEqual(s.details.latestCallUsage, { input: 2, output: 3, cacheRead: 4, cacheWrite: 0 });
  assert.equal(s.usage.input, 52);
  assert.equal(s.usage.cacheWrite, 7);
});

test("an assistant message without usage clears older call data instead of showing it as latest", () => {
  const s = state();
  s.feed(event({ type: "message_end", message: { ...message("Calling tool", "toolUse"), usage: callUsage(2, 3, 4, 0) } }));
  s.feed(event({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "No usage" }], stopReason: "stop" } }));
  assert.equal(s.details.latestCallUsage, undefined);
});

test("zero-count model calls are reported as completed calls", () => {
  const s = state();
  s.feed(event({ type: "message_end", message: { ...message("Done"), usage: callUsage(0, 0, 0, 0) } }));
  assert.deepEqual(s.details.latestCallUsage, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
});

test("no latest call exists before a model call completes, even after tool results", () => {
  const s = state();
  s.feed(event({ type: "tool_execution_start", toolName: "read", args: { path: "a.ts" } }));
  s.feed(event({ type: "message_end", message: { role: "toolResult", usage: callUsage(1, 1, 1, 1) } }));
  assert.equal(s.details.latestCallUsage, undefined);
  assert.equal(s.usage.input, 1);
});
