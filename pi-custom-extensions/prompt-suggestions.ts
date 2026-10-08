import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  CustomEditor,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  CURSOR_MARKER,
  matchesKey,
  truncateToWidth,
  type AutocompleteProvider,
  type EditorComponent,
  type Focusable,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { extractTextParts } from "./shared/message-text.ts";

const CONFIG_DIR = join(homedir(), ".pi", "agent");
const CONFIG_PATH = join(CONFIG_DIR, "prompt-suggestions.json");
const STATUS_ID = "prompt-suggestions";

const DEFAULT_CONFIG: SuggestionConfig = {
  enabled: true,
  provider: "opencode-go",
  model: "muse-spark-1.3-contributor",
  ollamaUrl: "http://127.0.0.1:11434",
};

const REQUEST_TIMEOUT_MS = 10_000;
const UNAVAILABLE_DISPLAY_MS = 3_000;
const MAX_CONTEXT_CHARS = 24_000;
const MAX_MESSAGE_CHARS = 4_000;
const MAX_TOOL_RESULT_CHARS = 800;
const MAX_TOOL_ARGS_CHARS = 300;
const MAX_SUGGESTION_CHARS = 240;
// Reasoning models spend output tokens thinking before the visible reply; 256 often ended with no text.
const MAX_RESPONSE_TOKENS = 2048;
const NO_SUGGESTION = "NO_SUGGESTION";
const SOFTWARE_CURSOR = "\x1b[7m \x1b[0m";

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

type Phase = "idle" | "thinking" | "unavailable";

interface SuggestionConfig {
  enabled: boolean;
  provider: string;
  model: string;
  ollamaUrl: string;
}

interface SuggestionViewState {
  enabled: boolean;
  phase: Phase;
  suggestion: string | null;
}

interface OllamaResponse {
  message?: { content?: unknown };
}

/** Adds ghost text without replacing whichever custom editor is already active. */
class SuggestionEditor implements EditorComponent, Focusable {
  private submitHandler: ((text: string) => void) | undefined;
  private changeHandler: ((text: string) => void) | undefined;

  constructor(
    private readonly base: EditorComponent,
    private readonly state: SuggestionViewState,
    private readonly dismiss: () => void,
  ) {}

  get focused(): boolean {
    return isFocusable(this.base) ? this.base.focused : false;
  }

  set focused(value: boolean) {
    if (isFocusable(this.base)) this.base.focused = value;
  }

  // Pi configures these CustomEditor hooks after constructing the component.
  get actionHandlers(): CustomEditor["actionHandlers"] {
    return (this.base as CustomEditor).actionHandlers;
  }

  get onEscape(): CustomEditor["onEscape"] {
    return (this.base as CustomEditor).onEscape;
  }

  set onEscape(handler: CustomEditor["onEscape"]) {
    (this.base as CustomEditor).onEscape = handler;
  }

  get onCtrlD(): CustomEditor["onCtrlD"] {
    return (this.base as CustomEditor).onCtrlD;
  }

  set onCtrlD(handler: CustomEditor["onCtrlD"]) {
    (this.base as CustomEditor).onCtrlD = handler;
  }

  get onPasteImage(): CustomEditor["onPasteImage"] {
    return (this.base as CustomEditor).onPasteImage;
  }

  set onPasteImage(handler: CustomEditor["onPasteImage"]) {
    (this.base as CustomEditor).onPasteImage = handler;
  }

  get onExtensionShortcut(): CustomEditor["onExtensionShortcut"] {
    return (this.base as CustomEditor).onExtensionShortcut;
  }

  set onExtensionShortcut(handler: CustomEditor["onExtensionShortcut"]) {
    (this.base as CustomEditor).onExtensionShortcut = handler;
  }

  get onSubmit(): ((text: string) => void) | undefined {
    return this.submitHandler;
  }

  set onSubmit(handler: ((text: string) => void) | undefined) {
    this.submitHandler = handler;
    this.base.onSubmit = handler;
  }

  get onChange(): ((text: string) => void) | undefined {
    return this.changeHandler;
  }

  set onChange(handler: ((text: string) => void) | undefined) {
    this.changeHandler = handler;
    this.base.onChange = handler;
  }

  handleInput(data: string): void {
    const suggestion = this.state.suggestion;
    if (suggestion && matchesKey(data, "tab")) {
      this.dismiss();
      this.base.setText(suggestion);
      return;
    }
    if (suggestion && matchesKey(data, "escape")) {
      this.dismiss();
      return;
    }

    this.dismiss();
    this.base.handleInput(data);
  }

