import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { CHILD_NOTICE, runSubagent, type RunOptions } from "./runner.ts";
import { installFakeAgents, stopFakeAgents } from "./fake-agents.fixture.ts";

const launcher = resolve(dirname(fileURLToPath(import.meta.url)), "../../scripts/agent-spawn.sh");

async function assertGroupStopped(pid: number): Promise<void> {
  for (let i = 0; i < 40; i++) {
    try { process.kill(-pid, 0); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return; }
    await sleep(50);
  }
  assert.fail(`Process group ${pid} still exists`);
}

test("real agent-spawn JSON launcher with fake Pi/Claude: results, failures, cancellation and timeout", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "oneshot-test-"));
  const bin = await installFakeAgents(root);
  const previous = { PATH: process.env.PATH, ONESHOT_TEST_CASE: process.env.ONESHOT_TEST_CASE };
  process.env.PATH = `${bin}:${process.env.PATH}`;
  const updates: string[] = [];
  const options = (overrides: Partial<RunOptions> = {}): RunOptions => ({
    launcher, name: "test", task: 'Literal $(touch unwanted) ; "quoted" task', cwd: root,
    model: "model-id", provider: "provider", thinking: "high", timeoutSeconds: 10,
    signal: new AbortController().signal, outputRoot: join(root, "jobs"),
    onProgress: (details) => updates.push(details.status), ...overrides,
  });
  try {
    await t.test("success forwards literal task/model args and returns only final answer", async () => {
      process.env.ONESHOT_TEST_CASE = "success";
      const outcome = await runSubagent(options());
      assert.equal(outcome.details.status, "success");
      assert.match(outcome.text, /Final 😀 answer/);
      assert.equal(outcome.usage.input, 7);
      assert.equal(outcome.details.toolCalls, 1);
      assert.ok(updates.length > 0);
      const captured = JSON.parse(await readFile(join(root, "args.json"), "utf8"));
      assert.equal(captured.child, "1");
      assert.deepEqual(captured.args, ["--mode", "json", "--no-session", "--model", "model-id", "--provider", "provider", "--thinking", "high", "--", CHILD_NOTICE + options().task]);
      assert.equal(outcome.details.task, options().task);
      assert.deepEqual(await readdir(dirname(outcome.details.jobDir!)), [outcome.details.jobDir!.split("/").at(-1)], "one job directory and no run markers or children");
      assert.equal((await stat(outcome.details.jobDir!)).mode & 0o777, 0o700);
      assert.equal(await readFile(join(outcome.details.jobDir!, "final-response.md"), "utf8"), "Final 😀 answer");
    });
    await t.test("Pi capacity comes from the resolver for the completed child call's provider and model", async () => {
      process.env.ONESHOT_TEST_CASE = "success";
      const seen: string[] = [];
      const outcome = await runSubagent(options({ contextWindowFor: (provider, id) => { seen.push(`${provider}/${id}`); return 200_000; } }));
      assert.equal(outcome.details.contextWindow, 200_000);
      assert.deepEqual(seen, ["fake-provider/fake-model"]);
      assert.equal(outcome.usage.input, 7);
    });
    for (const mode of ["error", "exit"]) await t.test(`${mode} is an error result`, async () => {
      process.env.ONESHOT_TEST_CASE = mode;
      const outcome = await runSubagent(options());
      assert.equal(outcome.details.status, "error");
      assert.match(outcome.text, mode === "error" ? /provider failed/ : /status 7/);
    });
    await t.test("large responses are saved whole and bounded in model context", async () => {
      process.env.ONESHOT_TEST_CASE = "large";
      const outcome = await runSubagent(options());
      assert.equal(outcome.details.status, "success");
      assert.ok(outcome.text.length < 42000);
      assert.match(outcome.text, /Truncated.*Full response:/);
      assert.equal((await readFile(join(outcome.details.jobDir!, "final-response.md"), "utf8")).length, 50000);
    });
    await t.test("cancel during launch still finds and stops the detached process group", async () => {
      process.env.ONESHOT_TEST_CASE = "hang";
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20);
      try {
        const outcome = await runSubagent(options({ signal: controller.signal }));
        assert.equal(outcome.details.status, "aborted");
        assert.ok(outcome.details.jobDir);
        assert.match(outcome.text, /cancelled/);
        const pid = Number(await readFile(join(outcome.details.jobDir!, "pid"), "utf8"));
        await assertGroupStopped(pid);
      } finally { clearTimeout(timer); }
    });
    await t.test("timeout stops a stuck child", async () => {
      process.env.ONESHOT_TEST_CASE = "hang";
      const outcome = await runSubagent(options({ timeoutSeconds: 1 }));
      assert.equal(outcome.details.status, "error");
      assert.match(outcome.text, /Timed out/);
      const pid = Number(await readFile(join(outcome.details.jobDir!, "pid"), "utf8"));
      await assertGroupStopped(pid);
    });
    await t.test("Pi details expose the latest completed call while keeping cumulative accounting", async () => {
      process.env.ONESHOT_TEST_CASE = "success";
      const outcome = await runSubagent(options());
      assert.deepEqual(outcome.details.latestCallUsage, { input: 7, output: 3, cacheRead: 0, cacheWrite: 0 });
      assert.equal(outcome.details.totalTokens, 10);
      assert.equal(outcome.usage.totalTokens, 10);
    });
    await t.test("Claude backend normalizes model/effort and ignores provider", async () => {
      process.env.ONESHOT_TEST_CASE = "success";
      const previews: string[] = [];
      const outcome = await runSubagent(options({ agent: "claude", model: "sonnet:low", effort: "high", thinking: undefined,
        onProgress: (details) => previews.push(details.preview) }));
      assert.equal(outcome.details.status, "success");
      assert.match(outcome.text, /Claude final 😀 answer/);
      assert.equal(outcome.details.agent, "claude");
      assert.equal(outcome.details.model, "sonnet");
      assert.equal(outcome.details.toolCalls, 1);
      assert.equal(outcome.details.turns, 2);
      assert.equal(outcome.usage.totalTokens, 10);
      assert.equal(outcome.usage.cost.total, 0.02);
      assert.ok(previews.some((preview) => preview.startsWith("Live")));
      const captured = JSON.parse(await readFile(join(root, "args.json"), "utf8"));
      assert.equal(captured.child, "1");
      assert.ok(captured.args.includes("--effort"));
      assert.ok(captured.args.includes("high"));
      assert.ok(!captured.args.includes("--provider"));
      assert.ok(!captured.args.includes("--thinking"));
      assert.equal(captured.args.at(-1), CHILD_NOTICE + options().task);
    });
    for (const mode of ["error", "exit", "missing-result"]) await t.test(`Claude ${mode} returns an error`, async () => {
      process.env.ONESHOT_TEST_CASE = mode;
      const outcome = await runSubagent(options({ agent: "claude" }));
      assert.equal(outcome.details.status, "error");
      assert.match(outcome.text, mode === "error" ? /Claude provider failed/ : mode === "exit" ? /status 7/ : /without a result/);
    });
    await t.test("Claude timeout and cancellation stop detached process groups", async () => {
      process.env.ONESHOT_TEST_CASE = "hang";
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 100);
      try {
        const outcome = await runSubagent(options({ agent: "claude", signal: controller.signal }));
        assert.equal(outcome.details.status, "aborted");
        await assertGroupStopped(Number(await readFile(join(outcome.details.jobDir!, "pid"), "utf8")));
      } finally { clearTimeout(timer); }
      const outcome = await runSubagent(options({ agent: "claude", timeoutSeconds: 1 }));
      assert.equal(outcome.details.status, "error");
      assert.match(outcome.text, /Timed out/);
      await assertGroupStopped(Number(await readFile(join(outcome.details.jobDir!, "pid"), "utf8")));
    });
    await t.test("pre-aborted requests never launch", async () => {
      const controller = new AbortController(); controller.abort();
      const outcome = await runSubagent(options({ signal: controller.signal }));
      assert.equal(outcome.details.status, "aborted");
      assert.equal(outcome.details.jobDir, undefined);
    });
    await t.test("missing launcher returns a useful failure", async () => {
      const outcome = await runSubagent(options({ launcher: join(root, "missing.sh") }));
      assert.equal(outcome.details.status, "error");
      assert.match(outcome.text, /Launcher failed/);
    });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await stopFakeAgents(root);
    await rm(root, { recursive: true, force: true });
  }
});
