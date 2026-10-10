import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { loadedSkills, skillFromRead } from "./state.ts";

function entry(message: unknown): SessionEntry {
  return { type: "message", id: "test", parentId: null, timestamp: "2026-01-01", message } as SessionEntry;
}

const call = entry({ role: "assistant", content: [
  { type: "toolCall", id: "read1", name: "read", arguments: { path: "/skills/tdd/SKILL.md" } },
] });
const result = (isError = false) => entry({ role: "toolResult", toolCallId: "read1", isError });

test("recognizes skill documents, not references or unrelated tools", () => {
  assert.equal(skillFromRead("read", { path: "/custom/tdd/SKILL.md" }), "tdd");
  assert.equal(skillFromRead("read", { path: "skills/commit.md" }), "commit");
  assert.equal(skillFromRead("read", { path: "C:\\skills\\tdd\\SKILL.md" }), "tdd");
  assert.equal(skillFromRead("read", { path: "/skills/tdd/references/testing.md" }), undefined);
  assert.equal(skillFromRead("read_remote", { path: "/skills/tdd/SKILL.md" }), undefined);
  assert.equal(skillFromRead("read", {}), undefined);
});

test("counts only successful reads and deduplicates names", () => {
  assert.deepEqual([...loadedSkills([call])], []);
  assert.deepEqual([...loadedSkills([call, result(true)])], []);
  assert.deepEqual([...loadedSkills([call, result(), call, result()])], ["tdd"]);
  assert.deepEqual([...loadedSkills([])], []);
});

test("restores successful codemode reads without requiring a successful parent", () => {
  const nested = entry({ role: "toolResult", isError: true, nestedCalls: { calls: [
    { name: "read", arguments: { path: "/skills/tdd/SKILL.md" }, status: "ok" },
    { name: "read", arguments: { path: "/skills/commit/SKILL.md" }, status: "error" },
    { name: "read", status: "ok" },
  ] } });
  assert.deepEqual([...loadedSkills([nested])], ["tdd"]);
});

test("recognizes explicit skill command expansion, not mere mentions", () => {
  const text = '<skill name="different-name" location="/skills/folder/SKILL.md">\nInstructions\n</skill>';
  assert.deepEqual([...loadedSkills([entry({ role: "user", content: text })])], ["different-name"]);
  assert.deepEqual([...loadedSkills([entry({ role: "user", content: [{ type: "text", text }] })])], ["different-name"]);
  assert.deepEqual([...loadedSkills([entry({ role: "user", content: "Please use /skill:tdd" })])], []);
});
