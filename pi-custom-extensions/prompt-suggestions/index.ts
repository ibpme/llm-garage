import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PromptSuggestions } from "./controller.ts";

export default function promptSuggestionsExtension(pi: ExtensionAPI): void {
  new PromptSuggestions(pi).register();
}
