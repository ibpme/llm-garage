import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { AgentJobs } from "../shared/agent-jobs/jobs.ts";
import { tryGetForegroundWaits } from "../shared/agent-jobs/foreground.ts";
import type { ToolSet } from "../tool-set/contracts.ts";
import { publishToolSet } from "../tool-set/service.ts";
import oneshotSubagentExtension from "./index.ts";
import { CHILD_ENV, ROLE_ENTRY } from "./role.ts";
import type { RunDetails } from "./events.ts";
import { installFakeAgents, stopFakeAgents } from "./fake-agents.fixture.ts";
import type { ReceiptDetails } from "./index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const supervisor = resolve(here, "supervisor.ts");
const scratch = await mkdtemp(join(tmpdir(), "oneshot-index-test-"));
test.after(() => rm(scratch, { recursive: true, force: true }));

interface Options { configPath?: string; keybindingsPath?: string }
const missing = () => ({ configPath: join(scratch, "missing-config.json"), keybindingsPath: join(scratch, "missing-keys.json") });

function register(env: Record<string, string> = {}, jobs?: AgentJobs, sessionId = "session-1", options: Options = {}) {
  const tools: ToolDefinition<any>[] = [];
  const shortcuts = new Map<string, (ctx: unknown) => Promise<void> | void>();
  const handlers = new Map<string, (...args: any[]) => any>();
  const entries: any[] = [];
  const messages: { message: any; options: any }[] = [];
  const previous = process.env[CHILD_ENV];
  delete process.env[CHILD_ENV];
  Object.assign(process.env, env);
  try {
    oneshotSubagentExtension({
      registerTool: (value: ToolDefinition<any>) => { tools.push(value); },
      registerMessageRenderer: () => {},
      registerCommand: () => {},
      sendMessage: (message: unknown, options: unknown) => messages.push({ message, options }),
      appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
      on: (event: string, handler: (...args: any[]) => any) => { handlers.set(event, handler); },
      registerShortcut: (key: string, value: { handler: (ctx: unknown) => Promise<void> | void }) => { shortcuts.set(key, value.handler); },
    } as unknown as ExtensionAPI, jobs ?? new AgentJobs({ root: join(scratch, "unused-state"), supervisor }), { ...missing(), ...options });
  } finally {
    if (previous === undefined) delete process.env[CHILD_ENV]; else process.env[CHILD_ENV] = previous;
  }
  const sessionManager = {
    getEntries: () => entries, getSessionId: () => sessionId, getSessionFile: () => `/sessions/${sessionId}.jsonl`,
    getLeafId: () => "leaf-1", getBranch: () => [{ id: "leaf-1" }],
  };
  const context = { ...ctx, hasUI: false, sessionManager };
  const notices: string[] = [];
  let choose: (options: string[]) => string | undefined = (options) => options[0];
  const ui = { notify: (message: string) => notices.push(message), select: async (_title: string, options: string[]) => choose(options) };
  const instance = { shortcuts, notices, choose: (pick: typeof choose) => { choose = pick; },
    background: () => shortcuts.get("shift+up")!({ ...context, ui }),
    get tool() { return tools.find((tool) => tool.name === "oneshot_subagent"); },
    get jobsTool() { return tools.find((tool) => tool.name === "subagent_jobs"); }, tools, handlers, entries, messages, context,
    start: async () => { await handlers.get("session_start")!({}, context); return instance; } };
  return instance;
}
const ctx = { cwd: "/tmp", model: { id: "parent-model", provider: "parent-provider" }, thinkingLevel: "high" } as ExtensionToolContext;

const cancelled = () => { const controller = new AbortController(); controller.abort(); return controller.signal; };

test("root registers the tool at session start, inherits model, and forwards already-aborted signals", async () => {
  const root = register();
  assert.equal(root.tools.length, 0, "role is unknown until the session is read");
  await root.start();
  assert.deepEqual(root.tools.map((tool) => tool.name), ["oneshot_subagent", "subagent_jobs"]);
  await root.start();
  assert.equal(root.tools.length, 2, "registered once");
  assert.equal(root.tool?.name, "oneshot_subagent");
  assert.equal(root.tool?.renderShell, "self", "must not use Pi's colored tool shell");
  assert.equal(root.tool?.exposure, "direct");
  assert.doesNotMatch(root.tool!.description, /depth/i);
  const result = await root.tool!.execute("call", { task: "Review code", mode: "foreground" }, cancelled(), undefined, ctx);
  assert.equal((result.details as RunDetails).model, "parent-model");
  assert.equal((result.details as RunDetails).status, "aborted");
  assert.equal(result.isError, true);
  assert.equal(root.entries.length, 0, "roots persist nothing");
  await root.handlers.get("session_shutdown")!({ reason: "quit" });
});

