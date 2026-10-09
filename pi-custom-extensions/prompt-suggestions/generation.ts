import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SuggestionConfig } from "./contracts.ts";

const MAX_SUGGESTION_CHARS = 240;

// Reasoning models spend output tokens thinking before the visible reply; 256 often ended with no text.
const MAX_RESPONSE_TOKENS = 2048;

const NO_SUGGESTION = "NO_SUGGESTION";

const SUGGESTION_SYSTEM_PROMPT = `You predict the next message a user will type to a coding assistant.

Rules:
- Write in the USER's voice, addressed to the assistant (e.g. "Run the tests and fix any failures."). Never write the assistant's reply or an offer such as "Would you like me to...".
- Ground the message in the latest state of the conversation: what was just done, what failed, what is still open.
- If the assistant asked the user a question, answer it the way the user most likely would.
- If the assistant reported an error, ask to fix or investigate that specific error.
- If the task looks complete, suggest a verification step (test, review, explain, or commit) rather than new work.
- Be specific: name files, functions, errors, or commands from the conversation. Avoid generic phrases like "looks good" or "thanks".
- Return exactly one message as plain text, one sentence, normally 8-30 words.
- Do not use Markdown, quotes, bullets, labels, or explanations.
- If there is no meaningful next message, return exactly ${NO_SUGGESTION}.`;

interface OllamaResponse {
  message?: { content?: unknown };
}

export function buildUserPrompt(transcript: string): string {
  return `<conversation>
${transcript}
</conversation>

Write the single message the USER would most likely send to the assistant next. Output only that message, or ${NO_SUGGESTION}.`;
}

/**
 * Repairs harmless formatting noise (labels, bullets, wrapping quotes) instead
 * of discarding an otherwise good suggestion.
 */
function cleanSuggestion(raw: string): string {
  let text = raw.trim();
  text = text.replace(/^```[a-z]*\s*|\s*```$/gi, "");
  text = text.replace(
    /^(?:suggested\s+(?:next\s+)?(?:prompt|message)|next\s+(?:prompt|message)|suggestion|prompt|message)\s*:\s*/i,
    "",
  );
  text = text.replace(/^(?:[-*•]\s+|\d+[.)]\s+)/, "");
  text = text.replace(/\s+/g, " ").trim();

  let previous: string;
  do {
    previous = text;
    const pair = text.match(/^(["'`\u201c\u2018])(.*)(["'`\u201d\u2019])$/);
    if (pair) text = pair[2]!.trim();
  } while (text !== previous);

  return text;
}

export function validateSuggestion(
  raw: unknown,
  previous: string | null,
): string | null {
  if (typeof raw !== "string") return null;
  const suggestion = cleanSuggestion(raw);

  if (!suggestion || suggestion.toUpperCase().includes(NO_SUGGESTION)) return null;
  if (suggestion.length > MAX_SUGGESTION_CHARS || suggestion === previous) return null;
  if (/[\x00-\x1f\x7f\u001b]/.test(suggestion)) return null;
  if (/^suggest/i.test(suggestion) || /:\s*$/.test(suggestion)) return null;
  // Assistant-voiced offers ("Would you like me to...") are not prompts the user would send.
  if (
    /^(?:would you like|do you want me|shall i|should i|let me know|i can|i'll|i will|i would)\b/i.test(
      suggestion,
    )
  ) {
    return null;
  }

  return suggestion;
}

async function requestOllama(
  config: SuggestionConfig,
  context: string,
  signal: AbortSignal,
): Promise<string | null> {
  const response = await fetch(`${config.ollamaUrl}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: config.model,
      stream: false,
      think: false,
      options: { temperature: 0.3, num_predict: 80 },
      messages: [
        { role: "system", content: SUGGESTION_SYSTEM_PROMPT },
        { role: "user", content: context },
      ],
    }),
    signal,
  });

  if (!response.ok) throw new Error(`Ollama returned HTTP ${response.status}`);

  const payload = (await response.json()) as OllamaResponse;
  return typeof payload.message?.content === "string"
    ? payload.message.content
    : null;
}

export async function requestSuggestion(
  config: SuggestionConfig,
  context: string,
  signal: AbortSignal,
  ctx: ExtensionContext,
): Promise<string | null> {
  if (config.provider === "ollama") {
    return requestOllama(config, context, signal);
  }

  const model = ctx.modelRegistry.find(config.provider, config.model);
  if (!model)
    throw new Error(`Model ${config.provider}/${config.model} was not found`);
  if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
    throw new Error(
      `No authentication configured for ${config.provider}/${config.model}`,
    );
  }

  const response = await ctx.modelRegistry.complete(
    model,
    {
      systemPrompt: SUGGESTION_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: context }],
          timestamp: Date.now(),
        },
      ],
    },
    {
      temperature: 0.3,
      maxTokens: MAX_RESPONSE_TOKENS,
      reasoningEffort: "minimal",
      cacheRetention: "none",
      sessionId: ctx.sessionManager.getSessionId(),
      transformHeaders: (headers) =>
        model.provider === "opencode" || model.provider === "opencode-go"
          ? {
            ...headers,
            "x-opencode-session": ctx.sessionManager.getSessionId(),
            "x-opencode-client": "pi",
          }
          : headers,
      signal,
    },
  );

  if (response.stopReason === "error") {
    throw new Error(response.errorMessage ?? "Suggestion request failed");
  }
  if (response.stopReason === "length") {
    throw new Error("Suggestion model ran out of output tokens");
  }

  return response.content
    .filter(
      (part): part is { type: "text"; text: string } => part.type === "text",
    )
    .map((part) => part.text)
    .join("");
}
