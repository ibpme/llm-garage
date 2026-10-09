/**
 * SSH transport: spawns `ssh`, enforces timeouts/abort, tracks
 * live children, and classifies failures.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export class TransportError extends Error {
  readonly name = "TransportError";
}

export class RemoteCommandError extends Error {
  readonly name = "RemoteCommandError";
  readonly code: number | null;
  readonly stderr: string;
  constructor(code: number | null, stderr: string) {
    super(`Remote command failed (${code}): ${stderr}`);
    this.code = code;
    this.stderr = stderr;
  }
}

/** Message kept as `timeout:<seconds>` for compatibility with existing callers. */
export class RemoteTimeoutError extends Error {
  readonly name = "RemoteTimeoutError";
  readonly seconds: number;
  constructor(seconds: number) {
    super(`timeout:${seconds}`);
    this.seconds = seconds;
  }
}

export class RemoteAbortError extends Error {
  readonly name = "RemoteAbortError";
  constructor() {
    super("aborted");
  }
}

export interface RunOptions {
  stdin?: string | Buffer;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** When set, stdout and stderr are streamed here and not buffered. */
  onData?: (chunk: Buffer) => void;
}

export interface RunResult {
  code: number | null;
  stdout: Buffer;
  stderr: Buffer;
}

/**
 * Options applied to every ssh invocation. BatchMode stops ssh from prompting
 * on /dev/tty (password, host-key confirmation), which would otherwise hang
 * the agent. ServerAlive* detects dead links instead of waiting on TCP.
 * ControlMaster reuses one authenticated connection per host.
 */
let baseArgsCache: string[] | undefined;
export function sshBaseArgs(): string[] {
  if (baseArgsCache) return baseArgsCache;
  const controlDir = join(homedir(), ".ssh");
  try {
    mkdirSync(controlDir, { recursive: true, mode: 0o700 });
  } catch {
    // ssh falls back to a direct connection if the control socket cannot be created.
  }
  baseArgsCache = [
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=3",
    "-o", "ControlMaster=auto",
    "-o", "ControlPersist=10m",
    "-o", `ControlPath=${join(controlDir, "cm-%C")}`,
  ];
  return baseArgsCache;
}

const KILL_GRACE_MS = 2000;

/** Single-quote a string for POSIX sh. */
export function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Spawns one ssh invocation and resolves with its raw outcome. Never classifies. */
export function spawnRemote(
  remote: string,
  command: string,
  opts: RunOptions,
  children: Set<ChildProcess>,
): Promise<RunResult & { timedOut: boolean; aborted: boolean }> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      resolve({ code: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), timedOut: false, aborted: true });
      return;
    }
    const child = spawn("ssh", [...sshBaseArgs(), remote, command], {
      stdio: [opts.stdin !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
    });
    children.add(child);

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    let aborted = false;
    let timer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;

    const kill = () => {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
      killTimer.unref();
    };

    if (opts.timeoutMs) {
      timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, opts.timeoutMs);
    }
    const onAbort = () => {
      aborted = true;
      kill();
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (data: Buffer) => {
      if (opts.onData) opts.onData(data);
      else stdout.push(data);
    });
    child.stderr?.on("data", (data: Buffer) => {
      if (opts.onData) opts.onData(data);
      else stderr.push(data);
    });

    if (opts.stdin !== undefined) {
      child.stdin?.on("error", () => {
        // EPIPE if ssh exits early; the close handler reports the real outcome.
      });
      child.stdin?.end(opts.stdin);
    }

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      opts.signal?.removeEventListener("abort", onAbort);
      children.delete(child);
    };

    child.on("error", (err) => {
      cleanup();
      reject(new TransportError(`Failed to start ssh: ${err.message}`));
    });
    child.on("close", (code) => {
      cleanup();
      resolve({
        code,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        timedOut,
        aborted,
      });
    });
  });
}

/** Asks a ControlMaster to exit. A no-op (non-zero exit) when none is running. */
function stopControlMaster(remote: string): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn("ssh", ["-O", "exit", ...sshBaseArgs(), remote], { stdio: "ignore" });
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    child.on("error", () => {
      clearTimeout(timer);
      resolve();
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * Long-lived handle to one remote host and working directory. Owns the set of
 * live ssh children so close() can tear down everything in flight.
 */
export class SshConnection {
  readonly remote: string;
  readonly remoteCwd: string;
  private readonly children = new Set<ChildProcess>();
  private closed = false;

  constructor(remote: string, remoteCwd: string) {
    this.remote = remote;
    this.remoteCwd = remoteCwd;
  }

  /**
   * Runs a command. Resolves for any exit code, including non-zero.
   * Throws RemoteTimeoutError, RemoteAbortError, or TransportError (ssh exit 255,
   * spawn failure, or connection already closed).
   */
  async run(command: string, opts: RunOptions = {}): Promise<RunResult> {
    if (this.closed) throw new TransportError("SSH connection is closed.");
    const result = await spawnRemote(this.remote, command, opts, this.children);
    if (this.closed) throw new TransportError("SSH connection was closed.");
    if (result.aborted) throw new RemoteAbortError();
    if (result.timedOut) throw new RemoteTimeoutError((opts.timeoutMs ?? 0) / 1000);
    if (result.code === 255) {
      throw new TransportError(`SSH transport failed: ${result.stderr.toString().trim()}`);
    }
    return result;
  }

  /** Like run(), but throws RemoteCommandError on a non-zero exit and returns stdout. */
  async exec(command: string, opts: RunOptions = {}): Promise<Buffer> {
    const result = await this.run(command, opts);
    if (result.code !== 0) {
      throw new RemoteCommandError(result.code, result.stderr.toString());
    }
    return result.stdout;
  }

  /** Kills in-flight children and drops the ControlMaster socket. Idempotent. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const child of this.children) child.kill("SIGTERM");
    this.children.clear();
    await stopControlMaster(this.remote);
  }
}

export interface ParsedSshTarget {
  remote: string;
  /** Explicit remote path after the first ':', if given. */
  remoteCwd?: string;
}

/** Parses `host` or `user@host:/path`. Splits on the first ':' only. */
export function parseSshTarget(arg: string): ParsedSshTarget {
  const idx = arg.indexOf(":");
  if (idx === -1) return { remote: arg };
  return { remote: arg.slice(0, idx), remoteCwd: arg.slice(idx + 1) };
}

/** Minimal glob→RegExp: `**` matches across path segments, `*` within one, `?` any single char. */
export function globToRegExp(pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*" && pattern[i + 1] === "*") {
      re += ".*";
      i++;
      if (pattern[i + 1] === "/") i++;
    } else if (c === "*") {
      re += "[^/]*";
    } else if (c === "?") {
      re += "[^/]";
    } else if (".+^$()[]{}|\\".includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}
