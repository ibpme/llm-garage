/**
 * Thinking Block Styling Extension
 *
 * Visually separates thinking blocks with a blockquote-style border when
 * expanded, and animates a spinner into the collapsed-thinking label
 * (Ctrl+T) while the model is actively reasoning.
 *
 * Notes on what this can't do (no extension hook for it):
 * - No animated border. `registerMarkdownTransformer` only controls the
 *   Markdown source; pi renders the resulting blockquote with a static
 *   `mdQuoteBorder` color, redrawn per streaming update.
 * - The "loading" signal while expanded rides on the built-in working
 *   message (`setWorkingMessage`), not the border itself.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 100;
const WORKING_MESSAGE = "Thinking...";

export default function (pi: ExtensionAPI) {
  let spinnerTimer: ReturnType<typeof setInterval> | undefined;
  let frame = 0;

  function stopSpinner(ctx: ExtensionContext) {
    if (!spinnerTimer) return;
    clearInterval(spinnerTimer);
    spinnerTimer = undefined;
    ctx.ui.setHiddenThinkingLabel();
    ctx.ui.setWorkingMessage();
  }

  function startSpinner(ctx: ExtensionContext) {
    if (spinnerTimer) return;
    frame = 0;
    ctx.ui.setWorkingMessage(WORKING_MESSAGE);
    spinnerTimer = setInterval(() => {
      const icon = SPINNER_FRAMES[frame % SPINNER_FRAMES.length];
      frame++;
      ctx.ui.setHiddenThinkingLabel(`${icon} Thinking...`);
    }, SPINNER_INTERVAL_MS);
  }

  pi.on("message_update", async (event, ctx) => {
    const evt = event.assistantMessageEvent;
    if (!evt) return;
    switch (evt.type) {
      case "thinking_start":
      case "thinking_delta":
        startSpinner(ctx);
        break;
      case "thinking_end":
      case "text_start":
      case "toolcall_start":
      case "done":
      case "error":
        stopSpinner(ctx);
        break;
    }
  });

  // Safety nets: never leave the spinner running across turns/idle.
  pi.on("turn_end", async (_event, ctx) => stopSpinner(ctx));
  pi.on("agent_settled", async (_event, ctx) => stopSpinner(ctx));

  pi.registerMarkdownTransformer((markdown, { messageType }) => {
    if (messageType !== "assistant-thinking") return markdown;
    return markdown
      .split("\n")
      .map((line) => (line.length ? `> ${line}` : ">"))
      .join("\n");
  });
}
