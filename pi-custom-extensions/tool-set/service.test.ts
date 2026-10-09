import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createToolSet } from "./state.ts";
import { getRequiredToolSet, publishToolSet, tryGetToolSet } from "./service.ts";

function toolSet() {
  return createToolSet({
    getActiveTools: () => [], getAllTools: () => [], setActiveTools() {},
  } as unknown as ExtensionAPI);
}

test("an unavailable ToolSet is optional or reports a useful error when required", () => {
  assert.equal(tryGetToolSet(), undefined);
  assert.throws(getRequiredToolSet, /has not loaded/);
});

test("independent extension import graphs access the same running ToolSet", async (t) => {
  const copy = await import(new URL("./service.ts?independent-import", import.meta.url).href) as typeof import("./service.ts");
  const tools = toolSet();
  t.after(publishToolSet(tools));
  copy.getRequiredToolSet().setMode("safe");
  assert.equal(getRequiredToolSet().getMode(), "safe");
});

test("cleanup from an old runtime leaves its replacement available", (t) => {
  const removeFirst = publishToolSet(toolSet());
  t.after(removeFirst);
  const replacement = toolSet();
  replacement.setMode("safe");
  t.after(publishToolSet(replacement));
  removeFirst();
  assert.equal(getRequiredToolSet(), replacement);
});

test("cleanup unpublishes the current ToolSet and can be repeated", (t) => {
  const remove = publishToolSet(toolSet());
  t.after(remove);
  remove();
  remove();
  assert.equal(tryGetToolSet(), undefined);
});
