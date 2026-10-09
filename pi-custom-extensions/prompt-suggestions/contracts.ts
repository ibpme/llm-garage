

type Phase = "idle" | "thinking" | "unavailable";

export interface SuggestionConfig {
  enabled: boolean;
  provider: string;
  model: string;
  ollamaUrl: string;
}

export interface SuggestionViewState {
  enabled: boolean;
  phase: Phase;
  suggestion: string | null;
}
