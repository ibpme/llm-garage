import { execFile } from "node:child_process";
import { mkdir, mkdtemp, open, readFile, readdir, realpath, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { setTimeout as sleep } from "node:timers/promises";
import type { Usage } from "@earendil-works/pi-ai";
import { EventState, type RunDetails } from "./events.ts";
import { childPolicy, DEPTH_ENV, type DepthPolicy } from "./depth.ts";
import { settleNested } from "./nested.ts";
import { ClaudeEventState } from "./claude-events.ts";
import { resolveBackend, type Agent, type Effort } from "./backend.ts";

export interface RunOptions {
  launcher: string;
  agent?: Agent;
  policy: DepthPolicy;
  name: string;
  task: string;
  cwd: string;
  model?: string;
  provider?: string;
  thinking?: string;
  effort?: Effort;
  timeoutSeconds: number;
  signal: AbortSignal;
  onProgress: (details: RunDetails) => void;
  outputRoot?: string;
}

function launch(script: string, args: string[], policy: DepthPolicy): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("bash", [script, ...args], {
      env: { ...process.env, [DEPTH_ENV]: JSON.stringify(policy), PI_ONESHOT_SUBAGENT_CHILD: "1" },
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
    }, (error, _stdout, stderr) => error ? reject(new Error(`Launcher failed: ${stderr.trim() || error.message}`)) : resolve());
  });
}

