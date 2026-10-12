import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const entries = new Set(manifest.pi.extensions.map((file) => resolve(root, file)));
const graph = new Map();
const externals = new Map();
// Detached Node entry points run outside Pi: their runtime import closure may only use node: builtins.
const standalone = (manifest.standaloneEntryPoints ?? []).map((file) => resolve(root, file));

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules") return [];
    const file = join(directory, entry.name);
    return entry.isDirectory() ? walk(file) : file.endsWith(".ts") && !file.endsWith(".test.ts") ? [file] : [];
  });
}

for (const file of walk(root)) {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const dependencies = [];
  const loaded = [];
  const packages = [];
  function check(node) {
    let specifier;
    let typeOnly = false;
    // Node's type stripping keeps `import { type A } from "x"` as a side-effect
    // import; only `import type`/`export type` are erased entirely.
    let erased = false;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      specifier = node.moduleSpecifier;
      typeOnly = ts.isImportDeclaration(node)
        ? node.importClause?.isTypeOnly || (!node.importClause?.name &&
          node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings) &&
          node.importClause.namedBindings.elements.every((binding) => binding.isTypeOnly))
        : node.isTypeOnly || (node.exportClause && ts.isNamedExports(node.exportClause) &&
          node.exportClause.elements.every((binding) => binding.isTypeOnly));
      erased = ts.isImportDeclaration(node) ? !!node.importClause?.isTypeOnly : node.isTypeOnly;
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      specifier = node.moduleReference.expression;
      typeOnly = erased = node.isTypeOnly;
    } else if (ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(source) === "require")) {
      specifier = node.arguments[0];
    }
    if (specifier && (ts.isStringLiteral(specifier) || ts.isNoSubstitutionTemplateLiteral(specifier))) {
      if (specifier.text.startsWith(".")) {
        const target = resolve(dirname(file), specifier.text);
        assert.ok(!entries.has(target), `${relative(root, file)} imports extension entry point ${relative(root, target)}; use its public modules`);
        if (!typeOnly) dependencies.push(target);
        if (!erased) loaded.push(target);
      } else if (!erased && !specifier.text.startsWith("node:")) {
        packages.push(specifier.text);
      }
    }
    ts.forEachChild(node, check);
  }
  check(source);
  const hasDefault = source.statements.some((node) => node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword));
  assert.equal(hasDefault, entries.has(file), `${relative(root, file)}: default factories belong only in manifest entry points`);
  graph.set(file, dependencies);
  externals.set(file, { loaded, packages });
}

const visited = new Set();
const visiting = new Set();
function visit(file, chain = []) {
  assert.ok(!visiting.has(file), `Runtime import cycle: ${[...chain, file].map((item) => relative(root, item)).join(" -> ")}`);
  if (visited.has(file)) return;
  visiting.add(file);
  for (const dependency of graph.get(file) ?? []) visit(dependency, [...chain, file]);
  visiting.delete(file);
  visited.add(file);
}
for (const file of graph.keys()) visit(file);

for (const entry of standalone) {
  assert.ok(graph.has(entry), `Missing standalone entry point ${relative(root, entry)}`);
  assert.ok(!entries.has(entry), `${relative(root, entry)} must not be a Pi extension entry point`);
  const seen = new Set();
  const pending = [[entry, [entry]]];
  while (pending.length) {
    const [file, chain] = pending.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const { loaded, packages } = externals.get(file) ?? { loaded: [], packages: [] };
    for (const name of packages) {
      assert.fail(`${relative(root, entry)} runs outside Pi but loads "${name}" at runtime via ${chain.map((item) => relative(root, item)).join(" -> ")}`);
    }
    for (const dependency of loaded) pending.push([dependency, [...chain, dependency]]);
  }
}
console.log(`Architecture checked: ${entries.size} entry points, ${graph.size} source modules, no entry-point imports or runtime cycles; ${standalone.length} standalone entry point(s) free of package runtime imports.`);
