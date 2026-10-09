import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG, loadConfig, saveConfig } from "./config.ts";
import { endsWithCompletedAssistantTurn, serializeContext, transcriptSections } from "./context.ts";
import type { SuggestionConfig, SuggestionViewState } from "./contracts.ts";
import { SuggestionEditor } from "./editor.ts";
import { buildUserPrompt, requestSuggestion, validateSuggestion } from "./generation.ts";

const STATUS_ID = "prompt-suggestions";

const REQUEST_TIMEOUT_MS = 10_000;

const UNAVAILABLE_DISPLAY_MS = 3_000;

function statusText(state: SuggestionViewState, theme: ExtensionContext["ui"]["theme"]): string {
  const prefix = theme.fg("dim", "suggestions:");
  let body: string;
  if (!state.enabled) body = "off";
  else if (state.phase === "thinking") body = "thinking…";
  else if (state.phase === "unavailable") body = "unavailable";
  else if (state.suggestion) body = "on · Tab accept · Esc dismiss";
  else body = "on";
  return prefix + theme.fg("muted", ` ${body}`);
}

export class PromptSuggestions {
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

  constructor(private readonly pi: ExtensionAPI) { }

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
    ctx.ui.setStatus(STATUS_ID, statusText(this.state, ctx.ui.theme));
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