  setText(text: string): void {
    if (text) this.dismiss();
    this.base.setText(text);
  }

  insertTextAtCursor(text: string): void {
    this.dismiss();
    this.base.insertTextAtCursor?.(text);
  }

  getText(): string {
    return this.base.getText();
  }

  getExpandedText(): string {
    return this.base.getExpandedText?.() ?? this.base.getText();
  }

  addToHistory(text: string): void {
    this.base.addToHistory?.(text);
  }

  setAutocompleteProvider(provider: AutocompleteProvider): void {
    this.base.setAutocompleteProvider?.(provider);
  }

  setPaddingX(padding: number): void {
    this.base.setPaddingX?.(padding);
  }

  setAutocompleteMaxVisible(maxVisible: number): void {
    this.base.setAutocompleteMaxVisible?.(maxVisible);
  }

  get borderColor(): ((text: string) => string) | undefined {
    return this.base.borderColor;
  }

  set borderColor(color: ((text: string) => string) | undefined) {
    this.base.borderColor = color;
  }

  invalidate(): void {
    this.base.invalidate();
  }

  render(width: number): string[] {
    const lines = this.base.render(width);
    const suggestion = this.state.suggestion;
    if (!suggestion || this.base.getText()) return lines;

    const lineIndex = lines.findIndex(
      (line) => line.includes(CURSOR_MARKER) || line.includes(SOFTWARE_CURSOR),
    );
    if (lineIndex < 0) return lines;

    const line = lines[lineIndex]!;
    const hardwareCursor = line.indexOf(CURSOR_MARKER);
    const cursorToken = hardwareCursor >= 0 ? CURSOR_MARKER : SOFTWARE_CURSOR;
    const cursorIndex =
      hardwareCursor >= 0 ? hardwareCursor : line.indexOf(SOFTWARE_CURSOR);
    const before = line.slice(0, cursorIndex);
    const after = line.slice(cursorIndex + cursorToken.length);
    const availableWidth = visibleWidth(after);
    const ghost = truncateToWidth(suggestion, availableWidth, "");

    lines[lineIndex] =
      before +
      cursorToken +
      `\x1b[2m${ghost}\x1b[0m` +
      " ".repeat(Math.max(0, availableWidth - visibleWidth(ghost)));
    return lines;
  }
}

function isFocusable(
  component: EditorComponent,
): component is EditorComponent & Focusable {
  return "focused" in component;
}

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

async function loadConfig(): Promise<SuggestionConfig> {
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

async function saveConfig(config: SuggestionConfig): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

type TranscriptRole = "user" | "assistant" | "tool" | "summary";

interface TranscriptSection {
  role: TranscriptRole;
  text: string;
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.7);
  const tail = max - head;
  const omitted = text.length - max;
  return `${text.slice(0, head)}\n[...${omitted} chars omitted...]\n${text.slice(-tail)}`;
}

function summarizeArguments(args: unknown): string {
  try {
    return clip(JSON.stringify(args ?? {}), MAX_TOOL_ARGS_CHARS);
  } catch {
    return "{}";
  }
}

function transcriptSections(ctx: ExtensionContext): TranscriptSection[] {
  const sections: TranscriptSection[] = [];

  for (const entry of ctx.sessionManager.buildContextEntries()) {
    if (entry.type === "compaction") {
      sections.push({ role: "summary", text: `[EARLIER SUMMARY]\n${entry.summary}` });
      continue;
    }
    if (entry.type === "branch_summary") {
      sections.push({ role: "summary", text: `[BRANCH SUMMARY]\n${entry.summary}` });
      continue;
    }
    if (entry.type !== "message") continue;

    const { message } = entry;

    if (message.role === "user") {
      const text = extractTextParts(message.content).trim();
      if (text) sections.push({ role: "user", text: clip(text, MAX_MESSAGE_CHARS) });
      continue;
    }

    if (message.role === "assistant") {
      // Tool calls carry the actual work (edits, commands), so they must stay visible.
      const parts: string[] = [];
      for (const part of message.content) {
        if (part.type === "text" && part.text.trim()) {
          parts.push(clip(part.text.trim(), MAX_MESSAGE_CHARS));
        } else if (part.type === "toolCall") {
          parts.push(`[called ${part.name} ${summarizeArguments(part.arguments)}]`);
        }
      }
      if (parts.length) sections.push({ role: "assistant", text: parts.join("\n") });
      continue;
    }

    if (message.role === "toolResult") {
      const text = extractTextParts(message.content).trim();
      const status = message.isError ? " (error)" : "";
      sections.push({
        role: "tool",
        text: `[tool ${message.toolName}${status}] ${clip(text || "(no output)", MAX_TOOL_RESULT_CHARS)}`,
      });
      continue;
    }

    if (message.role === "bashExecution" && !message.excludeFromContext) {
      const output = clip(message.output.trim() || "(no output)", MAX_TOOL_RESULT_CHARS);
      sections.push({
        role: "tool",
        text: `[user ran shell] $ ${message.command}\n${output}`,
      });
    }
  }

  return sections;
}

