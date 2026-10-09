import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
function tests(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules") return [];
    const file = join(directory, entry.name);
    return entry.isDirectory() ? tests(file) : file.endsWith(".test.ts") ? [file] : [];
  });
}
const result = spawnSync(process.execPath, ["--experimental-strip-types", "--test", ...tests(root)], {
  cwd: root,
  stdio: "inherit",
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
