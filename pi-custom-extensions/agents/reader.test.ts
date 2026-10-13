import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readRegistry } from "./reader.ts";

const now = 1_800_000_000_000;
const agent = { schemaVersion: 1, harness: "pi", observedAt: now, process: { pid: 123, startedAt: now - 10000 }, session: { mode: "interactive", name: "review" }, activity: { state: "busy", source: "pi-registry" } };
const health = { version: 1, pid: 456, state: "running", startedAt: now - 10000, updatedAt: now, lastSuccessfulProcessDiscoveryAt: now, agentCount: 1, errors: [] };

async function fixture(t: import("node:test").TestContext, rows: unknown[] = [agent], status: unknown = health) {
  const directory = await mkdtemp(join(tmpdir(), "agents-reader-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "agents.jsonl"), rows.map(row => JSON.stringify(row)).join("\n"));
  await writeFile(join(directory, "registry-health.json"), JSON.stringify(status));
  return directory;
}

test("reads fresh snapshots and reopens atomically replaced data", async t => {
  const dir = await fixture(t);
  const view = await readRegistry(dir, now);
  assert.equal(view.state, "fresh");
  assert.equal(view.agents[0].session.name, "review");
  await writeFile(join(dir, "agents.jsonl"), "");
  assert.deepEqual((await readRegistry(dir, now)).agents, []);
});

test("missing registry is unavailable rather than an authoritative empty list", async t => {
  const dir = await fixture(t);
  await rm(join(dir, "registry-health.json"));
  const view = await readRegistry(dir, now);
  assert.equal(view.state, "unavailable");
  assert.deepEqual(view.agents, []);
  assert.ok(view.warnings.length);
});

for (const [name, status] of [
  ["stopped writer", { ...health, state: "stopped" }],
  ["old writer", { ...health, updatedAt: now - 31000 }],
  ["old process verification", { ...health, lastSuccessfulProcessDiscoveryAt: now - 31000 }],
  ["no successful process scan", { ...health, lastSuccessfulProcessDiscoveryAt: undefined }],
  ["future writer timestamp", { ...health, updatedAt: now + 6000 }],
] as const) test(`${name} marks readable observations stale`, async t => {
  const view = await readRegistry(await fixture(t, [agent], status), now);
  assert.equal(view.state, "stale");
  assert.equal(view.agents.length, 1);
});

test("discovery errors and malformed lines degrade without discarding valid rows", async t => {
  const dir = await fixture(t, [agent, { ...agent, harness: "other" }, { ...agent, pane: { id: "bad" } }], { ...health, errors: ["Claude unavailable"] });
  await writeFile(join(dir, "agents.jsonl"), `${JSON.stringify(agent)}\n{broken\n${JSON.stringify({ ...agent, schemaVersion: 2 })}\n`);
  const view = await readRegistry(dir, now);
  assert.equal(view.state, "degraded");
  assert.equal(view.agents.length, 1);
  assert.ok(view.warnings.some(w => w.includes("Claude unavailable")));
  assert.ok(view.warnings.some(w => w.includes("line")));
});

test("invalid health cannot make rows actionable", async t => {
  const view = await readRegistry(await fixture(t, [agent], { ...health, version: 2 }), now);
  assert.equal(view.state, "unavailable");
});

test("schema-invalid and future observations are skipped", async t => {
  const dir = await fixture(t, [agent, { ...agent, process: { pid: 0, startedAt: now } }, { ...agent, observedAt: now + 6000 }, { ...agent, activity: { state: "made-up", source: "pi-registry" } }]);
  const view = await readRegistry(dir, now);
  assert.equal(view.agents.length, 1);
  assert.equal(view.state, "degraded");
});
