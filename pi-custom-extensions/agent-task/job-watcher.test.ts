import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { AgentJobs, JobSnapshot } from "../shared/agent-jobs/jobs.ts";
import type { JobState, Marker } from "../shared/agent-jobs/store.ts";
import { indicatorLines, JobWatcher } from "./job-watcher.ts";
import { outstandingText, receiptText, resultText, runDetails } from "./job-results.ts";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;
let next = 0;
function job(state: JobState, markers: Marker[] = [], overrides: { anchor?: string; name?: string; liveness?: JobSnapshot["liveness"]; waitPolicy?: JobSnapshot["waitPolicy"] } = {}): JobSnapshot {
  const id = `job-${(next++).toString(16).padStart(12, "0")}`;
  return {
    id, dir: `/state/jobs/${id}`, markers: new Set(markers), waitPolicy: overrides.waitPolicy ?? "background", liveness: overrides.liveness ?? (["starting", "running", "cancelling"].includes(state) ? "live" : "ended"),
    request: { version: 1, id, name: overrides.name ?? "review-api", agent: "pi", cwd: "/work", createdAt: Date.now() - 65_000,
      timeoutSeconds: 1800, deadline: Date.now() + 1_000_000, launcher: "/x", owner: { sessionId: "s", branchAnchor: overrides.anchor } },
    status: { version: 1, id, seq: 3, state, updatedAt: Date.now(), finishedAt: state === "running" ? undefined : Date.now(),
      lastActivityAt: Date.now() - 45_000, terminalReason: state === "failed" ? "Pi exited with status 7" : undefined,
      details: { activity: ["→ read src/api.ts"], preview: "partial answer", turns: 1, toolCalls: 1, durationMs: 1 } },
  };
}

test("indicator: one compact line with counts and /agents hint; acknowledged and delivered jobs drop out", () => {
  const jobs = [job("running"), job("running"), job("succeeded"), job("failed"), job("failed", ["acknowledged"]), job("succeeded", ["delivered"]), job("running", [], { liveness: "unknown" })];
  const [line, ...rest] = indicatorLines(jobs, theme, 100, false);
  assert.equal(rest.length, 0);
  assert.match(line, /^Agents {2}2 running · 1 unknown · 1 ready · 1 failed +\/agents$/);
  assert.equal(visibleWidth(line), 100);
  assert.deepEqual(indicatorLines([job("succeeded", ["delivered"])], theme, 100, false), []);
  for (const width of [1, 10, 30]) for (const item of indicatorLines(jobs, theme, width, true)) assert.ok(visibleWidth(item) <= width);
});

test("indicator expansion shows at most three named jobs with elapsed and quiet time, never progress percentages", () => {
  const jobs = [job("running", [], { name: "one" }), job("running", [], { name: "two" }), job("failed", [], { name: "three" }), job("succeeded", [], { name: "four" })];
  const lines = indicatorLines(jobs, theme, 120, true);
  assert.equal(lines.length, 5);
  assert.match(lines[1], /◌ one {2}running 1m 5s · quiet 45s · → read src\/api\.ts/);
  assert.match(lines[3], /✗ three {2}failed/);
  assert.match(lines[4], /1 more in \/agents/);
  assert.ok(!lines.some((line) => /%/.test(line)));
});

test("model-facing results: running is not an error, failures carry reason, partial answer and warning", async () => {
  const running = await resultText(job("running"));
  assert.equal(running.isError, false);
  assert.match(running.text, /no result yet.*Last activity 45s ago/s);
  const failed = await resultText({ ...job("failed"), status: { ...job("failed").status, stderrTail: "boom" } });
  assert.equal(failed.isError, true);
  assert.match(failed.text, /failed: Pi exited with status 7/);
  assert.match(failed.text, /partial file changes in \/work/);
  assert.match(failed.text, /Partial answer \(incomplete\):\npartial answer/);
  assert.match(failed.text, /stderr tail:\nboom/);
  const missing = await resultText(job("succeeded"));
  assert.equal(missing.isError, true, "a success without its result file is never presented as an answer");
  assert.equal(outstandingText([job("succeeded", ["delivered"])]), undefined);
  assert.match(outstandingText([job("running"), job("succeeded")])!, /running.*\n.*result not retrieved/);
});

