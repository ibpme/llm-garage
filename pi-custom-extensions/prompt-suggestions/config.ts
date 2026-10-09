import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SuggestionConfig } from "./contracts.ts";

const CONFIG_DIR = join(homedir(), ".pi", "agent");

const CONFIG_PATH = join(CONFIG_DIR, "prompt-suggestions.json");

export const DEFAULT_CONFIG: SuggestionConfig = {
  enabled: true,
  provider: "opencode-go",
  model: "muse-spark-1.3-contributor",
  ollamaUrl: "http://127.0.0.1:11434",
};

function normalizeUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseConfig(raw: unknown): Partial<SuggestionConfig> {
  if (!raw || typeof raw !== "object") return {};
  const value = raw as Record<string, unknown>;
  const ollamaUrl = nonEmptyString(value.ollamaUrl);

  return {
    enabled: typeof value.enabled === "boolean" ? value.enabled : undefined,
    provider: nonEmptyString(value.provider),
    model: nonEmptyString(value.model),
    ollamaUrl: ollamaUrl ? normalizeUrl(ollamaUrl) : undefined,
  };
}

async function readConfigFile(): Promise<Partial<SuggestionConfig>> {
  try {
    return parseConfig(JSON.parse(await readFile(CONFIG_PATH, "utf8")));
  } catch {
    return {};
  }
}

export async function loadConfig(): Promise<SuggestionConfig> {
  const saved = await readConfigFile();
  return {
    enabled: saved.enabled ?? DEFAULT_CONFIG.enabled,
    provider:
      nonEmptyString(process.env.PI_SUGGESTIONS_PROVIDER) ??
      saved.provider ??
      // Old config files only described an Ollama endpoint.
      (saved.ollamaUrl ? "ollama" : DEFAULT_CONFIG.provider),
    model:
      nonEmptyString(process.env.PI_SUGGESTIONS_MODEL) ??
      saved.model ??
      DEFAULT_CONFIG.model,
    ollamaUrl: normalizeUrl(
      nonEmptyString(process.env.PI_SUGGESTIONS_OLLAMA_URL) ??
      saved.ollamaUrl ??
      DEFAULT_CONFIG.ollamaUrl,
    ),
  };
}

export async function saveConfig(config: SuggestionConfig): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}