async function optionalRead(path: string): Promise<string | undefined> {
  try { return await readFile(path, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

async function readTail(path: string, limit = 4000): Promise<string | undefined> {
  let file;
  try { file = await open(path, "r"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  try {
    const { size } = await file.stat();
    const buffer = Buffer.alloc(Math.min(size, limit));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, Math.max(0, size - limit));
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally { await file.close(); }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function stopJob(jobDir: string): Promise<void> {
  const raw = await optionalRead(join(jobDir, "pid"));
  const pid = Number(raw?.trim());
  if (!Number.isInteger(pid) || pid <= 1) return;
  // The launcher creates a detached process group; kill tools as well as Pi.
  const kill = (signal: NodeJS.Signals) => {
    try { process.kill(-pid, signal); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  };
  kill("SIGTERM");
  await sleep(500);
  kill("SIGKILL");
}

async function stopRun(runDir: string): Promise<void> {
  if (await optionalRead(join(runDir, "finished")) !== undefined) return;
  await writeFile(join(runDir, "cancelled"), "cancelled\n", { mode: 0o600 });
  const stopChildren = async () => {
    let children: string[];
    try { children = await readdir(join(runDir, "children")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    await Promise.all(children.filter((name) => name.startsWith("oneshot-")).map((name) => stopRun(join(runDir, "children", name))));
  };
  await stopChildren();
  // Detached descendants have their own process groups. Wait for an in-flight
  // launcher to publish its PID before declaring the owned subtree stopped.
  const deadline = Date.now() + 15_000;
  while (await optionalRead(join(runDir, "launching")) !== undefined) {
    const entries = await readdir(runDir, { withFileTypes: true });
    const pids = await Promise.all(entries.filter((entry) => entry.isDirectory() && entry.name !== "children")
      .map((entry) => optionalRead(join(runDir, entry.name, "pid"))));
    if (pids.some((pid) => pid !== undefined)) break;
    if (Date.now() >= deadline) throw new Error(`Cannot clean up an in-flight subagent launch: ${runDir}`);
    await sleep(100);
  }
  for (const entry of await readdir(runDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === "children") continue;
    const job = join(runDir, entry.name);
    if (await optionalRead(join(job, "exit.status")) === undefined) await stopJob(job);
  }
  // A descendant may have created its job while the parent was terminating.
  await stopChildren();
  await writeFile(join(runDir, "finished"), "cancelled\n", { mode: 0o600 });
}

export async function runSubagent(options: RunOptions): Promise<{ details: RunDetails; text: string; usage: Usage }> {
  const started = Date.now();
  const details: RunDetails = { name: options.name, task: options.task, cwd: options.cwd,
    agent: options.agent ?? "pi", model: options.model, status: "running", activity: [], preview: "", turns: 0, toolCalls: 0, durationMs: 0 };
  const state = options.agent === "claude" ? new ClaudeEventState(details) : new EventState(details);
  let runDir: string | undefined;
  let jobDir: string | undefined;
  let completed = false;
  let result = "";
  const report = () => {
    details.durationMs = Date.now() - started;
    details.totalTokens = state.usage.totalTokens;
    details.costUsd = details.usagePartial ? undefined : state.usage.cost.total;
    options.onProgress({ ...details, activity: [...details.activity] });
  };

  try {
    options.signal.throwIfAborted();
    const backend = resolveBackend(options);
    details.model = backend.model;
    if (options.policy.depth >= options.policy.maxDepth) throw new Error(`Subagent depth limit reached (${options.policy.depth}/${options.policy.maxDepth})`);
    details.cwd = await realpath(resolve(options.cwd));
    const root = options.policy.runDir ? join(options.policy.runDir, "children") :
      options.outputRoot ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "agent-spawn");
    if (options.policy.runDir && await optionalRead(join(options.policy.runDir, "cancelled")) !== undefined)
      throw new Error("Parent subagent has been cancelled");
    await mkdir(root, { recursive: true });
    runDir = await mkdtemp(join(root, "oneshot-"));
    const context = childPolicy(options.policy, runDir);
    if (backend.agent === "claude") context.maxDepth = context.depth;
    details.depth = context.depth;
    details.maxDepth = context.maxDepth;
    await writeFile(join(runDir, "delegation.json"), JSON.stringify(context, null, 2) + "\n", { mode: 0o600 });
    const promptFile = join(runDir, "task.md");
    await writeFile(promptFile, options.task, { mode: 0o600 });
    const args = ["--agent", backend.agent, "--name", options.name, "--mode", "json", "--cwd", details.cwd,
      "--prompt-file", promptFile, "--output-dir", runDir];
    if (backend.model) args.push("--model", backend.model);
    if (backend.provider) args.push("--provider", backend.provider);
    if (backend.thinking) args.push("--thinking", backend.thinking);
    if (backend.effort) args.push("--effort", backend.effort);
    report();
    // Wait for launch acknowledgement even on cancellation: the child is detached
    // and we need its PID before cleanup can reliably terminate it.
    if (options.policy.runDir && await optionalRead(join(options.policy.runDir, "cancelled")) !== undefined)
      throw new Error("Parent subagent has been cancelled");
    await writeFile(join(runDir, "launching"), "launching\n", { mode: 0o600 });
    try { await launch(options.launcher, args, context); }
    finally { await unlink(join(runDir, "launching")); }
    jobDir = join(runDir, (await readdir(runDir)).find((name) => name.startsWith(`${options.name}.`)) ?? "");
    if (jobDir === runDir) throw new Error("Launcher did not create a job directory");
    details.jobDir = jobDir;
    await unlink(promptFile);
    options.signal.throwIfAborted();
    const pid = Number((await readFile(join(jobDir, "pid"), "utf8")).trim());
    if (!Number.isInteger(pid) || pid <= 1) throw new Error("Launcher returned an invalid PID");
    const stream = await open(join(jobDir, "events.jsonl"), "r");
    const decoder = new StringDecoder("utf8");
    const buffer = Buffer.alloc(64 * 1024);
    let position = 0;
    let deadSince: number | undefined;
    try {
      const drain = async () => {
        while (true) {
          options.signal.throwIfAborted();
          if (Date.now() - started > options.timeoutSeconds * 1000) throw new Error(`Timed out after ${options.timeoutSeconds}s`);
          const { bytesRead } = await stream.read(buffer, 0, buffer.length, position);
          if (!bytesRead) break;
          position += bytesRead;
          state.feed(decoder.write(buffer.subarray(0, bytesRead)));
        }
      };
      while (true) {
        await drain();
        const status = await optionalRead(join(jobDir, "exit.status"));
        if (status !== undefined) {
          await drain();
          state.feed(decoder.end(), true);
          if (!/^\d+\s*$/.test(status)) throw new Error("Invalid exit.status");
          details.exitCode = Number(status.trim());
          completed = true;
          const failure = state.failure(details.exitCode);
          if (failure) throw new Error(failure);
          details.status = "success";
          result = state.finalText;
          break;
        }
        if (!alive(pid)) {
          deadSince ??= Date.now();
          if (Date.now() - deadSince > 1000) throw new Error("Child process disappeared without exit.status");
        } else deadSince = undefined;
        report();
        await sleep(200, undefined, { signal: options.signal });
      }
    } finally { await stream.close(); }
  } catch (error) {
    details.status = options.signal.aborted ? "aborted" : "error";
    result = options.signal.aborted ? "One-shot subagent was cancelled." : `One-shot subagent failed: ${error instanceof Error ? error.message : String(error)}`;
    if (jobDir) {
      const stderr = await readTail(join(jobDir, "stderr.log"));
      if (stderr?.trim()) result += `\n\n${stderr.slice(-4000)}`;
    }
  } finally {
    // Also discover partial launches when the launcher failed before acknowledging.
    if (!jobDir && runDir) {
      const entry = (await readdir(runDir)).find((name) => name.startsWith(`${options.name}.`));
      if (entry) jobDir = join(runDir, entry);
    }
    details.jobDir = jobDir;
    if (!completed && runDir) await stopRun(runDir);
    if (runDir) await writeFile(join(runDir, "finished"), details.status + "\n", { mode: 0o600 });
    details.durationMs = Date.now() - started;
    details.totalTokens = state.usage.totalTokens;
    details.costUsd = details.usagePartial ? undefined : state.usage.cost.total;
  }

  if (jobDir) {
    const finalPath = join(jobDir, "final-response.md");
    await writeFile(finalPath, result, { mode: 0o600 });
    if (Buffer.byteLength(result, "utf8") > 40 * 1024) {
      result = Buffer.from(result).subarray(0, 40 * 1024).toString("utf8") + `\n\n[Truncated. Full response: ${finalPath}]`;
    }
  }
  details.result = result;
  settleNested(details);
  const text = result + (jobDir ? `\n\n[Subagent job: ${jobDir}]` : "");
  return { details, text, usage: state.usage };
}
