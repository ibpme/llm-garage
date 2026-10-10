import assert from "node:assert/strict";
import { test } from "node:test";
import { InMemoryCredentialStore, type AuthResult, type Credential, type ModelAuth } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { collectUsage, selectProviders } from "./service.ts";
import type { UsageContext, UsageDependencies } from "./service.ts";
import type { UsageProvider } from "./providers.ts";

const oauth = (access: string, extra: Record<string, unknown> = {}): Credential => ({
  type: "oauth", access, refresh: "refresh", expires: Date.now() + 3600_000, ...extra,
});
const quota = { plan_type: "plus", rate_limit: { primary_window: { used_percent: 25, limit_window_seconds: 18000, reset_at: 1893456000 } } };
const goQuota = { usage: { rolling: { status: "ok", percent: 15, resetsAt: "2030-01-01T00:00:00Z" } } };

function fixture(options: {
  providers?: UsageProvider[];
  auth?: Partial<Record<UsageProvider, AuthResult>>;
  effective?: Partial<Record<UsageProvider, ModelAuth>>;
  credentials?: Partial<Record<UsageProvider, Credential>>;
  origins?: Partial<Record<UsageProvider, string>>;
  reply?: (url: string, init: RequestInit) => Promise<Response>;
} = {}) {
  const providers = options.providers ?? ["opencode-go", "openai", "openai-codex"];
  const auth: Record<UsageProvider, AuthResult> = {
    "opencode-go": { auth: { apiKey: "go-key" }, source: "stored credential" },
    openai: { auth: { apiKey: "native-token" }, source: "OAuth" },
    "openai-codex": { auth: { apiKey: "codex-token" }, source: "OAuth" },
    ...options.auth,
  };
  const credentials: Record<UsageProvider, Credential> = {
    "opencode-go": { type: "api_key", key: "go-key" },
    openai: oauth("native-token", { clientId: "pi-app", scopes: ["chatgpt.tokens.use.direct"] }),
    "openai-codex": oauth("codex-token", { accountId: "same-account" }),
    ...options.credentials,
  };
  const origins: Record<UsageProvider, string> = {
    "opencode-go": "https://opencode.ai/zen/go/v1",
    openai: "https://api.openai.com/v1",
    "openai-codex": "https://chatgpt.com/backend-api",
    ...options.origins,
  };
  const models = providers.map((provider) => ({
    provider, id: "model", baseUrl: origins[provider],
  })) as NonNullable<UsageContext["model"]>[];
  const ctx: UsageContext = {
    model: models[0],
    modelRegistry: {
      getAll: () => models,
      getProviderAuthStatus: (provider) => ({ configured: providers.includes(provider as UsageProvider) }),
      getProviderAuth: async (provider) => auth[provider as UsageProvider],
      getApiKeyAndHeaders: async (model) => ({ ok: true, ...(options.effective?.[model.provider as UsageProvider] ?? auth[model.provider as UsageProvider].auth) }),
    },
  };
  const requests: { url: string; init: RequestInit }[] = [];
  const deps: UsageDependencies = {
    readCredential: (provider) => credentials[provider as UsageProvider],
    fetch: (async (url, init) => {
      requests.push({ url: String(url), init: init! });
      if (options.reply) return options.reply(String(url), init!);
      return Response.json(String(url).endsWith("/apps") ? { items: [{ id: "pi-app" }] }
        : String(url).includes("opencode.ai") ? goQuota : quota);
    }) as typeof fetch,
  };
  return { ctx, deps, requests };
}

const run = (provider: UsageProvider, f: ReturnType<typeof fixture>, signal = new AbortController().signal) =>
  collectUsage([provider], f.ctx, f.deps, signal).then((reports) => reports[0]);

test("selection defaults to configured providers, deduplicates a native companion, and supports explicit selection", () => {
  const f = fixture();
  assert.deepEqual(selectProviders("", f.ctx), ["opencode-go", "openai"]);
  assert.deepEqual(selectProviders("all", f.ctx), ["opencode-go", "openai"]);
  assert.deepEqual(selectProviders(" OPENAI-CODEX ", f.ctx), ["openai-codex"]);
  assert.deepEqual(selectProviders("", fixture({ providers: ["openai-codex"] }).ctx), ["openai-codex"]);
  assert.deepEqual(selectProviders("", fixture({ providers: [] }).ctx), []);
  assert.throws(() => selectProviders("openai extra", f.ctx), /Use \/usage/);
});