test("one-shot children never register the tool and persist their role once", async () => {
  const child = register({ [CHILD_ENV]: "1" });
  await child.start();
  await child.start();
  assert.equal(child.tools.length, 0);
  assert.equal(child.entries.length, 1);
  assert.equal(child.entries[0].customType, ROLE_ENTRY);
});

test("child identity is restored on reload/resume/fork without any environment marker", async () => {
  const child = register({ [CHILD_ENV]: "1" });
  await child.start();
  const resumed = register();
  resumed.entries.push(...child.entries);
  await resumed.start();
  assert.equal(resumed.tools.length, 0);
  assert.equal(resumed.entries.length, 1, "existing role entry is not duplicated");
  // Navigating to another branch re-runs session start with the same entries.
  await resumed.start();
  assert.equal(resumed.tools.length, 0);
});

test("a tool registered in a root session refuses to run if the process later turns out to be a child", async () => {
  const instance = await register().start();
  instance.entries.push({ type: "custom", customType: ROLE_ENTRY, data: { version: 1, role: "child" } });
  await instance.start();
  await assert.rejects(instance.tool!.execute("call", { task: "Review" }, undefined, undefined, ctx), /cannot delegate/);
});

test("SAFE no longer masks or rejects delegation", async () => {
  const blocked: string[] = [];
  const dispose = publishToolSet({ getMode: () => "safe", addBlockedTools: (names: string[]) => blocked.push(...names) } as unknown as ToolSet);
  try {
    const instance = await register().start();
    assert.deepEqual(blocked, []);
    for (const agent of ["pi", "claude"] as const) {
      const result = await instance.tool!.execute("call", { task: "Review", agent, mode: "foreground" }, cancelled(), undefined, ctx);
      assert.equal((result.details as RunDetails).status, "aborted");
    }
  } finally { dispose(); }
});

test("validates blank task and provider without model before launching", async () => {
  const { tool } = await register().start();
  await assert.rejects(tool!.execute("call", { task: " " }, undefined, undefined, ctx), /blank/);
  await assert.rejects(tool!.execute("call", { task: "Review", provider: "other" }, undefined, undefined, ctx), /requires an explicit model/);
});

test("Claude ignores provider without model, does not inherit Pi defaults, and validates effort", async () => {
  const { tool } = await register().start();
  const result = await tool!.execute("call", { task: "Review", agent: "claude", provider: "ignored", mode: "foreground" }, cancelled(), undefined, ctx);
  assert.equal((result.details as RunDetails).agent, "claude");
  assert.equal((result.details as RunDetails).model, undefined);
  await assert.rejects(tool!.execute("call", { task: "Review", agent: "claude", thinking: "off" }, cancelled(), undefined, ctx), /no exact equivalent/);
});