/**
 * Keeps the original request (first user message) and as much recent history
 * as fits. Dropping the oldest turns is safe; dropping the goal is not.
 */
function serializeContext(sections: TranscriptSection[]): string {
  const full = sections.map((section) => section.text).join("\n\n");
  if (full.length <= MAX_CONTEXT_CHARS) return full;

  const note = "[Earlier conversation truncated]";
  const pinnedIndex = sections.findIndex((section) => section.role === "user");
  const kept = new Set<number>();
  let length = note.length;

  if (pinnedIndex >= 0) {
    kept.add(pinnedIndex);
    length += sections[pinnedIndex]!.text.length + 2;
  }

  for (let index = sections.length - 1; index >= 0; index--) {
    if (kept.has(index)) continue;
    const cost = sections[index]!.text.length + 2;
    if (length + cost > MAX_CONTEXT_CHARS) break;
    kept.add(index);
    length += cost;
  }

  const parts: string[] = [];
  let skipped = false;
  for (let index = 0; index < sections.length; index++) {
    if (!kept.has(index)) {
      skipped = true;
      continue;
    }
    if (skipped && parts.length) parts.push("[...]");
    skipped = false;
    parts.push(sections[index]!.text);
  }

  return `${note}\n\n${parts.join("\n\n")}`;
}

