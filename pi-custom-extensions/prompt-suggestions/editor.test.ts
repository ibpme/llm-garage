import assert from "node:assert/strict";
import { test } from "node:test";
import { CURSOR_MARKER, type EditorComponent } from "@earendil-works/pi-tui";
import { SuggestionEditor } from "./editor.ts";
import type { SuggestionViewState } from "./contracts.ts";

function fixture() {
  let text = "";
  const inputs: string[] = [];
  const base: EditorComponent = {
    getText: () => text,
    setText: (value) => { text = value; },
    insertTextAtCursor: (value) => { text += value; },
    handleInput: (data) => { inputs.push(data); },
    render: () => [CURSOR_MARKER + " ".repeat(60)],
    invalidate: () => {},
  };
  const state: SuggestionViewState = { enabled: true, phase: "idle", suggestion: "Explain the changes" };
  return { editor: new SuggestionEditor(base, state), state, inputs };
}

test("Escape and ignored input preserve the suggestion and reach the base editor", () => {
  const { editor, state, inputs } = fixture();
  for (const key of ["\x1b", "x", "\x03"]) editor.handleInput(key);
  assert.deepEqual(inputs, ["\x1b", "x", "\x03"]);
  assert.equal(state.suggestion, "Explain the changes");
  assert.match(editor.render(80).join(""), /Explain the changes/);
});

test("drafts hide suggestions without discarding them or letting Tab overwrite them", () => {
  const { editor, state, inputs } = fixture();
  editor.setText("My draft");
  editor.insertTextAtCursor("!");
  editor.handleInput("\t");
  assert.deepEqual(inputs, ["\t"]);
  assert.equal(editor.getText(), "My draft!");
  assert.doesNotMatch(editor.render(80).join(""), /Explain the changes/);
  editor.setText("");
  assert.match(editor.render(80).join(""), /Explain the changes/);
  editor.handleInput("\t");
  assert.equal(editor.getText(), state.suggestion);
  editor.setText("");
  assert.match(editor.render(80).join(""), /Explain the changes/);
});

test("disabled suggestions are neither displayed nor accepted", () => {
  const { editor, state, inputs } = fixture();
  state.enabled = false;
  editor.handleInput("\t");
  assert.deepEqual(inputs, ["\t"]);
  assert.equal(editor.getText(), "");
  assert.doesNotMatch(editor.render(80).join(""), /Explain the changes/);
});