test("background mode: receipt, owner-scoped retrieval, usage once, notices, reminder and shutdown survival", async (t) => {
  const root = await mkdtemp(join(scratch, "bg-"));
  const bin = await installFakeAgents(root);
  const previous = { PATH: process.env.PATH, ONESHOT_TEST_CASE: process.env.ONESHOT_TEST_CASE };
  process.env.PATH = `${bin}:${process.env.PATH}`;
  const jobs = new AgentJobs({ root: join(root, "state"), supervisor });
  const configPath = join(root, "oneshot-subagent.json");
  await writeFile(configPath, JSON.stringify({ defaultMode: "background", allowBackgroundShortcut: true }));
  const owner = await register({}, jobs, "owner-session", { configPath }).start();
  const other = await register({}, jobs, "other-session", { configPath }).start();
  const run = (instance: typeof owner, tool: "tool" | "jobsTool", params: Record<string, unknown>, signal?: AbortSignal) =>
    instance[tool]!.execute("call-1", params, signal, undefined, instance.context as unknown as ExtensionToolContext);
  const reminder = async (instance: typeof owner) => {
    const result = await instance.handlers.get("context")!({ messages: [{ role: "user", content: "hi" }] }, instance.context);
    return result?.messages?.at(-1);
  };
  try {
    await t.test("configured background default: launch returns a receipt promptly, not an answer", async () => {
      process.env.ONESHOT_TEST_CASE = "hang";
      const receipt = await run(owner, "tool", { task: "Long task", name: "long" });
      assert.equal(receipt.isError, undefined);
      const details = receipt.details as { kind: string; jobId: string };
      assert.equal(details.kind, "background-receipt");
      assert.match((receipt.content[0] as { text: string }).text, /receipt, not its answer/);
      assert.equal(receipt.usage, undefined, "receipts carry no usage");
      const running = await run(owner, "jobsTool", { action: "result", job_id: details.jobId });
      assert.notEqual(running.isError, true, "a running job's result is its state, not an error");
      assert.match((running.content[0] as { text: string }).text, /no result yet/);
      const last = await reminder(owner);
      assert.equal(last.role, "custom");
      assert.match(last.content, new RegExp(details.jobId));
      assert.equal(await reminder(other), undefined, "other sessions get no reminder");
      await assert.rejects(run(other, "jobsTool", { action: "result", job_id: details.jobId }), /No subagent job/);
      await assert.rejects(run(other, "jobsTool", { action: "cancel", job_id: details.jobId }), /No subagent job/);
      // Reload/exit must not cancel accepted background jobs.
      await owner.handlers.get("session_shutdown")!({ reason: "quit" });
      await owner.start();
      assert.equal((await jobs.inspect(details.jobId))?.status.state, "running");
      const cancelled = await run(owner, "jobsTool", { action: "cancel", job_id: details.jobId });
      assert.notEqual(cancelled.isError, true);
      assert.match((cancelled.content[0] as { text: string }).text, /cancelled/);
      assert.match((cancelled.content[0] as { text: string }).text, /partial file changes/);
    });

    await t.test("cancelling a subagent_jobs wait stops waiting only", async () => {
      process.env.ONESHOT_TEST_CASE = "hang";
      const jobId = ((await run(owner, "tool", { task: "Hang", name: "waited" })).details as ReceiptDetails).jobId;
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 300);
      const started = Date.now();
      const waited = await run(owner, "jobsTool", { action: "wait", job_ids: [jobId], timeout_seconds: 60 }, controller.signal);
      assert.ok(Date.now() - started < 10_000, "the wait returned when cancelled");
      assert.match((waited.content[0] as { text: string }).text, /no result yet/);
      assert.equal((await jobs.inspect(jobId))!.status.state, "running", "the job keeps running");
      await run(owner, "jobsTool", { action: "cancel", job_id: jobId });
    });

    await t.test("an explicit foreground mode overrides the background default", async () => {
      process.env.ONESHOT_TEST_CASE = "success";
      const result = await run(owner, "tool", { task: "Wait for it", name: "fg-explicit", mode: "foreground" });
      assert.equal((result.details as RunDetails).status, "success");
      assert.match((result.content[0] as { text: string }).text, /Final 😀 answer/);
      assert.equal(result.usage?.input, 7);
    });

    await t.test("wait retrieves the answer and reports usage exactly once", async () => {
      process.env.ONESHOT_TEST_CASE = "success";
      const receipt = await run(owner, "tool", { task: "Quick task", name: "quick" });
      const jobId = (receipt.details as { jobId: string }).jobId;
      const waited = await run(owner, "jobsTool", { action: "wait", job_ids: [jobId], timeout_seconds: 20 });
      assert.notEqual(waited.isError, true);
      assert.match((waited.content[0] as { text: string }).text, /Final 😀 answer/);
      assert.equal(waited.usage?.input, 7);
      const again = await run(owner, "jobsTool", { action: "result", job_id: jobId });
      assert.match((again.content[0] as { text: string }).text, /Final 😀 answer/);
      assert.equal(again.usage, undefined, "usage is never reported twice");
      assert.ok((await jobs.inspect(jobId))?.markers.has("delivered"));
    });

    await t.test("failed jobs are retrieved as errors with the partial-changes warning; notices are sent once without a turn", async () => {
      process.env.ONESHOT_TEST_CASE = "error";
      const receipt = await run(owner, "tool", { task: "Failing task", name: "failing" });
      const jobId = (receipt.details as { jobId: string }).jobId;
      await jobs.wait([jobId], 15_000);
      const before = owner.messages.length;
      for (let i = 0; i < 60 && !owner.messages.slice(before).some((item) => item.message.content.includes(jobId)); i++)
        await new Promise((resolveWait) => setTimeout(resolveWait, 100));
      const notices = owner.messages.filter((item) => item.message.content.includes(jobId));
      assert.equal(notices.length, 1);
      assert.deepEqual(notices[0].options, { triggerTurn: false });
      assert.equal(notices[0].message.customType, "subagent-job-notice");
      assert.ok(!other.messages.some((item) => item.message.content.includes(jobId)), "never delivered to another session");
      assert.match((await reminder(owner)).content, new RegExp(jobId), "a notice alone does not clear the reminder");
      const result = await run(owner, "jobsTool", { action: "result", job_id: jobId });
      assert.equal(result.isError, true);
      assert.match((result.content[0] as { text: string }).text, /failed: .*provider failed/);
      assert.match((result.content[0] as { text: string }).text, /partial file changes/);
      assert.equal(result.usage?.input, 7, "partial usage is still counted once");
      assert.equal(await reminder(owner), undefined, "reminder disappears once everything is delivered");
    });

    await t.test("concurrency limit names the active jobs", async () => {
      process.env.ONESHOT_TEST_CASE = "hang";
      const ids: string[] = [];
      for (let i = 0; i < 4; i++) ids.push(((await run(owner, "tool", { task: "Hang", name: `h${i}` })).details as { jobId: string }).jobId);
      await assert.rejects(run(owner, "tool", { task: "One too many" }), new RegExp(`At most 4.*${ids[0]}`));
      const other4 = await run(other, "tool", { task: "Other session is independent", name: "other" });
      for (const id of [...ids, (other4.details as { jobId: string }).jobId]) {
        const job = await jobs.inspect(id);
        await jobs.cancel(id, job!.request.owner.sessionId);
      }
    });

    await t.test("pre-aborted background launches fail without creating a job", async () => {
      const before = (await jobs.list()).length;
      await assert.rejects(run(owner, "tool", { task: "Never" }, cancelled()));
      assert.equal((await jobs.list()).length, before);
    });
  } finally {
    await owner.handlers.get("session_shutdown")!({ reason: "quit" });
    await other.handlers.get("session_shutdown")!({ reason: "quit" });
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await stopFakeAgents(root);
  }
});