test("Go sends only resolved credentials to its fixed read-only endpoint", async () => {
  const f = fixture();
  const report = await run("opencode-go", f);
  assert.equal(report.windows[0].usedPercent, 15);
  assert.equal(f.requests[0].url, "https://opencode.ai/zen/go/v1/usage");
  assert.equal(f.requests[0].init.method, "GET");
  assert.equal(f.requests[0].init.redirect, "error");
  assert.deepEqual(f.requests[0].init.headers, {
    Authorization: "Bearer go-key", Accept: "application/json", "User-Agent": "llm-garage-pi-usage/1.0",
  });
});

test("native OpenAI without a companion reports web-only, making no usage requests", async () => {
  const f = fixture({ providers: ["openai"] });
  const report = await run("openai", f);
  assert.equal(report.windows.length, 0);
  assert.match(report.notes.join(" "), /login openai-codex/);
  assert.match(report.notes.join(" "), /chatgpt.com\/settings\/usage/);
  assert.equal(f.requests.length, 0);
});

test("native companion verifies app registration before fetching shared-plan quotas, never sends native token", async () => {
  const f = fixture();
  const report = await run("openai", f);
  assert.equal(report.provider, "openai");
  assert.equal(report.windows[0].label, "Shared plan · 5h");
  assert.equal(report.windows[0].usedPercent, 25);
  assert.match(report.notes.join(" "), /separate app allowance/);
  assert.deepEqual(f.requests.map((request) => request.url), [
    "https://chatgpt.com/backend-api/wham/usage/chatpass/apps",
    "https://chatgpt.com/backend-api/wham/usage",
  ]);
  for (const request of f.requests) {
    assert.equal(new Headers(request.init.headers).get("authorization"), "Bearer codex-token");
    assert.equal(new Headers(request.init.headers).get("chatgpt-account-id"), "same-account");
  }
  assert.ok(!JSON.stringify(report).includes("native-token"));
});

test("unrelated or ambiguous companion registrations cannot report another account's quota", async () => {
  const f = fixture({ reply: async () => Response.json({ items: [{ id: "other-app" }] }) });
  const report = await run("openai", f);
  assert.match(report.notes[0], /same ChatGPT account/);
  assert.equal(report.windows.length, 0);
  assert.equal(f.requests.length, 1);
});

test("OpenAI API keys report their limitation without probing subscription endpoints", async () => {
  const f = fixture({ auth: { openai: { auth: { apiKey: "api-key" }, source: "OPENAI_API_KEY" } } });
  const report = await run("openai", f);
  assert.match(report.notes[0], /separate admin key/);
  assert.equal(f.requests.length, 0);
});

test("Codex supports the legacy provider and passes a matching account header", async () => {
  const f = fixture();
  const report = await run("openai-codex", f);
  assert.equal(report.windows[0].usedPercent, 25);
  assert.equal(f.requests.length, 1);
  assert.equal(new Headers(f.requests[0].init.headers).get("chatgpt-account-id"), "same-account");
});

test("custom model and auth origins are rejected before requests", async () => {
  for (const provider of ["opencode-go", "openai", "openai-codex"] as const) {
    for (const f of [
      fixture({ origins: { [provider]: "https://proxy.example/v1" } }),
      fixture({ auth: { [provider]: { source: "OAuth", auth: { apiKey: "token", baseUrl: "https://proxy.example/v1" } } } }),
      fixture({ effective: { [provider]: { apiKey: "token", baseUrl: "https://proxy.example/v1" } } }),
    ]) {
      assert.equal((await run(provider, f)).windows.length, 0);
      assert.equal(f.requests.length, 0);
    }
  }
});

test("effective Authorization overrides, removals, and mismatching stored OAuth fail closed", async () => {
  const overrides: ModelAuth[] = [
    { apiKey: "different-key" },
    { apiKey: "native-token", headers: { authorization: "Bearer other-account" } },
    { apiKey: "native-token", headers: { Authorization: null } },
  ];
  for (const effective of overrides) {
    const f = fixture({ effective: { openai: effective } });
    assert.match((await run("openai", f)).notes[0], /authorization/);
    assert.equal(f.requests.length, 0);
  }
  const f = fixture({ credentials: { openai: oauth("different-token") } });
  assert.match((await run("openai", f)).notes[0], /stored/);
  assert.equal(f.requests.length, 0);
});

