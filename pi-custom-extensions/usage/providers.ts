export type UsageProvider = "opencode-go" | "openai" | "openai-codex";

export interface UsageWindow {
  label: string;
  usedPercent?: number;
  resetsAt?: number;
  status?: "rate-limited";
  note?: string;
}

export interface UsageReport {
  provider: UsageProvider;
  title: string;
  plan?: string;
  windows: UsageWindow[];
  notes: string[];
}

export const PROVIDERS: readonly UsageProvider[] = ["opencode-go", "openai", "openai-codex"];
export const TITLES: Record<UsageProvider, string> = {
  "opencode-go": "OpenCode Go",
  openai: "OpenAI · ChatGPT",
  "openai-codex": "OpenAI Codex",
};
export const CHATGPT_USAGE_URL = "https://chatgpt.com/settings/usage";

export class UsageError extends Error {}

export function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

export function safeText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  // Provider text is untrusted terminal input, including OSC hyperlinks and bidi controls.
  return value.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "").slice(0, 100);
}

function percent(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100
    ? value : undefined;
}

function epochSeconds(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 8.64e12
    ? value * 1000 : undefined;
}

export function parseOpenCodeGo(payload: unknown): UsageReport {
  const usage = record(record(payload)?.usage);
  if (!usage) throw new UsageError("OpenCode Go returned an unrecognized usage response.");
  const labels = { rolling: "Rolling (5h)", weekly: "Weekly", monthly: "Monthly" };
  const windows = Object.entries(labels).map(([key, label]): UsageWindow => {
    const row = record(usage[key]);
    if (!row || (row.status !== "ok" && row.status !== "rate-limited")) {
      return { label, note: "Usage unavailable (missing or unknown window status)." };
    }
    const usedPercent = percent(row.percent);
    const resetsAt = typeof row.resetsAt === "string" ? Date.parse(row.resetsAt) : NaN;
    return {
      label,
      usedPercent,
      resetsAt: Number.isFinite(resetsAt) ? resetsAt : undefined,
      status: row.status === "rate-limited" ? "rate-limited" : undefined,
      note: usedPercent === undefined ? "Usage percentage unavailable." : undefined,
    };
  });
  return { provider: "opencode-go", title: TITLES["opencode-go"], windows, notes: [] };
}

export function windowDuration(seconds: unknown, fallback: string): string {
  if (typeof seconds !== "number" || !Number.isSafeInteger(seconds) || seconds <= 0) return fallback;
  if (seconds % 86400 === 0) return `${seconds / 86400}d`;
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

function codexWindow(value: unknown, fallback: string): UsageWindow | undefined {
  if (value === undefined || value === null) return undefined;
  const row = record(value);
  return {
    label: windowDuration(row?.limit_window_seconds, fallback),
    usedPercent: percent(row?.used_percent),
    resetsAt: epochSeconds(row?.reset_at),
    note: percent(row?.used_percent) === undefined ? "Usage percentage unavailable." : undefined,
  };
}

export function parseCodex(payload: unknown): UsageReport {
  const data = record(payload);
  const limit = record(data?.rate_limit);
  const windows: UsageWindow[] = [];
  const addWindows = (bucket: Record<string, unknown> | undefined, prefix = "") => {
    for (const [key, fallback] of [["primary_window", "Primary"], ["secondary_window", "Secondary"]]) {
      const window = codexWindow(bucket?.[key], fallback);
      if (window) windows.push({ ...window, label: prefix + window.label });
    }
  };
  addWindows(limit);
  addWindows(record(data?.code_review_rate_limit), "Code review · ");
  if (!limit || windows.length === 0) throw new UsageError("OpenAI returned no recognizable quota windows.");
  const notes: string[] = [];
  if (limit.limit_reached === true || limit.allowed === false) notes.push("The service reports that the plan limit is reached or usage is not allowed.");
  const credits = record(data?.credits);
  if (credits?.unlimited === true) notes.push("Credits: unlimited.");
  else if (typeof credits?.balance === "string" || typeof credits?.balance === "number") {
    const balance = safeText(String(credits.balance));
    if (balance && /^-?\d+(\.\d+)?$/.test(balance)) notes.push(`Credits balance: ${balance} (as reported by OpenAI).`);
  }
  return {
    provider: "openai-codex", title: TITLES["openai-codex"], plan: safeText(data?.plan_type), windows, notes,
  };
}

export function verifyAppRegistration(payload: unknown, clientId: string): void {
  const data = record(payload);
  const items = data?.items;
  // Only a complete, unpaginated app list can establish a unique registration match.
  if (!data || Object.keys(data).some((key) => key !== "items") || !Array.isArray(items) || items.length > 128 ||
    items.some((item) => typeof record(item)?.id !== "string" || !(record(item)?.id as string).trim()) ||
    items.filter((item) => record(item)?.id === clientId).length !== 1) {
    throw new UsageError("The Codex account does not have a unique matching Pi app registration. Sign in to the same ChatGPT account/workspace for both providers.");
  }
}