test("children register neither delegation nor job tools", async () => {
  const child = await register({ [CHILD_ENV]: "1" }).start();
  assert.deepEqual(child.tools, []);
  assert.equal(await child.handlers.get("context")!({ messages: [] }, child.context), undefined);
});

test("session_shutdown aborts in-flight foreground runs for every reason", async () => {
  const root = await mkdtemp(join(scratch, "fg-"));
  const bin = await installFakeAgents(root);
  const previous = { PATH: process.env.PATH, ONESHOT_TEST_CASE: process.env.ONESHOT_TEST_CASE };
  process.env.PATH = `${bin}:${process.env.PATH}`;
  process.env.ONESHOT_TEST_CASE = "hang";
  try {
    await Promise.all((["quit", "reload", "new", "resume", "fork"] as const).map(async (reason) => {
      const instance = await register({}, new AgentJobs({ root: join(root, "state"), supervisor })).start();
      const pending = instance.tool!.execute("call", { task: "Hang", mode: "foreground", cwd: root }, undefined, undefined,
        instance.context as unknown as ExtensionToolContext);
      await new Promise((resolveWait) => setTimeout(resolveWait, 300));
      await instance.handlers.get("session_shutdown")!({ reason });
      const result = await pending;
      assert.equal((result.details as RunDetails).status, "aborted", reason);
    }));
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await stopFakeAgents(root);
  }
});