test("native app grant and companion account ID must be complete", async () => {
  for (const f of [
    fixture({ credentials: { openai: oauth("native-token") } }),
    fixture({ credentials: { "openai-codex": oauth("codex-token") } }),
  ]) {
    const report = await run("openai", f);
    assert.equal(report.windows.length, 0);
    assert.equal(f.requests.length, 0);
  }
});

test("Codex can derive its account ID from legacy JWT metadata, but rejects conflicting stored IDs", async () => {
  const token = "header." + Buffer.from(JSON.stringify({
    "https://api.openai.com/auth": { chatgpt_account_id: "jwt-account" },
  })).toString("base64url") + ".signature";
  const f = fixture({
    auth: { "openai-codex": { source: "OAuth", auth: { apiKey: token } } },
    credentials: { "openai-codex": oauth(token) },
  });
  assert.equal((await run("openai-codex", f)).windows.length, 1);
  assert.equal(new Headers(f.requests[0].init.headers).get("chatgpt-account-id"), "jwt-account");
  const conflict = fixture({
    auth: { "openai-codex": { source: "OAuth", auth: { apiKey: token } } },
    credentials: { "openai-codex": oauth(token, { accountId: "wrong-account" }) },
  });
  assert.match((await run("openai-codex", conflict)).notes[0], /disagree/);
  assert.equal(conflict.requests.length, 0);
});

test("one failed provider does not hide a successful provider and HTTP errors redact bodies", async () => {
  const f = fixture({ reply: async (url) => url.includes("opencode.ai") ? Response.json(goQuota)
    : new Response("secret-token-and-account-data", { status: 401 }) });
  const reports = await collectUsage(["opencode-go", "openai-codex"], f.ctx, f.deps, new AbortController().signal);
  assert.equal(reports[0].windows[0].usedPercent, 15);
  assert.match(reports[1].notes[0], /HTTP 401/);
  assert.ok(!JSON.stringify(reports).includes("secret-token"));
});

test("network failures, malformed JSON, and oversized bodies become safe report notes", async () => {
  for (const reply of [
    async () => { throw new Error("secret-token in a network diagnostic"); },
    async () => new Response("<html>not a JSON endpoint</html>"),
    async () => new Response("x".repeat(1024 * 1024 + 1)),
  ]) {
    const report = await run("opencode-go", fixture({ reply }));
    assert.equal(report.windows.length, 0);
    assert.ok(!JSON.stringify(report).includes("secret-token"));
    assert.match(report.notes[0], /endpoint|size limit/);
  }
});

test("shutdown cancellation reaches in-flight HTTP requests", async () => {
  const controller = new AbortController();
  const f = fixture({ reply: async (_url, init) => {
    controller.abort();
    init.signal!.throwIfAborted();
    return Response.json(goQuota);
  } });
  assert.match((await run("opencode-go", f, controller.signal)).notes[0], /cancelled/);
});

test("real Pi auth resolver supplies a stored Go key and native OAuth without model calls", async () => {
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("opencode-go", async () => ({ type: "api_key", key: "stored-go" }));
  await credentials.modify("openai", async () => oauth("native-token", {
    clientId: "pi-app", scopes: ["chatgpt.tokens.use.direct"],
  }));
  const runtime = await ModelRuntime.create({
    credentials, modelsPath: null, allowModelNetwork: false, refreshOnCreate: false,
  });
  const registry = new ModelRegistry(runtime);
  const requests: string[] = [];
  const deps: UsageDependencies = {
    readCredential: (provider) => provider === "openai"
      ? oauth("native-token", { clientId: "pi-app", scopes: ["chatgpt.tokens.use.direct"] }) : undefined,
    fetch: (async (_url, init) => {
      requests.push(new Headers(init?.headers).get("authorization")!);
      return Response.json(goQuota);
    }) as typeof fetch,
  };
  const reports = await collectUsage(["opencode-go", "openai"], { model: undefined, modelRegistry: registry }, deps, new AbortController().signal);
  assert.equal(reports[0].windows[0].usedPercent, 15);
  assert.deepEqual(requests, ["Bearer stored-go"]);
  assert.match(reports[1].notes.join(" "), /native ChatGPT OAuth/);
});
