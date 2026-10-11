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

test("JSON tool events carry nested task/activity/response without double-counting usage", () => {
  const s = state();
  s.feed(event({ type: "tool_execution_start", toolName: "oneshot_subagent", toolCallId: "nested-1", args: { name: "grandchild", task: "Inspect files" } }));
  assert.equal(s.details.children![0].task, "Inspect files");
  s.feed(event({ type: "tool_execution_update", toolName: "oneshot_subagent", toolCallId: "nested-1", args: {}, partialResult: {
    details: { status: "running", activity: ["→ read file.ts"], preview: "Analyzing" },
  } }));
  assert.equal(s.details.children![0].preview, "Analyzing");
  const result = { content: [{ type: "text", text: "Final nested answer" }], details: { status: "success", result: "Final nested answer" },
    usage: { ...emptyUsage(), input: 11, totalTokens: 11 } };
  s.feed(event({ type: "tool_execution_end", toolName: "oneshot_subagent", toolCallId: "nested-1", result, isError: false }));
  s.feed(event({ type: "message_end", message: { role: "toolResult", toolName: "oneshot_subagent", toolCallId: "nested-1", ...result, isError: false } }));
  assert.equal(s.details.children!.length, 1);
  assert.equal(s.details.children![0].result, "Final nested answer");
  assert.deepEqual(s.details.children![0].activity, ["→ read file.ts"]);
  assert.equal(s.usage.input, 11);
  assert.equal(s.finalText, "");
});
