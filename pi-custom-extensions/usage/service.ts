import type { AuthResult, Credential, ModelAuth } from "@earendil-works/pi-ai";
import type { ExtensionContext, ModelRegistry } from "@earendil-works/pi-coding-agent";
import {
  CHATGPT_USAGE_URL, PROVIDERS, TITLES, UsageError, parseCodex, parseOpenCodeGo,
  record, verifyAppRegistration,
} from "./providers.ts";
import type { UsageProvider, UsageReport } from "./providers.ts";

const GO_URL = "https://opencode.ai/zen/go/v1/usage";
const CODEX_URL = "https://chatgpt.com/backend-api/wham/usage";
const MAX_BODY_BYTES = 1024 * 1024;

type Registry = Pick<ModelRegistry, "getAll" | "getProviderAuthStatus" | "getProviderAuth" | "getApiKeyAndHeaders">;
export type UsageContext = Pick<ExtensionContext, "model"> & { modelRegistry: Registry };
export interface UsageDependencies {
  fetch: typeof fetch;
  readCredential(provider: string): Credential | undefined;
}

export function selectProviders(args: string, ctx: UsageContext): UsageProvider[] {
  const arg = args.trim().toLowerCase();
  if (arg && arg !== "all") {
    if (!PROVIDERS.includes(arg as UsageProvider)) {
      throw new UsageError("Use /usage [all|opencode-go|openai|openai-codex].");
    }
    return [arg as UsageProvider];
  }
  const configured = PROVIDERS.filter((provider) => ctx.modelRegistry.getProviderAuthStatus(provider).configured);
  // A companion login is already represented by the native OpenAI report.
  return configured.filter((provider) => provider !== "openai-codex" || !configured.includes("openai"));
}

function bearer(auth: ModelAuth): string | undefined {
  const entry = Object.entries(auth.headers ?? {}).find(([key]) => key.toLowerCase() === "authorization");
  if (entry) return typeof entry[1] === "string" && /^Bearer\s+\S+$/i.test(entry[1])
    ? entry[1].replace(/^Bearer\s+/i, "") : undefined;
  return auth.apiKey;
}

function officialOrigin(value: string, expected: string): boolean {
  try { return new URL(value).origin === expected; } catch { return false; }
}

async function resolveAuth(provider: UsageProvider, ctx: UsageContext): Promise<{ result: AuthResult; token: string }> {
  const model = ctx.model?.provider === provider ? ctx.model
    : ctx.modelRegistry.getAll().find((candidate) => candidate.provider === provider);
  if (!model) throw new UsageError(`No ${TITLES[provider]} model is registered in Pi.`);
  const origin = provider === "opencode-go" ? "https://opencode.ai"
    : provider === "openai" ? "https://api.openai.com" : "https://chatgpt.com";
  if (!officialOrigin(model.baseUrl, origin)) {
    throw new UsageError("Usage lookup is only supported for the official provider origin, not custom endpoints or proxies.");
  }
  let result: AuthResult | undefined;
  let effective: Awaited<ReturnType<Registry["getApiKeyAndHeaders"]>>;
  try {
    result = await ctx.modelRegistry.getProviderAuth(provider);
    effective = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  } catch {
    throw new UsageError(`Could not resolve ${TITLES[provider]} credentials. Check /login and try again.`);
  }
  if (!result || !effective.ok) throw new UsageError(`No usable ${TITLES[provider]} credentials. Use /login ${provider}.`);
  if ([result.auth.baseUrl, effective.baseUrl].some((url) => url !== undefined && !officialOrigin(url, origin))) {
    throw new UsageError("Usage lookup cannot send custom-endpoint credentials to the official provider.");
  }
  const token = bearer(effective);
  if (!token || token !== bearer(result.auth)) {
    throw new UsageError("Effective model authorization differs from provider authorization; usage lookup was skipped.");
  }
  return { result, token };
}

function matchingOAuth(provider: UsageProvider, token: string, deps: UsageDependencies): Credential & { type: "oauth" } {
  const credential = deps.readCredential(provider);
  if (credential?.type !== "oauth" || credential.access !== token ||
    !credential.refresh || !Number.isFinite(credential.expires)) {
    throw new UsageError(`The resolved token does not match Pi's stored ${provider} OAuth login. Use /login ${provider}.`);
  }
  return credential;
}

