import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type ContextWindowResolver = (provider: string, model: string) => number | undefined;

interface ModelLookup {
  find(provider: string, modelId: string): { contextWindow?: number } | undefined;
}

type JsonObject = Record<string, unknown>;
const object = (value: unknown): JsonObject => value && typeof value === "object" ? value as JsonObject : {};

// Maps provider/model to whether models.json declares its contextWindow. Undefined when the file is unreadable.
async function declarations(path: string): Promise<Map<string, boolean> | undefined> {
  let raw: string;
  try { raw = await readFile(path, "utf8"); }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? new Map() : undefined; }
  let parsed: unknown;
  try { parsed = JSON.parse(raw.replace(/^\uFEFF/, "")); }
  catch { return undefined; }
  const result = new Map<string, boolean>();
  for (const [provider, config] of Object.entries(object(object(parsed).providers))) {
    const models = object(config).models;
    if (!Array.isArray(models)) continue;
    for (const definition of models) {
      const entry = object(definition);
      if (typeof entry.id !== "string") continue;
      const key = JSON.stringify([provider, entry.id]);
      result.set(key, (result.get(key) ?? true) && typeof entry.contextWindow === "number");
    }
  }
  return result;
}

// Pi fills an undeclared contextWindow with 128000 for custom models, so such models are unknown here.
// Any other registry value is Pi's configured or catalog capacity for that exact provider and model.
export async function contextWindowResolver(catalog: ModelLookup, path = join(getAgentDir(), "models.json")): Promise<ContextWindowResolver> {
  const declared = await declarations(path);
  return (provider, model) => {
    if (!declared || declared.get(JSON.stringify([provider, model])) === false) return undefined;
    const window = catalog.find(provider, model)?.contextWindow;
    return window !== undefined && Number.isFinite(window) && window > 0 ? window : undefined;
  };
}
