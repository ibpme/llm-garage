import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { AgentJobs, checkNode, type StartRequest } from "../shared/agent-jobs/jobs.ts";
import { jobDir, readStatus, writeStatus } from "../shared/agent-jobs/store.ts";
import { installFakeAgents, stopFakeAgents } from "./fake-agents.fixture.ts";
import { CHILD_NOTICE } from "./runner.ts";

const here = dirname(fileURLToPath(import.meta.url));
const launcher = resolve(here, "../../scripts/agent-spawn.sh");
const supervisor = resolve(here, "supervisor.ts");

async function assertGroupStopped(pid: number): Promise<void> {
  for (let i = 0; i < 60; i++) {
    try { process.kill(-pid, 0); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return; }
    await sleep(50);
  }
  assert.fail(`Process group ${pid} still exists`);
}

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms;
  while (true) {
    const value = await read();
    if (done(value) || Date.now() > deadline) return value;
    await sleep(50);
  }
}

test("detached supervisor runs background jobs independently of the launching process", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "oneshot-jobs-test-"));
  const bin = await installFakeAgents(root);
  const previous = { PATH: process.env.PATH, ONESHOT_TEST_CASE: process.env.ONESHOT_TEST_CASE };
  process.env.PATH = `${bin}:${process.env.PATH}`;
  const jobs = new AgentJobs({ root: join(root, "state"), supervisor });
  const request = (overrides: Partial<StartRequest> = {}): StartRequest => ({
    name: "bg", task: 'Literal $(touch unwanted) "task"', agent: "pi", model: "model-id", provider: "provider",
    cwd: root, timeoutSeconds: 10, owner: { sessionId: "owner-1", toolCallId: "call-1", branchAnchor: "leaf-1" }, launcher,
    ...overrides,
  });
  try {
    await t.test("success: prompt acknowledgement, durable private result, plain task kept", async () => {
      process.env.ONESHOT_TEST_CASE = "success";
      const started = Date.now();
      const receipt = await jobs.start(request());
      assert.ok(Date.now() - started < 5_000);
      assert.equal(receipt.status.state, "running");
      assert.ok(receipt.status.child && receipt.status.supervisor);
      const [done] = await jobs.wait([receipt.id], 15_000);
      assert.equal(done.status.state, "succeeded");
      assert.equal(done.liveness, "ended");
      assert.equal(done.status.usage?.input, 7);
      assert.equal(done.status.details.toolCalls, 1);
      assert.equal(await readFile(done.status.resultPath!, "utf8"), "Final 😀 answer");
      assert.equal(await readFile(join(done.dir, "task.md"), "utf8"), request().task);
      assert.equal((await stat(done.dir)).mode & 0o777, 0o700);
      for (const file of ["job.json", "status.json", "task.md"]) assert.equal((await stat(join(done.dir, file))).mode & 0o777, 0o600);
      const captured = JSON.parse(await readFile(join(root, "args.json"), "utf8"));
      assert.equal(captured.child, "1");
      assert.equal(captured.args.at(-1), CHILD_NOTICE + request().task);
      assert.deepEqual((await jobs.list({ owner: "owner-1" })).map((job) => job.id), [receipt.id]);
      assert.deepEqual(await jobs.list({ owner: "someone-else" }), []);
    });

    for (const mode of ["error", "exit"]) await t.test(`${mode} is recorded as failed with a reason`, async () => {
      process.env.ONESHOT_TEST_CASE = mode;
      const receipt = await jobs.start(request());
      const [done] = await jobs.wait([receipt.id], 15_000);
      assert.equal(done.status.state, "failed");
      assert.match(done.status.terminalReason!, mode === "error" ? /provider failed/ : /status 7/);
    });

    await t.test("snapshots carry latest-call tokens and capacity from the parent's verified table only", async () => {
      process.env.ONESHOT_TEST_CASE = "success";
      const verified = await jobs.start(request({ mode: "foreground", contextWindows: [["fake-provider", "fake-model", 200_000], ["other", "fake-model", 1]] }));
      const [done] = await jobs.wait([verified.id], 15_000);
      assert.deepEqual(done.status.details.latestCallUsage, { input: 7, output: 3, cacheRead: 0, cacheWrite: 0 });
      assert.equal(done.status.details.contextWindow, 200_000);
      assert.equal(done.status.details.totalTokens, 10, "cumulative accounting is kept separately");
      assert.equal(done.waitPolicy, "foreground");
      const unknown = await jobs.start(request());
      const [plain] = await jobs.wait([unknown.id], 15_000);
      assert.ok(plain.status.details.latestCallUsage);
      assert.equal(plain.status.details.contextWindow, undefined, "unknown capacity stays unknown");
      assert.equal(plain.waitPolicy, "background", "jobs without a mode are background");
    });

    await t.test("deadline stops the process group and records timed-out", async () => {
      process.env.ONESHOT_TEST_CASE = "hang";
      const receipt = await jobs.start(request({ timeoutSeconds: 1 }));
      const [done] = await jobs.wait([receipt.id], 15_000);
      assert.equal(done.status.state, "timed-out");
      await assertGroupStopped(done.status.child!.pid);
    });

    await t.test("owner cancellation is idempotent and stops the process group; others cannot cancel", async () => {
      process.env.ONESHOT_TEST_CASE = "hang";
      const receipt = await jobs.start(request());
      assert.equal((await jobs.cancel(receipt.id, "intruder")).outcome, "not-owner");
      const waited = await jobs.wait([receipt.id], 300);
      assert.equal(waited[0].status.state, "running", "bounded wait returns state without cancelling");
      const cancelled = await jobs.cancel(receipt.id, "owner-1");
      assert.equal(cancelled.outcome, "cancelled");
      assert.equal(cancelled.job?.status.state, "cancelled");
      await assertGroupStopped(receipt.status.child!.pid);
      assert.equal((await jobs.cancel(receipt.id, "owner-1")).outcome, "already-terminal");
      assert.equal((await jobs.cancel("job-000000000000", "owner-1")).outcome, "not-found");
    });

    await t.test("cancellation during launch leaves no untracked child", async () => {
      process.env.ONESHOT_TEST_CASE = "hang";
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 20);
      await assert.rejects(jobs.start(request({ name: "launch-cancel" }), controller.signal), /cancelled/);
      const job = (await jobs.list()).find((item) => item.request.name === "launch-cancel")!;
      assert.equal(job.status.state, "cancelled");
      if (job.status.child) await assertGroupStopped(job.status.child.pid);
      const preAborted = new AbortController(); preAborted.abort();
      const before = (await jobs.list()).length;
      await assert.rejects(jobs.start(request(), preAborted.signal));
      assert.equal((await jobs.list()).length, before, "pre-aborted launches create nothing");
    });

    await t.test("launch failure is a start error with the job path", async () => {
      await assert.rejects(jobs.start(request({ launcher: join(root, "missing.sh") })), /failed to start.*Launcher failed/s);
    });

    await t.test("a supervisor that dies during launch fails the start promptly", async () => {
      const broken = join(root, "broken-supervisor.ts");
      await writeFile(broken, 'console.error("boom from supervisor"); process.exit(3);\n');
      const started = Date.now();
      await assert.rejects(new AgentJobs({ root: jobs.root, supervisor: broken }).start(request({ name: "broken" })), /exited during launch:\n.*boom from supervisor/s);
      assert.ok(Date.now() - started < 5_000);
      const job = (await jobs.list()).find((item) => item.request.name === "broken");
      assert.equal(job?.status.state, "failed");
    });

    await t.test("jobs survive the launching process exiting", async () => {
      process.env.ONESHOT_TEST_CASE = "success";
      const script = `
        import { AgentJobs } from ${JSON.stringify(resolve(here, "../shared/agent-jobs/jobs.ts"))};
        const jobs = new AgentJobs({ root: ${JSON.stringify(join(root, "state"))}, supervisor: ${JSON.stringify(supervisor)} });
        const job = await jobs.start({ name: "orphan", task: "t", agent: "pi", cwd: ${JSON.stringify(root)}, timeoutSeconds: 10,
          owner: { sessionId: "exited-owner" }, launcher: ${JSON.stringify(launcher)} });
        console.log(job.id);
        process.exit(0);`;
      const id = await new Promise<string>((resolveId, reject) => execFile(process.execPath, ["--input-type=module", "-e", script],
        { env: process.env }, (error, stdout, stderr) => error ? reject(new Error(stderr)) : resolveId(stdout.trim())));
      const [done] = await jobs.wait([id], 15_000);
      assert.equal(done.status.state, "succeeded");
      assert.equal(done.request.owner.sessionId, "exited-owner");
    });

    await t.test("a crashed supervisor is reconciled: unknown while the child runs, then cancellable", async () => {
      process.env.ONESHOT_TEST_CASE = "hang";
      const receipt = await jobs.start(request());
      process.kill(receipt.status.supervisor!.pid, "SIGKILL");
      const orphaned = await until(() => jobs.inspect(receipt.id), (job) => job?.liveness === "unknown");
      assert.equal(orphaned?.liveness, "unknown");
      assert.equal(orphaned?.status.state, "running", "never fabricates an outcome");
      const cancelled = await jobs.cancel(receipt.id, "owner-1");
      assert.equal(cancelled.job?.status.state, "cancelled");
      await assertGroupStopped(receipt.status.child!.pid);
    });

    await t.test("a crashed supervisor with no surviving child is interrupted", async () => {
      process.env.ONESHOT_TEST_CASE = "hang";
      const receipt = await jobs.start(request());
      process.kill(receipt.status.supervisor!.pid, "SIGKILL");
      process.kill(-receipt.status.child!.pid, "SIGKILL");
      await assertGroupStopped(receipt.status.child!.pid);
      const job = await until(() => new AgentJobs({ root: jobs.root }).inspect(receipt.id), (item) => item?.status.state === "interrupted");
      assert.equal(job?.status.state, "interrupted");
      assert.match(job!.status.terminalReason!, /Supervisor exited/);
      // Terminal results are immutable.
      await writeStatus(jobs.root, { ...job!.status, state: "succeeded" });
      assert.equal((await readStatus(jobs.root, receipt.id))?.state, "interrupted");
    });

    await t.test("SIGTERM to the supervisor stops the child and records interrupted", async () => {
      process.env.ONESHOT_TEST_CASE = "hang";
      const receipt = await jobs.start(request());
      process.kill(receipt.status.supervisor!.pid, "SIGTERM");
      const [done] = await jobs.wait([receipt.id], 15_000);
      assert.equal(done.status.state, "interrupted");
      await assertGroupStopped(receipt.status.child!.pid);
    });

    await t.test("Claude backend runs through the supervisor", async () => {
      process.env.ONESHOT_TEST_CASE = "success";
      const receipt = await jobs.start(request({ agent: "claude", model: "sonnet", provider: undefined, effort: "high" }));
      const [done] = await jobs.wait([receipt.id], 15_000);
      assert.equal(done.status.state, "succeeded");
      assert.equal(done.status.usage?.cost.total, 0.02);
      assert.equal(done.status.details.usagePartial, false);
    });

    await t.test("directories without job metadata are ignored", async () => {
      await mkdir(join(jobs.root, "jobs", "job-aaaaaaaaaaaa"), { recursive: true });
      await mkdir(join(jobs.root, "jobs", "not-a-job"), { recursive: true });
      await mkdir(join(jobs.root, "oneshot-legacy", "x.123"), { recursive: true });
      const ids = (await new AgentJobs({ root: jobs.root }).list()).map((job) => job.id);
      assert.ok(!ids.includes("job-aaaaaaaaaaaa"));
      assert.equal(await new AgentJobs({ root: jobs.root }).inspect("../oneshot-legacy"), undefined);
    });

    await t.test("retention prunes only old delivered/acknowledged terminal jobs", async () => {
      const future = Date.now() + 15 * 24 * 60 * 60 * 1000;
      const later = new AgentJobs({ root: jobs.root, now: () => future, orphanAfterMs: Infinity });
      const all = await jobs.list();
      const [delivered, undelivered] = all.filter((job) => job.status.state === "failed");
      await jobs.mark(delivered.id, "delivered");
      const kept = (await later.list()).map((job) => job.id);
      assert.ok(!kept.includes(delivered.id));
      assert.ok(kept.includes(undelivered.id));
      await assert.rejects(stat(jobDir(jobs.root, delivered.id)));
    });

    await t.test("markers are claimed exactly once", async () => {
      const [job] = await jobs.list();
      const claims = await Promise.all([1, 2, 3].map(() => jobs.mark(job.id, "usage-delivered")));
      assert.deepEqual(claims.filter(Boolean).length, 1);
    });

    await t.test("Node without default type stripping is refused", async () => {
      const fake = join(bin, "old-node");
      await writeFile(fake, "#!/bin/bash\necho 'v20.11.0 false'\n", { mode: 0o755 });
      await assert.rejects(checkNode(fake), /type stripping/);
      await assert.rejects(new AgentJobs({ root: jobs.root, supervisor, node: fake }).start(request()), /v20\.11\.0/);
      await checkNode(process.execPath);
    });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await sleep(100);
    await stopFakeAgents(root);
    await rm(root, { recursive: true, force: true });
  }
});

