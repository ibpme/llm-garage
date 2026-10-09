import assert from "node:assert/strict";
import { test } from "node:test";
import type { ToolSet } from "./contracts.ts";
import { getRequiredToolSet, publishToolSet, tryGetToolSet } from "./service.ts";

test("service shares state across module instances and stale cleanup preserves replacements", async () => {
  const copy = await import(new URL("./service.ts?independent-import", import.meta.url).href) as typeof import("./service.ts");
  const first = { getMode: () => "safe" } as ToolSet;
  const second = { getMode: () => "yolo" } as ToolSet;
  assert.equal(tryGetToolSet(), undefined);
  assert.throws(getRequiredToolSet, /has not loaded/);
  const removeFirst = publishToolSet(first);
  assert.equal(copy.getRequiredToolSet(), first);
  const removeSecond = copy.publishToolSet(second);
  removeFirst();
  assert.equal(getRequiredToolSet(), second);
  removeSecond();
  removeSecond();
  assert.equal(tryGetToolSet(), undefined);
});