test("notices are coalesced, sent once as a follow-up by default, and only while the launching branch is active", async () => {
  const sent: { message: { content: string }; options: unknown }[] = [];
  let branch = ["other-leaf"];
  const marks = new Set<string>();
  let listener: ((jobs: JobSnapshot[]) => void) | undefined;
  const store = {
    subscribe: (_query: unknown, callback: (jobs: JobSnapshot[]) => void) => { listener = callback; return () => {}; },
    mark: async (id: string, marker: string) => !marks.has(`${id}:${marker}`) && !!marks.add(`${id}:${marker}`),
  } as unknown as AgentJobs;
  const ctx = { hasUI: false, sessionManager: { getSessionId: () => "s", getBranch: () => branch.map((id) => ({ id })) } } as unknown as ExtensionContext;
  const watcher = new JobWatcher({ sendMessage: (message: never, options: unknown) => sent.push({ message, options }) } as unknown as ExtensionAPI, store, ctx);
  watcher.start();
  const jobs = [job("succeeded", [], { anchor: "leaf" }), job("failed", [], { anchor: "leaf" }), job("running", [], { anchor: "leaf" })];
  const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
  listener!(jobs);
  await settle();
  assert.equal(sent.length, 0, "the launching branch is not active");
  branch = ["root", "leaf", "later"];
  listener!(jobs);
  await settle();
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].options, { triggerTurn: true, deliverAs: "followUp" });
  assert.match(sent[0].message.content, new RegExp(`${jobs[0].id}.*\\n.*${jobs[1].id}.*Pi exited`, "s"));
  assert.doesNotMatch(sent[0].message.content, new RegExp(jobs[2].id));
  listener!(jobs.map((item) => ({ ...item, status: { ...item.status, seq: 9 } })));
  await settle();
  assert.equal(sent.length, 1, "each job is notified once");
  watcher.stop();
});

test("foreground jobs are never announced; once sent to the background they are", async () => {
  const sent: unknown[] = [];
  let listener: ((jobs: JobSnapshot[]) => void) | undefined;
  const store = {
    subscribe: (_query: unknown, callback: (jobs: JobSnapshot[]) => void) => { listener = callback; return () => {}; },
    mark: async () => true,
  } as unknown as AgentJobs;
  const ctx = { hasUI: false, sessionManager: { getSessionId: () => "s", getBranch: () => [] } } as unknown as ExtensionContext;
  const watcher = new JobWatcher({ sendMessage: (message: never) => sent.push(message) } as unknown as ExtensionAPI, store, ctx);
  watcher.start();
  const finished = job("succeeded", [], { waitPolicy: "foreground" });
  listener!([finished]);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(sent.length, 0, "a foreground answer is returned by its own tool call");
  listener!([{ ...finished, waitPolicy: "background", markers: new Set(["backgrounded"]) }]);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(sent.length, 1);
  watcher.stop();
});

test("receipts state the observed state and are labeled as receipts; run details use latest-call fields", () => {
  const running = job("running");
  assert.match(receiptText(running, false), /was accepted and is running for 1m 5s.*timeout 1800s.*This is a receipt, not its answer/s);
  const finished = job("succeeded");
  const released = receiptText(finished, true);
  assert.match(released, /sent foreground agent task .* to the background; it has already finished \(succeeded\)/);
  assert.match(released, /original 1800s timeout still applies/);
  assert.match(released, new RegExp(`"job_id":"${finished.id}"`));
  const latest = { input: 5, output: 2, cacheRead: 100, cacheWrite: 1 };
  const details = runDetails({ ...running, status: { ...running.status, details: { ...running.status.details, latestCallUsage: latest, contextWindow: 1000, totalTokens: 999 } } }, "Task");
  assert.equal(details.status, "running");
  assert.deepEqual(details.latestCallUsage, latest);
  assert.equal(details.contextWindow, 1000);
  assert.equal(details.task, "Task");
  assert.equal(runDetails(job("cancelled"), "Task").status, "aborted");
  assert.equal(runDetails(job("timed-out"), "Task").status, "error");
});

test("notice modes: steer wakes within the current run, passive never starts a turn", async () => {
  for (const [mode, expected] of [["steer", { triggerTurn: true, deliverAs: "steer" }], ["passive", { triggerTurn: false }]] as const) {
    const sent: unknown[] = [];
    let listener: ((jobs: JobSnapshot[]) => void) | undefined;
    const store = { subscribe: (_q: unknown, callback: (jobs: JobSnapshot[]) => void) => { listener = callback; return () => {}; }, mark: async () => true } as unknown as AgentJobs;
    const ctx = { hasUI: false, sessionManager: { getSessionId: () => "s", getBranch: () => [] } } as unknown as ExtensionContext;
    const watcher = new JobWatcher({ sendMessage: (_message: never, options: unknown) => sent.push(options) } as unknown as ExtensionAPI, store, ctx, mode);
    watcher.start();
    listener!([job("succeeded")]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(sent, [expected], mode);
    watcher.stop();
  }
});
