import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  globToRegExp,
  parseSshTarget,
  RemoteAbortError,
  RemoteCommandError,
  RemoteTimeoutError,
  shq,
  sshBaseArgs,
  SshConnection,
  TransportError,
} from "../shared/ssh-transport.ts";

// Fake `ssh` on PATH: logs its argv, honours -o/-O, and runs the remote
// command locally through sh. FAKE_SSH_FAIL=1 simulates ssh exit 255.
const FAKE_SSH = `#!/bin/sh
[ -n "$FAKE_SSH_LOG" ] && printf '%s\\n' "$*" >> "$FAKE_SSH_LOG"
if [ "$1" = "-O" ]; then exit 0; fi
if [ -n "$FAKE_SSH_FAIL" ]; then echo "ssh: connect to host refused" >&2; exit 255; fi
while [ $# -gt 0 ]; do
  case "$1" in
    -o) shift 2 ;;
    -*) shift ;;
    *) break ;;
  esac
done
shift
[ $# -eq 0 ] && exit 0
exec sh -c "$*"
`;

let binDir: string;
let logFile: string;
const originalPath = process.env.PATH;

before(() => {
  binDir = mkdtempSync(join(tmpdir(), "fake-ssh-"));
  logFile = join(binDir, "argv.log");
  writeFileSync(join(binDir, "ssh"), FAKE_SSH);
  chmodSync(join(binDir, "ssh"), 0o755);
  process.env.PATH = `${binDir}:${originalPath}`;
  process.env.FAKE_SSH_LOG = logFile;
});

after(() => {
  process.env.PATH = originalPath;
  delete process.env.FAKE_SSH_LOG;
  delete process.env.FAKE_SSH_FAIL;
  rmSync(binDir, { recursive: true, force: true });
});

describe("shq", () => {
  it("round-trips hostile strings through sh unchanged", () => {
    const samples = [
      "plain",
      "it's a 'quoted' name",
      "$HOME `whoami` $(echo injected)",
      'double "quotes" and \\backslash',
      "spaces and\nnewlines",
    ];
    for (const sample of samples) {
      const out = execFileSync("sh", ["-c", `printf %s ${shq(sample)}`]).toString();
      assert.equal(out, sample);
    }
  });
});

describe("parseSshTarget", () => {
  it("parses a bare host", () => {
    assert.deepEqual(parseSshTarget("user@host"), { remote: "user@host" });
  });

  it("splits on the first colon only", () => {
    assert.deepEqual(parseSshTarget("user@host:/srv/a:b"), { remote: "user@host", remoteCwd: "/srv/a:b" });
  });
});

describe("globToRegExp", () => {
  it("treats ** as cross-segment and * as single-segment", () => {
    assert.ok(globToRegExp("**/*.ts").test("a/b/c.ts"));
    assert.ok(globToRegExp("*.ts").test("c.ts"));
    assert.ok(!globToRegExp("*.ts").test("a/c.ts"));
  });

  it("matches ? as one non-slash character", () => {
    assert.ok(globToRegExp("a?c").test("abc"));
    assert.ok(!globToRegExp("a?c").test("ac"));
    assert.ok(!globToRegExp("a?c").test("a/c"));
  });

  it("escapes regex metacharacters", () => {
    assert.ok(globToRegExp("a.b").test("a.b"));
    assert.ok(!globToRegExp("a.b").test("axb"));
  });
});

describe("sshBaseArgs", () => {
  it("disables prompts and enables keepalive and multiplexing", () => {
    const args = sshBaseArgs().join(" ");
    for (const opt of [
      "BatchMode=yes",
      "ConnectTimeout=10",
      "ServerAliveInterval=15",
      "ServerAliveCountMax=3",
      "ControlMaster=auto",
      "ControlPersist=10m",
    ]) {
      assert.ok(args.includes(opt), `missing ${opt}`);
    }
    assert.match(args, /ControlPath=\S*\.ssh\/cm-%C/);
  });
});

