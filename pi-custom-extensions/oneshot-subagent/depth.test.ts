import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { childPolicy, DEFAULT_MAX_DEPTH, DEPTH_ENV, initialPolicy, loadMaxDepth, parsePolicy, restorePolicy } from "./depth.ts";

const root = { version: 1 as const, depth: 0, maxDepth: 2 };

test("default budget is main -> child -> terminal grandchild", () => {
  assert.equal(DEFAULT_MAX_DEPTH, 2);
  const child = childPolicy(root, "/tmp/child");
  assert.equal(child.depth, 1);
  const leaf = childPolicy(child, "/tmp/grandchild");
  assert.equal(leaf.depth, 2);
  assert.equal(leaf.maxDepth, 2);
  assert.throws(() => childPolicy(leaf, "/tmp/too-deep"), /depth limit reached/);
  assert.deepEqual(initialPolicy({ [DEPTH_ENV]: JSON.stringify(child) }), child);
});

test("invalid inherited metadata never silently becomes a root", () => {
  for (const raw of ["", "null", "{}", "not-json", JSON.stringify({ ...root, depth: -1 }), JSON.stringify({ ...root, depth: 1.5 })])
    assert.throws(() => initialPolicy({ [DEPTH_ENV]: raw }));
  assert.deepEqual(initialPolicy({ PI_ONESHOT_SUBAGENT_CHILD: "1" }), { version: 1, depth: 1, maxDepth: 1 });
  assert.throws(() => parsePolicy({ ...root, runDir: "relative" }));
});

test("restoring session identity cannot reduce depth or expand the inherited budget", () => {
  assert.equal(restorePolicy(root, [{ ...root, depth: 1 }]).depth, 1);
  assert.equal(restorePolicy({ ...root, depth: 2 }, [root]).depth, 2);
  assert.equal(restorePolicy({ ...root, maxDepth: 1 }, [root]).maxDepth, 1);
  assert.equal(restorePolicy(root, [{ ...root, maxDepth: 0 }]).maxDepth, 0);
  assert.equal(restorePolicy(root, [{ ...root, depth: 1, runDir: "/tmp/old-job" }]).runDir, undefined);
});

test("durable local configuration defaults to 2, allows 0, and rejects invalid values", () => {
  const dir = mkdtempSync(join(tmpdir(), "oneshot-depth-"));
  const path = join(dir, "config.json");
  try {
    assert.equal(loadMaxDepth(path), 2);
    for (const maxDepth of [0, 1, 2, 3, 16]) {
      writeFileSync(path, JSON.stringify({ maxDepth }));
      assert.equal(loadMaxDepth(path), maxDepth);
    }
    for (const maxDepth of [-1, 1.5, 17, "2", null]) {
      writeFileSync(path, JSON.stringify({ maxDepth }));
      assert.throws(() => loadMaxDepth(path));
    }
    writeFileSync(path, "broken");
    assert.throws(() => loadMaxDepth(path));
    const canonical = JSON.parse(readFileSync(new URL("../../pi-custom-config/oneshot-subagent.json", import.meta.url), "utf8"));
    assert.equal(canonical.maxDepth, DEFAULT_MAX_DEPTH);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
