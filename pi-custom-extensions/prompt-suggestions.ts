import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  CustomEditor,
  type ExtensionAPI,
  type ExtensionContext,
  type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  CURSOR_MARKER,
  matchesKey,
  truncateToWidth,
  type AutocompleteProvider,
  type EditorComponent,
  type EditorTheme,
  type Focusable,
  type TUI,
  visibleWidth,
} from "@earendil-works/pi-tui";

const CONFIG_PATH = join(homedir(), ".pi", "agent", "prompt-suggestions.json");
const STATUS_ID = "prompt-suggestions";
const DEFAULT_MODEL = "gemma4:e2b";
const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_CONTEXT_CHARS = 16_000;
const MAX_SUGGESTION_CHARS = 240;
const NO_SUGGESTION = "NO_SUGGESTION";
const CURSOR_SPACE = "\x1b[7m \x1b[0m";

const SUGGESTION_SYSTEM_PROMPT = `You suggest one useful next-step follow-up prompt for an ongoing conversation.

Rules:
- Ground the suggestion in the conversation.
- Prefer an actionable next step such as verification, testing, explanation, or refinement.
- Return exactly one complete prompt as plain text.
- Return one concise sentence, normally 10-30 words.
- Do not use Markdown, quotes, labels, or explanations.
- If there is no meaningful follow-up, return exactly ${NO_SUGGESTION}.`;

interface SuggestionConfig {
  enabled: boolean;
  model: string;
  ollamaUrl: string;
}

const DEFAULT_CONFIG: SuggestionConfig = {
  enabled: true,
  model: DEFAULT_MODEL,
  ollamaUrl: DEFAULT_OLLAMA_URL,
};

interface OllamaResponse {
  message?: {
    content?: unknown;
  };
}

