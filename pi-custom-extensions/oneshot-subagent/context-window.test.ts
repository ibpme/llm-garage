import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { contextWindowResolver } from "./context-window.ts";

const catalog = (models: Record<string, number>) => ({
  find: (provider: string, id: string) => {
    const window = models[`${provider}/${id}`];
    return window === undefined ? undefined : { contextWindow: window };
  },
});

async function withModels(content: string | undefined, run: (path: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "context-window-test-"));
  try {
    const path = join(dir, "models.json");
    if (content !== undefined) await writeFile(path, content);
    await run(path);
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test("a built-in catalog model not declared in models.json uses its registry capacity", async () => {
  await withModels(undefined, async (path) => {
    const resolve = await contextWindowResolver(catalog({ "anthropic/claude-x": 200_000 }), path);
    assert.equal(resolve("anthropic", "claude-x"), 200_000);
  });
});

test("a custom model that declares its own contextWindow is trusted", async () => {
  await withModels(JSON.stringify({ providers: { local: { models: [{ id: "m", contextWindow: 32_000 }] } } }), async (path) => {
    const resolve = await contextWindowResolver(catalog({ "local/m": 32_000 }), path);
    assert.equal(resolve("local", "m"), 32_000);
  });
});

test("a custom model declared without contextWindow is unknown, not Pi's 128k fallback", async () => {
  await withModels(JSON.stringify({ providers: { local: { models: [{ id: "m" }] } } }), async (path) => {
    const resolve = await contextWindowResolver(catalog({ "local/m": 128_000 }), path);
    assert.equal(resolve("local", "m"), undefined);
  });
});

test("models absent from the registry, with invalid capacity, are unknown", async () => {
  await withModels(undefined, async (path) => {
    assert.equal((await contextWindowResolver(catalog({}), path))("anthropic", "missing"), undefined);
    for (const window of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const resolve = await contextWindowResolver(catalog({ "anthropic/x": window }), path);
      assert.equal(resolve("anthropic", "x"), undefined, String(window));
    }
  });
});

test("unreadable or malformed models.json makes every capacity unknown", async () => {
  await withModels("{", async (path) => {
    const resolve = await contextWindowResolver(catalog({ "anthropic/claude-x": 200_000 }), path);
    assert.equal(resolve("anthropic", "claude-x"), undefined);
  });
});

test("the lookup uses only the provider and model it is given", async () => {
  await withModels(undefined, async (path) => {
    const seen: string[] = [];
    const registry = { find: (provider: string, id: string) => { seen.push(`${provider}/${id}`); return { contextWindow: 1 }; } };
    const resolve = await contextWindowResolver(registry, path);
    resolve("opencode-go", "claude-haiku-5-5");
    assert.deepEqual(seen, ["opencode-go/claude-haiku-5-5"]);
  });
});
