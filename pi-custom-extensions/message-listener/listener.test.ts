import assert from "node:assert/strict";
import { stat, access } from "node:fs/promises";
import { createConnection } from "node:net";
import test from "node:test";

import { startListener } from "./listener.ts";
const message = { version: 2, type: "message", id: "one", content: "Hello 🌏" };
function request(path: string, input: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let output = "";
    socket.setTimeout(3000, () => { socket.destroy(); reject(new Error("timeout")); });
    socket.on("error", reject);
    socket.on("connect", () => {
      const bytes = Buffer.from(input);
      const emoji = bytes.indexOf(Buffer.from("🌏"));
      const split = emoji < 0 ? 12 : emoji + 2;
      socket.write(bytes.subarray(0, split));
      setImmediate(() => socket.end(bytes.subarray(split)));
    });
    socket.on("data", chunk => { output += chunk; });
    socket.on("end", () => { try { resolve(JSON.parse(output)); } catch (error) { reject(error); } });
  });
}
async function setup(t: test.TestContext, deliver: (value: any) => void = () => {}) {
  const listener = await startListener(deliver);
  t.after(() => listener.close());
  return listener;
}

test("private socket accepts fragmented UTF-8 JSON and defaults to followUp", async t => {
  const received: any[] = [];
  const listener = await setup(t, value => received.push(value));
  assert.equal((await stat(listener.path)).mode & 0o777, 0o600);
  assert.equal((await stat(listener.directory)).mode & 0o777, 0o700);
  assert.deepEqual(await request(listener.path, JSON.stringify(message) + "\n"), { version: 2, type: "ack", id: "one", ok: true, status: "accepted" });
  assert.deepEqual(received, [{ ...message, deliverAs: "followUp" }]);
  await listener.close();
  await assert.rejects(access(listener.path));
  await listener.close();
});

test("duplicate ids do not re-deliver; changed payloads with the same id are rejected", async t => {
  const received: any[] = [];
  const listener = await setup(t, value => received.push(value));
  await request(listener.path, JSON.stringify(message) + "\n");
  assert.equal((await request(listener.path, JSON.stringify(message) + "\n")).status, "duplicate");
  assert.equal((await request(listener.path, JSON.stringify({ ...message, content: "Changed" }) + "\n")).ok, false);
  assert.equal(received.length, 1);
});

test("invalid, oversized and incomplete requests are rejected without delivery", async t => {
  const received: any[] = [];
  const listener = await setup(t, value => received.push(value));
  for (const input of ["oops\n", JSON.stringify({ ...message, deliverAs: "nextTurn" }) + "\n", JSON.stringify({ ...message, extra: true }) + "\n", JSON.stringify({ ...message, replyTo: { transport: "unix", path: "/tmp/reply.sock" } }) + "\n", JSON.stringify({ ...message, from: { id: "sender" } }) + "\n", JSON.stringify({ ...message, version: 1 }) + "\n", JSON.stringify({ ...message, content: "   " }) + "\n", "x".repeat(65537), JSON.stringify(message)]) {
    assert.equal((await request(listener.path, input)).ok, false);
  }
  assert.equal(received.length, 0);
});

test("a delivery failure gets a negative ack and may be retried", async t => {
  let fail = true;
  const received: any[] = [];
  const listener = await setup(t, value => { if (fail) throw new Error("unavailable"); received.push(value); });
  assert.equal((await request(listener.path, JSON.stringify(message) + "\n")).ok, false);
  fail = false;
  assert.equal((await request(listener.path, JSON.stringify({ ...message, deliverAs: "steer" }) + "\n")).status, "accepted");
  assert.equal(received[0].deliverAs, "steer");
});

test("equivalent envelope key order and default delivery mode deduplicate", async t => {
  const listener = await setup(t);
  await request(listener.path, JSON.stringify(message) + "\n");
  const reordered = { content: message.content, id: message.id, type: message.type, version: 2, deliverAs: "followUp" };
  assert.equal((await request(listener.path, JSON.stringify(reordered) + "\n")).status, "duplicate");
});

test("invalid UTF-8 is rejected rather than silently replaced in content", async t => {
  const received: any[] = [];
  const listener = await setup(t, value => received.push(value));
  const input = Buffer.concat([Buffer.from(JSON.stringify(message).replace("Hello 🌏", "SPLIT").split("SPLIT")[0]!), Buffer.from([0xff]), Buffer.from(JSON.stringify(message).replace("Hello 🌏", "SPLIT").split("SPLIT")[1]! + "\n")]);
  const ack = await new Promise<any>((resolve, reject) => {
    const socket = createConnection(listener.path);
    let output = "";
    socket.on("error", reject);
    socket.on("connect", () => socket.end(input));
    socket.on("data", chunk => output += chunk);
    socket.on("end", () => resolve(JSON.parse(output)));
  });
  assert.equal(ack.ok, false);
  assert.equal(received.length, 0);
});

test("an explicit null delivery mode is rejected rather than defaulted", async t => {
  const listener = await setup(t);
  assert.equal((await request(listener.path, JSON.stringify({ ...message, deliverAs: null }) + "\n")).ok, false);
});