class SuggestionState {
  enabled = true;
  suggestion: string | null = null;
  phase: "idle" | "thinking" | "unavailable" = "idle";
  private readonly listeners = new Set<() => void>();

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.suggestion = null;
    this.notify();
  }

  setSuggestion(suggestion: string | null): void {
    this.suggestion = suggestion;
    this.notify();
  }

  setPhase(phase: SuggestionState["phase"]): void {
    this.phase = phase;
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

class SuggestionEditor implements EditorComponent, Focusable {
  private submitHandler: ((text: string) => void) | undefined;
  private changeHandler: ((text: string) => void) | undefined;

  constructor(
    private readonly base: EditorComponent,
    private readonly tui: TUI,
    private readonly suggestionState: SuggestionState,
    private readonly onUserInput: () => void,
  ) {
    suggestionState.subscribe(() => tui.requestRender());
  }

  get focused(): boolean {
    return "focused" in this.base
      ? (this.base as EditorComponent & Focusable).focused
      : false;
  }

  set focused(value: boolean) {
    if ("focused" in this.base) {
      (this.base as EditorComponent & Focusable).focused = value;
    }
  }

  get actionHandlers(): Map<string, () => void> {
    return (this.base as CustomEditor).actionHandlers;
  }

  get onEscape(): (() => void) | undefined {
    return (this.base as CustomEditor).onEscape;
  }

  set onEscape(handler: (() => void) | undefined) {
    (this.base as CustomEditor).onEscape = handler;
  }

  get onCtrlD(): (() => void) | undefined {
    return (this.base as CustomEditor).onCtrlD;
  }

  set onCtrlD(handler: (() => void) | undefined) {
    (this.base as CustomEditor).onCtrlD = handler;
  }

  get onPasteImage(): (() => void) | undefined {
    return (this.base as CustomEditor).onPasteImage;
  }

  set onPasteImage(handler: (() => void) | undefined) {
    (this.base as CustomEditor).onPasteImage = handler;
  }

  get onExtensionShortcut(): ((data: string) => boolean) | undefined {
    return (this.base as CustomEditor).onExtensionShortcut;
  }

  set onExtensionShortcut(handler: ((data: string) => boolean) | undefined) {
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
    if (this.suggestionState.suggestion && matchesKey(data, "tab")) {
      const suggestion = this.suggestionState.suggestion;
      this.suggestionState.setSuggestion(null);
      this.onUserInput();
      this.base.setText(suggestion);
      return;
    }

    if (this.suggestionState.suggestion && matchesKey(data, "escape")) {
      this.suggestionState.setSuggestion(null);
      this.onUserInput();
      return;
    }

    this.onUserInput();
    this.base.handleInput(data);
  }

  setText(text: string): void {
    if (text.length > 0) {
      this.suggestionState.setSuggestion(null);
      this.onUserInput();
    }
    this.base.setText(text);
  }

  insertTextAtCursor(text: string): void {
    this.suggestionState.setSuggestion(null);
    this.onUserInput();
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

  set borderColor(colorizer: ((text: string) => string) | undefined) {
    this.base.borderColor = colorizer;
  }

  invalidate(): void {
    this.base.invalidate();
  }

  render(width: number): string[] {
    const lines = this.base.render(width);
    const suggestion = this.suggestionState.suggestion;
    if (!suggestion || this.getText().length > 0) return lines;

    const lineIndex = lines.findIndex(
      (line) => line.includes(CURSOR_MARKER) || line.includes(CURSOR_SPACE),
    );
    if (lineIndex < 0) return lines;

    const line = lines[lineIndex]!;
    const hardwareCursorIndex = line.indexOf(CURSOR_MARKER);
    const softwareCursorIndex = line.indexOf(CURSOR_SPACE);
    const useHardwareCursor = hardwareCursorIndex >= 0;
    const cursorIndex = useHardwareCursor
      ? hardwareCursorIndex
      : softwareCursorIndex;
    const cursorToken = useHardwareCursor ? CURSOR_MARKER : CURSOR_SPACE;
    const before = line.slice(0, cursorIndex);
    const after = line.slice(cursorIndex + cursorToken.length);
    const availableWidth = visibleWidth(after);
    const ghost = truncateToWidth(suggestion, availableWidth, "");
    const ghostWidth = visibleWidth(ghost);

    lines[lineIndex] =
      before +
      cursorToken +
      `\x1b[2m${ghost}\x1b[0m` +
      " ".repeat(Math.max(0, availableWidth - ghostWidth));
    return lines;
  }
}

function normalizeUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function parseConfig(raw: unknown): Partial<SuggestionConfig> {
  if (!raw || typeof raw !== "object") return {};
  const value = raw as Record<string, unknown>;
  return {
    enabled: typeof value.enabled === "boolean" ? value.enabled : undefined,
    model: isNonEmptyString(value.model) ? value.model.trim() : undefined,
    ollamaUrl: isNonEmptyString(value.ollamaUrl)
      ? normalizeUrl(value.ollamaUrl.trim())
      : undefined,
  };
}

async function readLocalConfig(): Promise<Partial<SuggestionConfig>> {
  try {
    const text = await readFile(CONFIG_PATH, "utf8");
    return parseConfig(JSON.parse(text));
  } catch {
    return {};
  }
}

async function loadConfig(): Promise<SuggestionConfig> {
  const local = await readLocalConfig();
  return {
    enabled: local.enabled ?? DEFAULT_CONFIG.enabled,
    model:
      process.env.PI_SUGGESTIONS_MODEL?.trim() ||
      local.model ||
      DEFAULT_CONFIG.model,
    ollamaUrl: normalizeUrl(
      process.env.PI_SUGGESTIONS_OLLAMA_URL?.trim() ||
        local.ollamaUrl ||
        DEFAULT_CONFIG.ollamaUrl,
    ),
  };
}

async function saveEnabled(enabled: boolean): Promise<void> {
  const local = await readLocalConfig();
  const config: SuggestionConfig = {
    enabled,
    model: local.model || DEFAULT_CONFIG.model,
    ollamaUrl: local.ollamaUrl || DEFAULT_CONFIG.ollamaUrl,
  };
  await mkdir(join(homedir(), ".pi", "agent"), { recursive: true });
  await writeFile(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .filter((part): part is { type: "text"; text: string } => {
      return (
        !!part &&
        typeof part === "object" &&
        (part as { type?: unknown }).type === "text" &&
        typeof (part as { text?: unknown }).text === "string"
      );
    })
    .map((part) => part.text)
    .join("\n");
}

function serializeContext(ctx: ExtensionContext): string {
  const entries = ctx.sessionManager.buildContextEntries();
  const sections: string[] = [];

  for (const entry of entries) {
    if (entry.type === "compaction") {
      sections.push(`[COMPACTION SUMMARY]\n${entry.summary}`);
      continue;
    }
    if (entry.type === "branch_summary") {
      sections.push(`[BRANCH SUMMARY]\n${entry.summary}`);
      continue;
    }
    if (entry.type !== "message") continue;

    const message = entry.message;
    if (
      message.role !== "user" &&
      message.role !== "assistant" &&
      message.role !== "toolResult"
    ) {
      continue;
    }

    const text = contentText(message.content).trim();
    if (!text) continue;

    const role =
      message.role === "toolResult" ? "TOOL RESULT" : message.role.toUpperCase();
    sections.push(`[${role}]\n${text}`);
  }

  const full = sections.join("\n\n");
  if (full.length <= MAX_CONTEXT_CHARS) return full;

  const truncationNote = "[Earlier context truncated]\n";
  return truncationNote + full.slice(-(MAX_CONTEXT_CHARS - truncationNote.length));
}

function validateSuggestion(raw: unknown, previous: string | null): string | null {
  if (typeof raw !== "string") return null;
  const suggestion = raw.trim();
  if (!suggestion || suggestion.toUpperCase() === NO_SUGGESTION) return null;
  if (suggestion.length > MAX_SUGGESTION_CHARS) return null;
  if (/```|^suggestion\s*:/i.test(suggestion)) return null;
  if (/^(?:[-*•]\s+|\d+[.)]\s+)/.test(suggestion)) return null;
  if (/^(?:".*"|'.*'|`.*`)$/.test(suggestion)) return null;
  if (/[\r\n\x00-\x1f\x7f\u001b]/.test(suggestion)) return null;
  if (suggestion === previous) return null;
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

  if (!response.ok) {
    throw new Error(`Ollama returned HTTP ${response.status}`);
  }

  const payload = (await response.json()) as OllamaResponse;
  return typeof payload.message?.content === "string"
    ? payload.message.content
    : null;
}

function statusText(state: SuggestionState): string {
  if (!state.enabled) return "suggestions: off";
  if (state.phase === "thinking") return "suggestions: thinking…";
  if (state.phase === "unavailable") return "suggestions: unavailable";
  if (state.suggestion) return "suggestions: on · Tab accept · Esc dismiss";
  return "suggestions: on";
}

export default function promptSuggestionsExtension(pi: ExtensionAPI) {
  const state = new SuggestionState();
  let config: SuggestionConfig = { ...DEFAULT_CONFIG };
  let requestController: AbortController | undefined;
  let requestGeneration = 0;
  let lastSuggestion: { text: string; contextKey: string } | null = null;
  let unavailableTimer: ReturnType<typeof setTimeout> | undefined;
  let editorInstallTimer: ReturnType<typeof setTimeout> | undefined;
  let activeContext: ExtensionContext | undefined;

  function updateStatus(ctx: ExtensionContext): void {
    ctx.ui.setStatus(STATUS_ID, statusText(state));
  }

  function clearUnavailableTimer(): void {
    if (unavailableTimer) clearTimeout(unavailableTimer);
    unavailableTimer = undefined;
  }

  function cancelRequest(ctx?: ExtensionContext): void {
    requestGeneration++;
    requestController?.abort();
    requestController = undefined;
    clearUnavailableTimer();
    state.setPhase("idle");
    if (ctx) updateStatus(ctx);
  }

  function cancelForEditorInput(): void {
    cancelRequest(activeContext);
    if (state.suggestion) state.setSuggestion(null);
  }

  function installEditor(ctx: ExtensionContext): void {
    if (ctx.mode !== "tui") return;
    if (editorInstallTimer) clearTimeout(editorInstallTimer);

    // pi-vim also installs a custom editor during session_start. Install on
    // the next task so we wrap whichever editor the other extensions chose.
    editorInstallTimer = setTimeout(() => {
      editorInstallTimer = undefined;
      const previous = ctx.ui.getEditorComponent();
      ctx.ui.setEditorComponent((tui, theme, keybindings) => {
        const base =
          previous?.(tui, theme, keybindings) ??
          new CustomEditor(tui, theme, keybindings);
        return new SuggestionEditor(
          base,
          tui,
          state,
          cancelForEditorInput,
        );
      });
    }, 0);
  }

  async function generateSuggestion(ctx: ExtensionContext): Promise<void> {
    if (
      !state.enabled ||
      ctx.mode !== "tui" ||
      ctx.ui.getEditorText().length > 0 ||
      !ctx.isIdle()
    ) {
      return;
    }

    const context = serializeContext(ctx);
    if (!context) return;

    const contextKey = ctx.sessionManager.getLeafId() ?? context;
    cancelRequest(ctx);
    const controller = new AbortController();
    requestController = controller;
    const generation = requestGeneration;
    state.setPhase("thinking");
    updateStatus(ctx);

    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const raw = await requestOllama(config, context, controller.signal);
      if (
        generation !== requestGeneration ||
        controller.signal.aborted ||
        !state.enabled ||
        ctx.ui.getEditorText().length > 0
      ) {
        return;
      }

      const previousSuggestion = lastSuggestion;
      const previous =
        previousSuggestion?.contextKey === contextKey
          ? previousSuggestion.text
          : null;
      const suggestion = validateSuggestion(raw, previous);
      if (suggestion) {
        lastSuggestion = { text: suggestion, contextKey };
        state.setSuggestion(suggestion);
      }
      state.setPhase("idle");
      updateStatus(ctx);
    } catch (error) {
      if (generation !== requestGeneration || controller.signal.aborted) return;
      state.setPhase("unavailable");
      updateStatus(ctx);
      clearUnavailableTimer();
      unavailableTimer = setTimeout(() => {
        if (state.enabled) {
          state.setPhase("idle");
          updateStatus(ctx);
        }
      }, 3000);
      void error;
    } finally {
      clearTimeout(timeout);
      if (requestController === controller) requestController = undefined;
    }
  }

  async function setEnabled(enabled: boolean, ctx: ExtensionContext): Promise<void> {
    const wasEnabled = state.enabled;
    config.enabled = enabled;
    state.setEnabled(enabled);
    cancelRequest(ctx);
    updateStatus(ctx);

    try {
      await saveEnabled(enabled);
    } catch (error) {
      ctx.ui.notify(
        `Could not save prompt suggestion preference: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "error",
      );
    }

    if (
      enabled &&
      !wasEnabled &&
      ctx.mode === "tui" &&
      ctx.isIdle() &&
      ctx.ui.getEditorText().length === 0
    ) {
      void generateSuggestion(ctx);
    }
  }

  pi.registerCommand("suggestions", {
    description: "Toggle follow-up prompt suggestions",
    handler: async (args, ctx) => {
      activeContext = ctx;
      const choice = args.trim().toLowerCase();
      if (choice && choice !== "on" && choice !== "off") {
        ctx.ui.notify("Usage: /suggestions [on|off]", "error");
        return;
      }
      const enabled = choice === "on" ? true : choice === "off" ? false : !state.enabled;
      await setEnabled(enabled, ctx);
    },
  });

  pi.registerShortcut("shift+left", {
    description: "Toggle follow-up prompt suggestions",
    handler: async (ctx) => {
      activeContext = ctx;
      await setEnabled(!state.enabled, ctx);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    activeContext = ctx;
    config = await loadConfig();
    state.setEnabled(config.enabled);
    state.setPhase("idle");
    installEditor(ctx);
    updateStatus(ctx);
  });

  pi.on("agent_start", async (_event, ctx) => {
    activeContext = ctx;
    cancelRequest(ctx);
    state.setSuggestion(null);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    activeContext = ctx;
    void generateSuggestion(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (editorInstallTimer) clearTimeout(editorInstallTimer);
    editorInstallTimer = undefined;
    cancelRequest(ctx);
    state.setSuggestion(null);
    clearUnavailableTimer();
    activeContext = undefined;
  });
}