function codexAccountId(token: string, stored: unknown): string {
  let claimed: unknown;
  try {
    const claims = record(JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")));
    claimed = record(claims?.["https://api.openai.com/auth"])?.chatgpt_account_id;
  } catch { /* A stored account ID also supports opaque access tokens. */ }
  if (typeof claimed === "string" && typeof stored === "string" && claimed !== stored) {
    throw new UsageError("Codex token and stored account ID disagree. Reconnect with /login openai-codex.");
  }
  const accountId = typeof stored === "string" && stored ? stored : claimed;
  if (typeof accountId !== "string" || !/^[\w-]{1,200}$/.test(accountId)) {
    throw new UsageError("Codex OAuth has no valid account ID. Reconnect with /login openai-codex.");
  }
  return accountId;
}

async function getJson(url: string, token: string, deps: UsageDependencies, signal: AbortSignal, accountId?: string): Promise<unknown> {
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
  try {
    const response = await deps.fetch(url, {
      method: "GET", redirect: "error", signal: requestSignal,
      headers: {
        Authorization: `Bearer ${token}`, Accept: "application/json",
        "User-Agent": "llm-garage-pi-usage/1.0",
        ...(accountId ? { "ChatGPT-Account-Id": accountId } : {}),
      },
    });
    if (!response.ok) {
      await response.body?.cancel();
      const hint = response.status === 401 ? " Reconnect with /login."
        : response.status === 403 ? " This account or token may not have access to usage."
        : response.status === 429 ? " Try again later." : "";
      throw new UsageError(`Usage request failed (HTTP ${response.status}).${hint}`);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new UsageError("The usage endpoint returned an empty response.");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BODY_BYTES) throw new UsageError("The usage response exceeded the size limit.");
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { throw new UsageError("The usage endpoint returned invalid JSON (possibly an unavailable route)."); }
  } catch (error) {
    if (error instanceof UsageError) throw error;
    if (signal.aborted) throw new UsageError("Usage lookup cancelled.");
    if (requestSignal.aborted) throw new UsageError("Usage request timed out after 10 seconds.");
    // Never display raw fetch/auth errors or server bodies: they may contain credentials.
    throw new UsageError("Could not reach the usage endpoint. Check your connection and try again.");
  }
}

async function query(provider: UsageProvider, ctx: UsageContext, deps: UsageDependencies, signal: AbortSignal): Promise<UsageReport> {
  const { result, token } = await resolveAuth(provider, ctx);
  signal.throwIfAborted();
  if (provider === "opencode-go") return parseOpenCodeGo(await getJson(GO_URL, token, deps, signal));
  if (result.source !== "OAuth") {
    return {
      provider, title: TITLES[provider], windows: [], notes: [
        "API-key account usage is not supported. OpenAI's organization Usage API requires a separate admin key.",
        "Review API usage at https://platform.openai.com/usage",
      ],
    };
  }
  const credential = matchingOAuth(provider, token, deps);
  if (provider === "openai") {
    if (typeof credential.clientId !== "string" || !credential.clientId.trim() ||
      !Array.isArray(credential.scopes) || !credential.scopes.includes("chatgpt.tokens.use.direct")) {
      throw new UsageError("The native OpenAI OAuth grant is incomplete. Reconnect with /login openai.");
    }
    if (!ctx.modelRegistry.getProviderAuthStatus("openai-codex").configured) {
      return {
        provider, title: TITLES[provider], windows: [], notes: [
          "Connected with native ChatGPT OAuth. This token has no numerical quota endpoint.",
          "For shared-plan quotas, use /login openai-codex with the same ChatGPT account/workspace, then run /usage again.",
          `Without a companion login, check ${CHATGPT_USAGE_URL}`,
        ],
      };
    }
    const companion = await resolveAuth("openai-codex", ctx);
    if (companion.result.source !== "OAuth") throw new UsageError("The OpenAI quota companion must use /login openai-codex OAuth, not an API key.");
    const codexCredential = matchingOAuth("openai-codex", companion.token, deps);
    const accountId = codexAccountId(companion.token, codexCredential.accountId);
    verifyAppRegistration(await getJson(`${CODEX_URL}/chatpass/apps`, companion.token, deps, signal, accountId), credential.clientId);
    const report = parseCodex(await getJson(CODEX_URL, companion.token, deps, signal, accountId));
    return {
      ...report, provider, title: TITLES[provider],
      windows: report.windows.filter((window) => !window.label.startsWith("Code review · "))
        .map((window) => ({ ...window, label: `Shared plan · ${window.label}` })),
      notes: [
        ...report.notes,
        "Shared-plan usage via the matching Codex companion; Pi's separate app allowance can also limit requests.",
        `For app-specific usage, check ${CHATGPT_USAGE_URL}`,
        "The companion endpoint is undocumented and may change.",
      ],
    };
  }
  const accountId = codexAccountId(token, credential.accountId);
  return parseCodex(await getJson(CODEX_URL, token, deps, signal, accountId));
}

export async function collectUsage(providers: readonly UsageProvider[], ctx: UsageContext, deps: UsageDependencies, signal: AbortSignal): Promise<UsageReport[]> {
  return Promise.all(providers.map(async (provider) => {
    try { return await query(provider, ctx, deps, signal); }
    catch (error) {
      return {
        provider, title: TITLES[provider], windows: [],
        notes: [error instanceof UsageError ? error.message : "Usage lookup failed. Check credentials and try again."],
      };
    }
  }));
}