describe("SshConnection", () => {
  it("exec returns stdout", async () => {
    const conn = new SshConnection("host", "/");
    const out = await conn.exec("printf hello");
    assert.equal(out.toString(), "hello");
  });

  it("run resolves with a non-zero exit code without throwing", async () => {
    const conn = new SshConnection("host", "/");
    const result = await conn.run("exit 3");
    assert.equal(result.code, 3);
  });

  it("exec throws RemoteCommandError with code and stderr on non-zero exit", async () => {
    const conn = new SshConnection("host", "/");
    await assert.rejects(conn.exec("echo oops >&2; exit 4"), (err: unknown) => {
      assert.ok(err instanceof RemoteCommandError);
      assert.equal(err.code, 4);
      assert.match(err.stderr, /oops/);
      return true;
    });
  });

  it("pipes stdin to the remote command", async () => {
    const conn = new SshConnection("host", "/");
    const out = await conn.exec("cat", { stdin: "piped-in" });
    assert.equal(out.toString(), "piped-in");
  });

  it("streams output through onData without buffering", async () => {
    const conn = new SshConnection("host", "/");
    const seen: string[] = [];
    const result = await conn.run("printf out; printf err >&2", { onData: (c) => seen.push(c.toString()) });
    assert.equal(result.code, 0);
    assert.equal(result.stdout.length, 0);
    assert.deepEqual(seen.sort(), ["err", "out"]);
  });

  it("maps ssh exit 255 to TransportError", async () => {
    process.env.FAKE_SSH_FAIL = "1";
    try {
      const conn = new SshConnection("host", "/");
      await assert.rejects(conn.exec("true"), (err: unknown) => {
        assert.ok(err instanceof TransportError);
        assert.match(err.message, /refused/);
        return true;
      });
    } finally {
      delete process.env.FAKE_SSH_FAIL;
    }
  });

  it("maps a missing ssh binary to TransportError", async () => {
    const saved = process.env.PATH;
    process.env.PATH = "";
    try {
      const conn = new SshConnection("host", "/");
      await assert.rejects(conn.exec("true"), TransportError);
    } finally {
      process.env.PATH = saved;
    }
  });

  it("kills the child and rejects with RemoteTimeoutError on timeout", async () => {
    const conn = new SshConnection("host", "/");
    const started = Date.now();
    await assert.rejects(conn.run("sleep 5", { timeoutMs: 200 }), (err: unknown) => {
      assert.ok(err instanceof RemoteTimeoutError);
      assert.equal(err.message, "timeout:0.2");
      return true;
    });
    assert.ok(Date.now() - started < 3000, "timeout did not kill the child promptly");
  });

  it("rejects with RemoteAbortError when the signal fires mid-run", async () => {
    const conn = new SshConnection("host", "/");
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    await assert.rejects(conn.run("sleep 5", { signal: controller.signal }), RemoteAbortError);
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const conn = new SshConnection("host", "/");
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(conn.run("sleep 5", { signal: controller.signal }), RemoteAbortError);
  });

  it("close() fails in-flight runs and rejects later ones", async () => {
    const conn = new SshConnection("host", "/");
    const inFlight = conn.run("sleep 5");
    setTimeout(() => void conn.close(), 100);
    await assert.rejects(inFlight, TransportError);
    await assert.rejects(conn.run("true"), TransportError);
  });

  it("close() is idempotent and asks the ControlMaster to exit", async () => {
    const conn = new SshConnection("example-host", "/");
    await conn.close();
    await conn.close();
    const log = readFileSync(logFile, "utf8");
    assert.match(log, /-O exit .*example-host/);
  });

  it("passes the hardening options on every invocation", async () => {
    const conn = new SshConnection("logged-host", "/");
    await conn.exec("true");
    const line = readFileSync(logFile, "utf8").split("\n").filter((l) => l.includes("logged-host")).pop() ?? "";
    assert.match(line, /BatchMode=yes/);
    assert.match(line, /ControlPersist=10m/);
  });
});
