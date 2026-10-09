import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const entries = new Set(manifest.pi.extensions.map((file) => resolve(root, file)));
const graph = new Map();

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
  function check(node) {
    let specifier;
    let typeOnly = false;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      specifier = node.moduleSpecifier;
      typeOnly = ts.isImportDeclaration(node)
        ? node.importClause?.isTypeOnly || (!node.importClause?.name &&
          node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings) &&
          node.importClause.namedBindings.elements.every((binding) => binding.isTypeOnly))
        : node.isTypeOnly || (node.exportClause && ts.isNamedExports(node.exportClause) &&
          node.exportClause.elements.every((binding) => binding.isTypeOnly));
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      specifier = node.moduleReference.expression;
      typeOnly = node.isTypeOnly;
    } else if (ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(source) === "require")) {
      specifier = node.arguments[0];
    }
    if (specifier && (ts.isStringLiteral(specifier) || ts.isNoSubstitutionTemplateLiteral(specifier)) && specifier.text.startsWith(".")) {
      const target = resolve(dirname(file), specifier.text);
      assert.ok(!entries.has(target), `${relative(root, file)} imports extension entry point ${relative(root, target)}; use its public modules`);
      if (!typeOnly) dependencies.push(target);
    }
    ts.forEachChild(node, check);
  }
  check(source);
  const hasDefault = source.statements.some((node) => node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword));
  assert.equal(hasDefault, entries.has(file), `${relative(root, file)}: default factories belong only in manifest entry points`);
  graph.set(file, dependencies);
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
console.log(`Architecture checked: ${entries.size} entry points, ${graph.size} source modules, no entry-point imports or runtime cycles.`);
