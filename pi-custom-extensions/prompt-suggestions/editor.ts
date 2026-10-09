import { CustomEditor } from "@earendil-works/pi-coding-agent";
import {
  CURSOR_MARKER,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type AutocompleteProvider,
  type EditorComponent,
  type Focusable,
} from "@earendil-works/pi-tui";
import type { SuggestionViewState } from "./contracts.ts";

const SOFTWARE_CURSOR = "\x1b[7m \x1b[0m";

/** Adds ghost text without replacing whichever custom editor is already active. */
export class SuggestionEditor implements EditorComponent, Focusable {
  private submitHandler: ((text: string) => void) | undefined;
  private changeHandler: ((text: string) => void) | undefined;

  constructor(
    private readonly base: EditorComponent,
    private readonly state: SuggestionViewState,
    private readonly dismiss: () => void,
  ) { }

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
