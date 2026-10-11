import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { initTheme, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { AgentJobs, type JobSnapshot } from "../shared/agent-jobs/jobs.ts";
import { isTerminal, type JobState } from "../shared/agent-jobs/store.ts";
import { discover } from "./discovery.ts";
import { picker } from "./index.ts";
import { buildRows } from "./rows.ts";
import type { Agent, Runner } from "./tmux.ts";

type Factory = Parameters<ExtensionCommandContext["ui"]["custom"]>[0];
type Component = Awaited<ReturnType<Factory>>;
initTheme("dark", false);
const SESSION = "session-a";
const STARTED = "Fri Oct 9 09:39:49 2026";
const base = mkdtempSync(join(tmpdir(), "agents-jobs-ui-"));
let counter = 0;

function makeJob(name: string, state: JobState, extra: { owner?: string; activity?: string[]; child?: number; result?: string } = {}): JobSnapshot {
  const id = `job-${(++counter).toString(16).padStart(12, "0")}`;
  const dir = join(base, id);
  mkdirSync(dir);
  writeFileSync(join(dir, "task.md"), `Task body for ${name}`);
  const resultPath = join(dir, "final-response.md");
  if (extra.result !== undefined) writeFileSync(resultPath, extra.result);
  return {
    id, dir, markers: new Set(), liveness: isTerminal(state) ? "ended" : "live",
    request: {
      version: 1, id, name, agent: "pi", model: "m1", cwd: "/work", createdAt: 1_000 + counter, timeoutSeconds: 60, deadline: 99_000,
      owner: { sessionId: extra.owner ?? SESSION }, launcher: "x",
    },
    status: {
      version: 1, id, seq: 1, state, updatedAt: 1, acceptedAt: Date.now() - 5_000, lastActivityAt: Date.now() - 30_000,
      child: extra.child ? { pid: extra.child, startedAt: STARTED } : undefined,
      details: { activity: extra.activity ?? ["read file.ts"], preview: "partial text", turns: 2, toolCalls: 3, durationMs: 4_000 },
      resultPath: extra.result !== undefined ? resultPath : undefined,
      terminalReason: isTerminal(state) ? "done" : undefined,
    },
  };
}

class StubJobs {
  calls: string[] = [];
  all: JobSnapshot[];
  constructor(all: JobSnapshot[]) { this.all = all; }
  async list(query: { owner?: string; active?: boolean; limit?: number } = {}) {
    return this.all.filter((job) => (query.owner === undefined || job.request.owner.sessionId === query.owner) &&
      (!query.active || !isTerminal(job.status.state))).slice(0, query.limit);
  }
  async inspect(id: string) { return this.all.find((job) => job.id === id); }
  async cancel(id: string, owner: string) { this.calls.push(`cancel:${id}:${owner}`); return { outcome: "cancelled" as const }; }
  async mark(id: string, marker: string) { this.calls.push(`mark:${id}:${marker}`); return true; }
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const settle = async () => { await tick(); await new Promise<void>((resolve) => setTimeout(resolve, 15)); await tick(); };
// Real filesystem/process reads can take longer than one settle under a loaded test run.
async function eventually(check: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) await settle();
  assert.ok(check());
}

async function mount(options: {
  jobs: StubJobs; discovery?: () => Promise<Agent[]>; socket?: string; terminal?: { columns: number; rows: number };
  run: (component: Component, ctl: { result: () => unknown; completed: () => boolean; text: () => string }) => Promise<void>;
}) {
  const terminal = options.terminal ?? { columns: 120, rows: 40 };
  let result: unknown;
  let completed = false;
  const ctx = {
    sessionManager: { getSessionId: () => SESSION },
    ui: {
      custom: async (factory: Factory) => {
        const component = await factory(
          { terminal, requestRender() {} } as Parameters<Factory>[0],
          { fg: (_c: string, text: string) => text, bold: (text: string) => text } as Parameters<Factory>[1],
          {} as Parameters<Factory>[2],
          (value) => { completed = true; result = value; },
        );
        try {
          await options.run(component, {
            result: () => result, completed: () => completed,
            text: () => component.render(Math.max(1, terminal.columns - 2)).join("\n"),
          });
        } finally { component.dispose?.(); }
        return result;
      },
    },
  } as unknown as ExtensionCommandContext;
  return picker(ctx, options.socket, options.socket ? "%0" : undefined, "/nonexistent/registry", options.discovery ?? (async () => []),
    async () => { throw new Error("unexpected action"); }, options.jobs);
}

test("modal opens before discovery and shows local jobs while discovery is pending", async () => {
  const jobs = new StubJobs([makeJob("alpha", "running")]);
  let release!: (value: Agent[]) => void;
  await mount({
    jobs, discovery: () => new Promise<Agent[]>((resolve) => { release = resolve; }),
    run: async (component, ctl) => {
      assert.ok(ctl.text().includes("Discovering agents"));
      await settle();
      assert.ok(ctl.text().includes("alpha"));
      assert.ok(ctl.text().includes("Discovering agents"));
      assert.ok(ctl.text().includes("This session"));
      release([]);
      await settle();
      assert.ok(!ctl.text().includes("Discovering agents"));
      component.handleInput?.("\x1b");
    },
  });
});

test("Tab cycles This session, All live and Recent jobs", async () => {
  const jobs = new StubJobs([
    makeJob("mine-run", "running"), makeJob("mine-done", "succeeded"),
    makeJob("other-run", "running", { owner: "b" }), makeJob("other-done", "failed", { owner: "b" }),
  ]);
  await mount({
    jobs, run: async (component, ctl) => {
      await settle();
      let text = ctl.text();
      assert.ok(text.includes("‹This session›") && text.includes("mine-run") && text.includes("mine-done") && !text.includes("other-"));
      component.handleInput?.("\t");
      await settle();
      text = ctl.text();
      assert.ok(text.includes("‹All live›") && text.includes("mine-run") && text.includes("other-run") && !text.includes("done"));
      component.handleInput?.("\t");
      await settle();
      text = ctl.text();
      assert.ok(text.includes("‹Recent jobs›") && ["mine-run", "mine-done", "other-run", "other-done"].every((name) => text.includes(name)));
      component.handleInput?.("\t");
      await settle();
      assert.ok(ctl.text().includes("‹This session›"));
      component.handleInput?.("q");
      assert.ok(ctl.completed());
    },
  });
});

test("Enter opens detail, Tab cycles sections, Esc returns with selection preserved", async () => {
  const jobs = new StubJobs([
    makeJob("second", "succeeded", { result: "# Heading\n\nFinal **answer**" }),
    makeJob("first", "running", { activity: ["step one", "step two"] }),
  ]);
  jobs.all.reverse();
  await mount({
    jobs, run: async (component, ctl) => {
      await settle();
      component.handleInput?.("j");
      component.handleInput?.("\r");
      await settle();
      let text = ctl.text();
      assert.ok(text.includes("second") && text.includes("[Activity]") && text.includes("read file.ts"));
      assert.ok(text.includes("succeeded"));
      component.handleInput?.("\t");
      await settle();
      text = ctl.text();
      assert.ok(text.includes("[Result]") && text.includes("Heading") && text.includes("answer"), text);
      component.handleInput?.("\t");
      text = ctl.text();
      assert.ok(text.includes("[Task]") && text.includes("Task body for second") && text.includes("owner session"));
      component.handleInput?.("\x1b");
      assert.equal(ctl.completed(), false);
      text = ctl.text();
      assert.ok(text.includes("→ Job  second"), text);
      assert.deepEqual(jobs.calls, []);
      component.handleInput?.("\x1b");
      assert.ok(ctl.completed());
    },
  });
});

test("running job shows a partial preview and the supervisor-lost state", async () => {
  const job = makeJob("lost", "running");
  job.liveness = "unknown";
  await mount({
    jobs: new StubJobs([job]), run: async (component, ctl) => {
      await settle();
      component.handleInput?.("\r");
      await settle();
      assert.ok(ctl.text().includes("supervisor lost"));
      component.handleInput?.("\t");
      assert.ok(ctl.text().includes("Partial preview") && ctl.text().includes("partial text"));
    },
  });
});

test("cancel needs confirmation, names the job, uses the current session and only applies to owned running jobs", async () => {
  const mine = makeJob("mine", "running");
  const other = makeJob("theirs", "running", { owner: "b" });
  const done = makeJob("finished", "succeeded");
  const jobs = new StubJobs([mine, other, done]);
  await mount({
    jobs, run: async (component, ctl) => {
      await settle();
      component.handleInput?.("\t");
      await settle();
      component.handleInput?.("j");
      assert.ok(ctl.text().includes("→ Job  theirs"));
      component.handleInput?.("c");
      assert.ok(ctl.text().includes("Only the session that started"));
      assert.ok(!ctl.text().includes("[y/n]"));
      component.handleInput?.("k");
      component.handleInput?.("c");
      assert.ok(ctl.text().includes(`Cancel background job mine (${mine.id})? [y/n]`));
      component.handleInput?.("n");
      assert.deepEqual(jobs.calls, []);
      component.handleInput?.("c");
      component.handleInput?.("y");
      await settle();
      assert.deepEqual(jobs.calls, [`cancel:${mine.id}:${SESSION}`]);
      assert.ok(ctl.text().includes("Cancelled mine"));
    },
  });
  const finished = new StubJobs([done]);
  await mount({
    jobs: finished, run: async (component, ctl) => {
      await settle();
      component.handleInput?.("c");
      assert.ok(ctl.text().includes("already finished"));
      assert.deepEqual(finished.calls, []);
    },
  });
});

test("acknowledge only applies to owned terminal jobs and never happens on view", async () => {
  const running = makeJob("running", "running");
  const done = makeJob("done", "succeeded");
  const foreign = makeJob("foreign", "succeeded", { owner: "b" });
  const jobs = new StubJobs([running, done, foreign]);
  await mount({
    jobs, run: async (component, ctl) => {
      await settle();
      component.handleInput?.("a");
      assert.ok(ctl.text().includes("Only finished jobs"));
      component.handleInput?.("j");
      component.handleInput?.("\r");
      await settle();
      component.handleInput?.("\x1b");
      assert.deepEqual(jobs.calls, []);
      component.handleInput?.("a");
      await settle();
      assert.deepEqual(jobs.calls, [`mark:${done.id}:acknowledged`]);
      component.handleInput?.("\t");
      await settle();
      component.handleInput?.("\t");
      await settle();
      const text = ctl.text();
      assert.ok(text.includes("foreign"));
      const lines = text.split("\n");
      const index = lines.findIndex((line) => line.includes("foreign"));
      for (let i = 0; i < index; i++) component.handleInput?.("j");
      component.handleInput?.("a");
      assert.ok(ctl.text().includes("Only the owning session"));
      assert.equal(jobs.calls.length, 1);
    },
  });
});

test("job rows never offer pane actions", async () => {
  const jobs = new StubJobs([makeJob("job", "running")]);
  await mount({
    jobs, socket: "/tmp/socket", run: async (component, ctl) => {
      await settle();
      for (const key of ["\x18", "V", "H"]) {
        component.handleInput?.(key);
        assert.ok(ctl.text().includes("no tmux pane"));
        assert.ok(!ctl.text().includes("[y/n]"));
        assert.equal(ctl.completed(), false);
      }
    },
  });
});

test("a process descending from a verified job leader is shown only as the job", () => {
  const job = makeJob("bg", "running", { child: 900 });
  const agent = (pid: number): Agent => ({
    provider: "pi", interactive: false, process: { pid, ppid: pid === 901 ? 900 : 1, startedAt: STARTED, command: "pi", args: "pi -p" },
  });
  const processes = (leaderStart: string) => new Map([
    [900, { pid: 900, ppid: 1, startedAt: leaderStart, command: "sh", args: "sh" }],
    [901, agent(901).process], [950, agent(950).process],
  ]);
  const rows = buildRows("session", [job], [job], [agent(901), agent(950)], processes(STARTED), SESSION);
  assert.deepEqual(rows.map((row) => row.kind === "job" ? row.job.id : row.agent.process.pid), [job.id, 950]);
  const reused = buildRows("session", [job], [job], [agent(901), agent(950)], processes("Mon Jan 1 00:00:00 2001"), SESSION);
  assert.equal(reused.length, 3);
  const terminal = makeJob("old", "succeeded", { child: 900 });
  assert.equal(buildRows("live", [], [terminal], [agent(901)], processes(STARTED), SESSION).length, 1);
});

test("outside tmux processes are listed, discovery gets no socket and pane actions are refused", async () => {
  const headless: Agent = { provider: "pi", interactive: true, process: { pid: 77, ppid: 1, startedAt: STARTED, command: "pi", args: "pi" } };
  await mount({
    jobs: new StubJobs([]), discovery: async () => [headless],
    run: async (component, ctl) => {
      await settle();
      assert.ok(ctl.text().includes("PID 77"));
      for (const key of ["V", "H", "\x18"]) {
        component.handleInput?.(key);
        assert.ok(ctl.text().includes("require tmux"));
      }
      component.handleInput?.("\r");
      assert.equal(ctl.completed(), false);
      assert.ok(ctl.text().includes("PID:"));
    },
  });
  const calls: string[] = [];
  const runner: Runner = async (command) => { calls.push(command); return command === "ps" ? "" : "[]"; };
  await discover(undefined, runner, "/nonexistent/registry");
  assert.ok(!calls.includes("tmux") && calls.includes("ps"));
});

test("follow mode pins new activity until the user scrolls up", async () => {
  const job = makeJob("busy", "running", { activity: Array.from({ length: 40 }, (_, i) => `line ${i}`) });
  const jobs = new StubJobs([job]);
  await mount({
    jobs, terminal: { columns: 100, rows: 24 }, run: async (component, ctl) => {
      await settle();
      component.handleInput?.("\r");
      await settle();
      assert.ok(ctl.text().includes("line 39") && ctl.text().includes("following"));
      component.handleInput?.("k");
      component.handleInput?.("k");
      assert.ok(ctl.text().includes("line 37") && !ctl.text().includes("following"));
      jobs.all[0] = { ...job, status: { ...job.status, seq: 2, details: { ...job.status.details, activity: [...job.status.details.activity, "line 40", "line 41"] } } };
      component.handleInput?.("r");
      await settle();
      assert.ok(ctl.text().includes("new activity — End to follow"));
      assert.ok(!ctl.text().includes("line 41"));
      component.handleInput?.("\x1b[F");
      assert.ok(ctl.text().includes("line 41") && ctl.text().includes("following"));
      component.handleInput?.("\x1b[H");
      assert.ok(ctl.text().includes("line 0") && !ctl.text().includes("line 41"));
    },
  });
});

test("rendering fits every width and tiny terminal in list and detail views", async () => {
  const jobs = new StubJobs([makeJob("日本語のジョブ 😀", "running", { activity: ["日本語 😀 ".repeat(30)], result: "x" }), makeJob("b", "failed")]);
  const terminal = { columns: 100, rows: 30 };
  await mount({
    jobs, terminal, run: async (component) => {
      await settle();
      const check = () => {
        for (const width of [1, 3, 5, 6, 10, 20, 40, 80, 120]) {
          for (const rows of [3, 6, 12, 30]) {
            terminal.rows = rows;
            assert.ok(component.render(width).every((line) => visibleWidth(line) <= width), `${width}x${rows}`);
          }
        }
        terminal.rows = 30;
      };
      check();
      component.handleInput?.("\r");
      await settle();
      for (const _ of ["activity", "result", "task"]) { check(); component.handleInput?.("\t"); await settle(); }
    },
  });
});

test("real AgentJobs store: terminal job is listed and its result is shown from disk", async () => {
  const root = mkdtempSync(join(tmpdir(), "agents-real-store-"));
  const id = "job-aaaaaaaaaaaa";
  const dir = join(root, "jobs", id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, "task.md"), "do the thing");
  writeFileSync(join(dir, "final-response.md"), "All done 😀");
  writeFileSync(join(dir, "job.json"), JSON.stringify({
    version: 1, id, name: "stored", agent: "claude", cwd: "/w", createdAt: 5, timeoutSeconds: 10, deadline: 15,
    owner: { sessionId: SESSION }, launcher: "x",
  }));
  writeFileSync(join(dir, "status.json"), JSON.stringify({
    version: 1, id, seq: 3, state: "succeeded", updatedAt: 9, finishedAt: 9, resultPath: join(dir, "final-response.md"),
    details: { activity: ["did it"], preview: "", turns: 1, toolCalls: 0, durationMs: 1200 },
  }));
  await mount({
    jobs: new AgentJobs({ root }) as unknown as StubJobs, run: async (component, ctl) => {
      await eventually(() => ctl.text().includes("stored") && ctl.text().includes("succeeded"));
      component.handleInput?.("\r");
      await settle();
      component.handleInput?.("\t");
      await eventually(() => ctl.text().includes("All done"));
    },
  });
});
