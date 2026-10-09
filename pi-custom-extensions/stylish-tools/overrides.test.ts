import assert from "node:assert/strict";
import { test } from "node:test";
import { clearOperationsOverride, getOperationsOverride, setOperationsOverride } from "./overrides.ts";

test("operation overrides are shared across independent import graphs", async () => {
  const copy = await import(new URL("./overrides.ts?independent-import", import.meta.url).href) as typeof import("./overrides.ts");
  try {
    setOperationsOverride({ tag: "ssh:test" });
    assert.equal(copy.getOperationsOverride().tag, "ssh:test");
    copy.clearOperationsOverride();
    assert.deepEqual(getOperationsOverride(), {});
  } finally {
    clearOperationsOverride();
  }
});