test("config: missing file keeps foreground default and the shortcut; disabling it registers no shortcut", async () => {
  const defaults = await register().start();
  assert.deepEqual([...defaults.shortcuts.keys()], ["shift+up"]);
  assert.match(defaults.tool!.description, /Default mode here: "foreground"/);
  assert.match(defaults.tool!.promptSnippet!, /waits for the answer by default/);
  const configPath = join(scratch, "no-shortcut.json");
  await writeFile(configPath, JSON.stringify({ allowBackgroundShortcut: false }));
  const disabled = await register({}, undefined, "session-1", { configPath }).start();
  assert.equal(disabled.shortcuts.size, 0);
  const keybindingsPath = join(scratch, "keybindings.json");
  await writeFile(keybindingsPath, JSON.stringify({ "extensions.oneshotSubagent.background": ["alt+b", "ctrl+alt+b"] }));
  const rebound = register({}, undefined, "session-1", { keybindingsPath });
  assert.deepEqual([...rebound.shortcuts.keys()], ["alt+b", "ctrl+alt+b"]);
});

test("foreground jobs are supervised: answer, send to background, Esc and shortcut targeting", async (t) => {
  const root = await mkdtemp(join(scratch, "fg-bg-"));
  const bin = await installFakeAgents(root);
  const previous = { PATH: process.env.PATH, ONESHOT_TEST_CASE: process.env.ONESHOT_TEST_CASE };
  process.env.PATH = `${bin}:${process.env.PATH}`;
  const jobs = new AgentJobs({ root: join(root, "state"), supervisor });
  const owner = await register({}, jobs, "fg-owner").start();
  const run = (params: Record<string, unknown>, signal?: AbortSignal, updates?: RunDetails[]) =>
    owner.tool!.execute("call-fg", { cwd: root, ...params }, signal, updates && ((update: { details: unknown }) => { updates.push(update.details as RunDetails); }),
      owner.context as unknown as ExtensionToolContext);
  // Eligible only once the tool call has attached its wait, as the shortcut and /agents see it.
  const attached = async (count: number) => {
    for (let i = 0; i < 300; i++) {
      const ids = tryGetForegroundWaits()?.attached("fg-owner").map((job) => job.jobId) ?? [];
      if (ids.length >= count) return Promise.all(ids.map(async (id) => (await jobs.inspect(id))!));
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
    assert.fail(`expected ${count} attached foreground jobs`);
  };
  try {
    await t.test("default foreground returns the final answer with usage once and no completion notice", async () => {
      process.env.ONESHOT_TEST_CASE = "success";
      const updates: RunDetails[] = [];
      const result = await run({ task: "Quick", name: "quick" }, undefined, updates);
      const details = result.details as RunDetails;
      assert.equal(details.status, "success");
      assert.match((result.content[0] as { text: string }).text, /Final 😀 answer/);
      assert.equal(result.usage?.input, 7);
      assert.deepEqual(details.latestCallUsage, { input: 7, output: 3, cacheRead: 0, cacheWrite: 0 });
      assert.ok(updates.some((update) => update.status === "running"), "progress is streamed while waiting");
      const [job] = await jobs.list({ owner: "fg-owner" });
      assert.equal(job.waitPolicy, "foreground");
      assert.ok(job.markers.has("delivered") && job.markers.has("usage-delivered"));
      const again = await owner.jobsTool!.execute("call", { action: "result", job_id: job.id }, undefined, undefined, owner.context as unknown as ExtensionToolContext);
      assert.equal(again.usage, undefined, "usage is not counted twice");
      await new Promise((resolveWait) => setTimeout(resolveWait, 1500));
      assert.ok(!owner.messages.some((item) => item.message.content.includes(job.id)), "foreground answers are never announced");
    });

    await t.test("no eligible job: the shortcut only informs", async () => {
      await owner.background();
      assert.match(owner.notices.at(-1)!, /No foreground subagent is running/);
    });

    await t.test("the shortcut releases the same running job with a receipt; shutdown no longer cancels it", async () => {
      process.env.ONESHOT_TEST_CASE = "hang";
      const pending = run({ task: "Slow", name: "slow", timeout_seconds: 120 });
      const [job] = await attached(1);
      await owner.background();
      const receipt = await pending;
      const details = receipt.details as ReceiptDetails;
      assert.equal(details.kind, "background-receipt");
      assert.equal(details.backgrounded, true);
      assert.equal(details.jobId, job.id);
      assert.equal(receipt.usage, undefined, "receipts carry no usage");
      assert.match((receipt.content[0] as { text: string }).text, /sent foreground subagent .* to the background.*original 120s timeout/s);
      const after = (await jobs.inspect(job.id))!;
      assert.equal(after.status.state, "running");
      assert.equal(after.waitPolicy, "background");
      assert.deepEqual(after.status.child, job.status.child, "the child was not restarted");
      assert.equal(after.request.deadline, job.request.deadline, "the deadline is unchanged");
      assert.equal(after.status.childDir, job.status.childDir);
      await owner.handlers.get("session_shutdown")!({ reason: "reload" });
      await owner.start();
      assert.equal((await jobs.inspect(job.id))!.status.state, "running", "a backgrounded job survives parent shutdown");
      await jobs.cancel(job.id, "fg-owner");
    });

    await t.test("multiple eligible jobs use a chooser; cancelling it changes nothing; /agents' service releases the other", async () => {
      process.env.ONESHOT_TEST_CASE = "hang";
      const first = run({ task: "One", name: "first" });
      const second = run({ task: "Two", name: "second" });
      const running = await attached(2);
      let offered: string[] = [];
      owner.choose((options) => { offered = options; return undefined; });
      await owner.background();
      assert.equal(offered.length, 2);
      assert.ok(offered.every((label) => /\(job-[0-9a-f]{12}\)$/.test(label)));
      owner.choose((options) => options.find((label) => label.startsWith("second")));
      await owner.background();
      const receipt = await second;
      assert.equal((receipt.details as ReceiptDetails).name, "second");
      const firstJob = running.find((job) => job.request.name === "first")!;
      assert.equal((await jobs.inspect(firstJob.id))!.waitPolicy, "foreground", "the other wait stays attached");
      // The published service is the path /agents uses.
      const service = tryGetForegroundWaits()!;
      assert.deepEqual(service.attached("fg-owner").map((job) => job.jobId), [firstJob.id]);
      assert.equal(await service.sendToBackground(firstJob.id, "other-session"), "not-attached", "only the owner can release it");
      assert.equal(await service.sendToBackground(firstJob.id, "fg-owner"), "backgrounded");
      const released = await first;
      assert.equal((released.details as ReceiptDetails).jobId, firstJob.id);
      assert.equal(await service.sendToBackground(firstJob.id, "fg-owner"), "not-attached", "a released wait is gone");
      for (const id of [firstJob.id, (receipt.details as ReceiptDetails).jobId]) await jobs.cancel(id, "fg-owner");
    });

    await t.test("Esc on a foreground call cancels its job", async () => {
      process.env.ONESHOT_TEST_CASE = "hang";
      const controller = new AbortController();
      const pending = run({ task: "Cancel me", name: "esc" }, controller.signal);
      const [job] = await attached(1);
      controller.abort();
      const result = await pending;
      assert.equal((result.details as RunDetails).status, "aborted");
      assert.equal(result.isError, true);
      assert.equal((await jobs.inspect(job.id))!.status.state, "cancelled");
    });

    await t.test("an explicit background mode overrides the foreground default", async () => {
      process.env.ONESHOT_TEST_CASE = "success";
      const receipt = await run({ task: "Bg", name: "explicit", mode: "background" });
      assert.equal((receipt.details as ReceiptDetails).backgrounded, false);
      assert.match((receipt.content[0] as { text: string }).text, /was accepted and (is|has already finished)/);
    });
  } finally {
    await owner.handlers.get("session_shutdown")!({ reason: "quit" });
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await stopFakeAgents(root);
  }
});

test("a release that loses to completion returns the answer, never a receipt", async () => {
  const { AttachedWaits } = await import("./foreground.ts");
  const waits = new AttachedWaits();
  const wait = waits.attach({ jobId: "job-000000000001", name: "done", owner: "s" });
  assert.equal(wait.settle("completed"), true);
  assert.deepEqual(waits.attached("s"), [], "a settled wait is no longer eligible");
  assert.equal(await waits.sendToBackground("job-000000000001", "s"), "completed");
  assert.equal(wait.settled, "completed");
  assert.equal(await waits.sendToBackground("job-000000000001", "other"), "not-attached");
  const next = waits.attach({ jobId: "job-000000000002", name: "next", owner: "s" });
  let woken = false;
  void next.wake.then(() => { woken = true; });
  assert.equal(await waits.sendToBackground(next.jobId, "s"), "backgrounded");
  await Promise.resolve();
  assert.ok(woken);
  assert.equal(next.settle("completed"), false, "completion after release cannot reclaim the call");
});