function buildUserPrompt(transcript: string): string {
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

function validateSuggestion(
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

async function requestSuggestion(
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

function endsWithCompletedAssistantTurn(ctx: ExtensionContext): boolean {
  const last = ctx.sessionManager
    .buildContextEntries()
    .filter((entry) => entry.type === "message")
    .at(-1);
  if (!last || last.type !== "message") return false;
  const { message } = last;
  return (
    message.role === "assistant" &&
    message.stopReason !== "error" &&
    message.stopReason !== "aborted"
  );
}

function statusText(state: SuggestionViewState): string {
  if (!state.enabled) return "suggestions: off";
  if (state.phase === "thinking") return "suggestions: thinking…";
  if (state.phase === "unavailable") return "suggestions: unavailable";
  if (state.suggestion) return "suggestions: on · Tab accept · Esc dismiss";
  return "suggestions: on";
}

class PromptSuggestions {
  private config: SuggestionConfig = { ...DEFAULT_CONFIG };
  private readonly state: SuggestionViewState = {
    enabled: DEFAULT_CONFIG.enabled,
    phase: "idle",
    suggestion: null,
  };
  private activeContext: ExtensionContext | undefined;
  private request: AbortController | undefined;
  private generation = 0;
  private previousSuggestion: { contextKey: string; text: string } | undefined;
  private unavailableTimer: ReturnType<typeof setTimeout> | undefined;
  private installTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly pi: ExtensionAPI) {}

  register(): void {
    this.pi.registerCommand("suggestions", {
      description: "Toggle follow-up prompt suggestions",
      handler: async (args, ctx) => {
        this.activeContext = ctx;
        const choice = args.trim().toLowerCase();
        if (choice && choice !== "on" && choice !== "off") {
          ctx.ui.notify("Usage: /suggestions [on|off]", "error");
          return;
        }
        await this.setEnabled(
          choice ? choice === "on" : !this.state.enabled,
          ctx,
        );
      },
    });

    this.pi.registerShortcut("shift+left", {
      description: "Toggle follow-up prompt suggestions",
      handler: async (ctx) => {
        this.activeContext = ctx;
        await this.setEnabled(!this.state.enabled, ctx);
      },
    });

    this.pi.on("session_start", async (_event, ctx) => {
      this.activeContext = ctx;
      this.config = await loadConfig();
      this.patchState({
        enabled: this.config.enabled,
        phase: "idle",
        suggestion: null,
      });
      this.installEditor(ctx);
    });

    this.pi.on("agent_start", async (_event, ctx) => {
      this.activeContext = ctx;
      this.cancelRequest();
      this.patchState({ suggestion: null });
    });

    this.pi.on("agent_settled", async (_event, ctx) => {
      this.activeContext = ctx;
      void this.generate(ctx);
    });

    this.pi.on("session_shutdown", async () => this.shutdown());
  }

  private patchState(patch: Partial<SuggestionViewState>): void {
    Object.assign(this.state, patch);
    const ctx = this.activeContext;
    if (!ctx) return;
    ctx.ui.setStatus(STATUS_ID, statusText(this.state));
  }

  private clearUnavailableTimer(): void {
    if (this.unavailableTimer) clearTimeout(this.unavailableTimer);
    this.unavailableTimer = undefined;
  }

  private cancelRequest(): void {
    this.generation++;
    this.request?.abort();
    this.request = undefined;
    this.clearUnavailableTimer();
    if (this.state.phase !== "idle") this.patchState({ phase: "idle" });
  }

  private dismiss = (): void => {
    this.cancelRequest();
    if (this.state.suggestion) this.patchState({ suggestion: null });
  };

  private installEditor(ctx: ExtensionContext): void {
    if (ctx.mode !== "tui") return;
    if (this.installTimer) clearTimeout(this.installTimer);

    // Run after other session_start handlers so this composes with editors such as pi-vim.
    this.installTimer = setTimeout(() => {
      this.installTimer = undefined;
      const previous = ctx.ui.getEditorComponent();
      ctx.ui.setEditorComponent((tui, theme, keybindings) => {
        const base =
          previous?.(tui, theme, keybindings) ??
          new CustomEditor(tui, theme, keybindings);
        return new SuggestionEditor(base, this.state, this.dismiss);
      });
    }, 0);
  }

  private async generate(ctx: ExtensionContext): Promise<void> {
    if (
      !this.state.enabled ||
      ctx.mode !== "tui" ||
      !ctx.isIdle() ||
      ctx.ui.getEditorText()
    ) {
      return;
    }

    if (!endsWithCompletedAssistantTurn(ctx)) return;

    const transcript = serializeContext(transcriptSections(ctx));
    if (!transcript) return;
    const prompt = buildUserPrompt(transcript);

    this.cancelRequest();
    const controller = new AbortController();
    const generation = this.generation;
    const contextKey = ctx.sessionManager.getLeafId() ?? transcript;
    this.request = controller;
    this.patchState({ phase: "thinking", suggestion: null });

    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const raw = await requestSuggestion(
        this.config,
        prompt,
        controller.signal,
        ctx,
      );
      if (
        generation !== this.generation ||
        controller.signal.aborted ||
        !this.state.enabled ||
        ctx.ui.getEditorText()
      ) {
        return;
      }

      const previous =
        this.previousSuggestion?.contextKey === contextKey
          ? this.previousSuggestion.text
          : null;
      const suggestion = validateSuggestion(raw, previous);
      if (suggestion)
        this.previousSuggestion = { contextKey, text: suggestion };
      this.patchState({ phase: "idle", suggestion });
    } catch {
      // A generation change means user input or lifecycle cleanup intentionally cancelled it.
      if (generation !== this.generation) return;
      this.patchState({ phase: "unavailable", suggestion: null });
      this.clearUnavailableTimer();
      this.unavailableTimer = setTimeout(() => {
        if (this.state.enabled) this.patchState({ phase: "idle" });
      }, UNAVAILABLE_DISPLAY_MS);
    } finally {
      clearTimeout(timeout);
      if (this.request === controller) this.request = undefined;
    }
  }

  private async setEnabled(
    enabled: boolean,
    ctx: ExtensionContext,
  ): Promise<void> {
    const changed = enabled !== this.state.enabled;
    this.config = { ...this.config, enabled };
    this.cancelRequest();
    this.patchState({ enabled, suggestion: null });

    try {
      await saveConfig(this.config);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(
        `Could not save prompt suggestion preference: ${message}`,
        "error",
      );
    }

    if (
      enabled &&
      changed &&
      ctx.mode === "tui" &&
      ctx.isIdle() &&
      !ctx.ui.getEditorText()
    ) {
      void this.generate(ctx);
    }
  }

  private shutdown(): void {
    if (this.installTimer) clearTimeout(this.installTimer);
    this.installTimer = undefined;
    this.cancelRequest();
    this.state.suggestion = null;
    this.activeContext = undefined;
  }
}

export default function promptSuggestionsExtension(pi: ExtensionAPI): void {
  new PromptSuggestions(pi).register();
}
