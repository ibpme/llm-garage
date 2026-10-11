import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import extension from "./stash.ts";

function setup() {
  let draft = "";
  let toggle!: (ctx: ExtensionContext) => void;
  const events = new Map<string, (event: any, ctx: ExtensionContext) => void>();
  extension({
    registerShortcut(_key, options) { toggle = options.handler as typeof toggle; },
    on(name, handler) { events.set(name, handler as any); },
  } as ExtensionAPI);
  const ctx = {
    mode: "tui",
    ui: {
      getEditorText: () => draft,
      setEditorText: (text: string) => { draft = text; },
      setStatus: () => { assert.fail("Stash must not add a statusline indicator"); },
      notify: () => {},
    },
  } as unknown as ExtensionContext;
  return {
    ctx, toggle: () => toggle(ctx),
    set draft(text: string) { draft = text; }, get draft() { return draft; },
    fire: (name: string, event = {}) => events.get(name)?.(event, ctx),
  };
}

test("stashes exact multiline text and restores after an intervening interactive turn", () => {
  const h = setup();
  h.draft = "  original\n😀 draft\n";
  h.toggle();
  assert.equal(h.draft, "");
  h.fire("agent_settled");
  assert.equal(h.draft, "");
  h.fire("input", { source: "extension" });
  h.fire("agent_settled");
  assert.equal(h.draft, "");
  h.fire("input", { source: "interactive" });
  h.fire("agent_settled");
  assert.equal(h.draft, "  original\n😀 draft\n");
});

test("never overwrites a new draft; manual restore swaps drafts", () => {
  const h = setup();
  h.draft = "original";
  h.toggle();
  h.fire("input", { source: "interactive" });
  h.draft = "new draft";
  h.fire("agent_settled");
  assert.equal(h.draft, "new draft");
  h.toggle();
  assert.equal(h.draft, "original");
  h.toggle();
  assert.equal(h.draft, "new draft");
  h.draft = "";
  h.toggle();
  assert.equal(h.draft, "original");
});

test("empty draft is a no-op, session changes clear stash, non-TUI is untouched", () => {
  const h = setup();
  h.toggle();
  h.draft = "saved";
  h.toggle();
  h.fire("session_start");
  h.toggle();
  assert.equal(h.draft, "");
  h.ctx.mode = "rpc";
  h.draft = "rpc draft";
  h.toggle();
  assert.equal(h.draft, "rpc draft");
});
