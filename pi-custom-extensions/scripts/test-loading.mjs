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
  console.log(`Loaded all ${result.extensions.length} extensions exactly once via the package symlink.`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
