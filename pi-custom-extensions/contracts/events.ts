export const REASONING_TOKENS_LIVE_EVENT = "reasoning-tokens:live";

export interface ReasoningTokensLivePayload {
  tokens: number;
}

export function isReasoningTokensLivePayload(value: unknown): value is ReasoningTokensLivePayload {
  return typeof value === "object" && value !== null && "tokens" in value &&
    typeof value.tokens === "number" && Number.isFinite(value.tokens);
}
