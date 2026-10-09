import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const temp = mkdtempSync(join(tmpdir(), "llm-garage-loading-"));
try {
  const agentDir = join(temp, "agent");
  mkdirSync(join(agentDir, "extensions"), { recursive: true });
  symlinkSync(root, join(agentDir, "extensions", "llm-garage"), "dir");
  const loader = new DefaultResourceLoader({
    cwd: temp,
    agentDir,
    settingsManager: SettingsManager.inMemory(),
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();
  const result = loader.getExtensions();
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(
    result.extensions.map((extension) => realpathSync(extension.resolvedPath)).sort(),
    manifest.pi.extensions.map((entry) => realpathSync(join(root, entry))).sort(),
  );
  const serviceKey = Symbol.for("llm-garage.pi-custom-extensions.tool-set");
  const firstService = globalThis[serviceKey];
  assert.ok(firstService, "the real loader must publish the ToolSet service");
  const firstToolSet = result.extensions.find((extension) =>
    realpathSync(extension.resolvedPath) === realpathSync(join(root, "tool-set/index.ts")),
  );

  await loader.reload();
  const reloaded = loader.getExtensions();
  assert.deepEqual(reloaded.errors, []);
  assert.deepEqual(reloaded.warnings, []);
  assert.deepEqual(
    reloaded.extensions.map((extension) => realpathSync(extension.resolvedPath)).sort(),
    manifest.pi.extensions.map((entry) => realpathSync(join(root, entry))).sort(),
  );
  const replacement = globalThis[serviceKey];
  assert.notEqual(replacement, firstService, "reload must publish a fresh service");
  for (const handler of firstToolSet.handlers.get("session_shutdown") ?? []) {
    await handler({ type: "session_shutdown" }, {});
  }
  assert.equal(globalThis[serviceKey], replacement, "stale shutdown must preserve the replacement service");
  const currentToolSet = reloaded.extensions.find((extension) =>
    realpathSync(extension.resolvedPath) === realpathSync(join(root, "tool-set/index.ts")),
  );
  for (const handler of currentToolSet.handlers.get("session_shutdown") ?? []) {
    await handler({ type: "session_shutdown" }, {});
  }
  assert.equal(globalThis[serviceKey], undefined, "shutdown must unpublish the current service");
  console.log(`Loaded all ${result.extensions.length} extensions exactly once per load; verified reload and stale-service cleanup.`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
