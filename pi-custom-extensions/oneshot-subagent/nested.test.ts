import assert from "node:assert/strict";
import { test } from "node:test";
import { settleNested, updateNested } from "./nested.ts";
import type { RunDetails } from "./events.ts";

const parent = (): RunDetails => ({ name: "child", task: "Parent task", cwd: "/project", status: "running", activity: [], preview: "", turns: 0, toolCalls: 0, durationMs: 0, depth: 1, maxDepth: 2 });

test("start records task and partial/final updates replace snapshots without mutating previous updates", () => {
  const details = parent();
  updateNested(details, "call-1", { name: "grandchild", task: "Inspect API" });
  const starting = details.children!;
  assert.equal(starting[0].task, "Inspect API");
  assert.equal(starting[0].depth, 2);
  updateNested(details, "call-1", undefined, { details: { activity: ["→ read api.ts"], preview: "Working" } });
  const partial = details.children!;
  assert.deepEqual(starting[0].activity, []);
  updateNested(details, "call-1", undefined, { details: { status: "success", result: "## Findings\nNo issues", jobDir: "/tmp/job" } }, false);
  assert.equal(details.children!.length, 1);
  assert.equal(details.children![0].task, "Inspect API");
  assert.equal(details.children![0].result, "## Findings\nNo issues");
  assert.equal(partial[0].status, "running");
});

test("same-named parallel runs correlate by toolCallId, including codemode nested ids", () => {
  const details = parent();
  updateNested(details, "codemode/1", { name: "review", task: "First task" });
  updateNested(details, "call-2", { name: "review", task: "Second task" });
  updateNested(details, "call-2", undefined, { details: { result: "Second answer", status: "success" } }, false);
  updateNested(details, "codemode/1", undefined, { details: { result: "First answer", status: "success" } }, false);
  assert.deepEqual(details.children!.map((child) => [child.task, child.result]), [["First task", "First answer"], ["Second task", "Second answer"]]);
});

test("error results without details retain the original task and error text", () => {
  const details = parent();
  updateNested(details, "denied", { task: "Do work" });
  updateNested(details, "denied", undefined, { content: [{ type: "text", text: "Blocked by safe mode" }] }, true);
  assert.equal(details.children![0].status, "error");
  assert.equal(details.children![0].task, "Do work");
  assert.equal(details.children![0].result, "Blocked by safe mode");
});

test("recursive snapshots persist deeper task/activity/results without exposing arbitrary fields", () => {
  const details = parent();
  updateNested(details, "outer", { task: "Task 2" }, { details: {
    children: [{ ...parent(), toolCallId: "inner", name: "deep", task: "Task 3", activity: ["→ read deep.ts"], status: "success", result: "Deep answer", secret: "not-display-data" }],
  } });
  assert.equal(details.children![0].children![0].result, "Deep answer");
  assert.ok(!JSON.stringify(details.children).includes("not-display-data"));
});

test("bounded snapshots keep correlation ids, cap text and number of runs, and flag omissions", () => {
  const details = parent();
  for (let i = 0; i < 40; i++) updateNested(details, `call-${i}`, { task: "x".repeat(50000) }, { details: { result: "y".repeat(50000) } });
  assert.equal(details.children!.length, 32);
  assert.ok(JSON.stringify(details.children).length < 280000);
  assert.ok(details.children!.some((child) => child.displayTruncated));
  assert.equal(details.children![31].toolCallId, "call-31");
  updateNested(details, "call-31", undefined, { details: { status: "success", result: "Final" } }, false);
  assert.equal(details.children![31].status, "success");
  const omitted = parent();
  for (let i = 0; i < 40; i++) updateNested(omitted, `call-${i}`, { task: "task" });
  assert.equal(omitted.childrenOmitted, 8);
  updateNested(omitted, "call-39", { task: "task" }, { details: { preview: "partial" } });
  assert.equal(omitted.childrenOmitted, 8);
});

test("incomplete descendants are settled on parent cancellation or failure", () => {
  const details = parent();
  updateNested(details, "running", { task: "Work" });
  updateNested(details, "done", { task: "Done" }, { details: { status: "success", result: "Okay" } }, false);
  details.status = "aborted";
  settleNested(details);
  assert.equal(details.children![0].status, "aborted");
  assert.match(details.children![0].result!, /cancelled/);
  assert.equal(details.children![1].status, "success");
});
