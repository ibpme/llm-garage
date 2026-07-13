/**
 * Mode Extension
 *
 * Simple safe/yolo mode toggle. Pi's default is unrestricted ("yolo"):
 * full tool access, no gating beyond whatever other extensions add. /safe
 * removes write, edit, and bash from the active toolset entirely (not just
 * a runtime block, so the model never sees them as callable), and adds
 * grep/find/ls in their place (pi's read-only equivalents, not part of the
 * default coding toolset) so the model can still search and inspect the
 * filesystem, plus the change_mode tool (see below). /yolo or /auto
 * (identical aliases) restore whatever toolset was active before /safe was
 * invoked.
 *
 * change_mode lets the model request switching SAFE -> YOLO on its own
 * initiative, gated on explicit user approval through a confirmation
 * dialog (modeled on the question tool in questionnare.ts). It is only
 * ever in the active toolset while in safe mode — YOLO is the highest
 * permission level, so there's nothing for the model to request from
 * there, and the tool is removed rather than just blocked, mirroring how
 * write/edit/bash are removed (not blocked) in safe mode.
 *
 * Mode is in-memory only and always starts as yolo on a fresh session.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  Editor,
  type EditorTheme,
  Key,
  matchesKey,
  Text,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";

type Mode = "yolo" | "safe";

const BLOCKED_TOOLS = new Set(["write", "edit", "bash"]);
const SAFE_EXTRA_TOOLS = new Set(["grep", "find", "ls"]);
const CHANGE_MODE_TOOL = "change_mode";
const STATUS_ID = "mode";
const SAFE_MODE_CUSTOM_TYPE = "safe-mode-context";

function safeModeReminder(): string {
  return `
<system-reminder>
  [SAFE MODE ACTIVE]
  The write, edit, and bash tools are not currently in your active toolset — they have been removed, not just blocked.
  Do not attempt to call them; retrying will not surface new information. grep, find, and ls are available in their place for read-only search and inspection.
  If a change is needed, call the change_mode tool with mode: "yolo" to request full tool access. The user can also run /yolo, /auto, or press shift+tab directly at any time.
</system-reminder>
`;
}

interface ChangeModeResult {
  approved: boolean;
  note: string;
}

export default function (pi: ExtensionAPI) {
  let mode: Mode = "yolo";
  // Snapshot of active tools from just before entering safe mode, so
  // leaving safe mode restores whatever was actually active (e.g. if
  // /tools had already disabled some tools) rather than assuming "all".
  let preSafeTools: string[] | null = null;

  function formatTools(ctx: ExtensionContext, max = 6): string {
    const { theme } = ctx.ui;
    const tools = pi.getActiveTools();
    if (tools.length === 0) return theme.fg("dim", "none");
    const shown = tools.slice(0, max);
    let text = theme.fg("muted", shown.join(","));
    if (tools.length > max) {
      text += theme.fg("dim", `,+${tools.length - max}`);
    }
    return text;
  }

  function formatSkills(ctx: ExtensionContext, max = 4): string {
    const { theme } = ctx.ui;
    const skills = pi.getCommands().filter((c) => c.source === "skill");
    if (skills.length === 0) return theme.fg("dim", "none");
    const clean = (name: string) =>
      name.startsWith("skill:") ? name.slice(6) : name;
    const shown = skills.slice(0, max);
    let text = theme.fg("muted", shown.map((s) => clean(s.name)).join(","));
    if (skills.length > max) {
      text += theme.fg("dim", `,+${skills.length - max}`);
    }
    return text;
  }

  // SAFE reads as green/reassuring (restricted, low risk); YOLO reads as
  // red/attention (unrestricted, the actually risky state) — a persistent
  // reminder of which one you're in, not just a toggle confirmation.
  function statusLabel(ctx: ExtensionContext): string {
    const { theme } = ctx.ui;
    const modeLabel =
      mode === "safe"
        ? theme.bold(theme.fg("success", "⏸ SAFE"))
        : theme.bold(theme.fg("error", "⏵⏵ YOLO"));
    return [
      modeLabel + theme.fg("text", "\t(shift+tab to cycle)"),
      theme.fg("dim", "tools:") + formatTools(ctx),
      theme.fg("dim", "skills:") + formatSkills(ctx),
    ].join(theme.fg("dim", " · "));
  }

  function applyStatus(ctx: ExtensionContext) {
    ctx.ui.setStatus(STATUS_ID, statusLabel(ctx));
  }

  function setMode(next: Mode, ctx: ExtensionContext) {
    if (next === mode) return;

    if (next === "safe") {
      preSafeTools = pi.getActiveTools();
      const kept = preSafeTools.filter((name) => !BLOCKED_TOOLS.has(name));
      const available = new Set(pi.getAllTools().map((t) => t.name));
      const extras = [...SAFE_EXTRA_TOOLS, CHANGE_MODE_TOOL].filter(
        (name) => available.has(name) && !kept.includes(name),
      );
      pi.setActiveTools([...kept, ...extras]);
    } else if (preSafeTools) {
      pi.setActiveTools(preSafeTools);
      preSafeTools = null;
    }

    mode = next;
    applyStatus(ctx);
    const NOTIFY = false;
    if (NOTIFY) {
      ctx.ui.notify(
        mode === "safe"
          ? "Safe mode on: write, edit, and bash are unavailable; grep, find, and ls are enabled"
          : "Yolo mode on: full tool access restored",
        mode === "safe" ? "info" : "warning",
      );
    }
  }

  pi.registerTool({
    name: CHANGE_MODE_TOOL,
    label: "Change Mode",
    description:
      "Request user to switch mode (maybe needed if you are in safe mode and need more tool access / YOLO mode)",
    parameters: Type.Object({
      mode: Type.Literal("yolo", {
        description: "Target mode to switch to.",
      }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (ctx.mode !== "tui") {
        return {
          content: [
            {
              type: "text",
              text: "Error: UI not available (running in non-interactive mode)",
            },
          ],
          details: { approved: false, note: "" } satisfies ChangeModeResult,
        };
      }
      if (mode !== "safe") {
        return {
          content: [
            {
              type: "text",
              text: "Error: change_mode is only available in safe mode",
            },
          ],
          details: { approved: false, note: "" } satisfies ChangeModeResult,
        };
      }

      const result = await ctx.ui.custom<ChangeModeResult>(
        (tui, theme, _kb, done) => {
          let choice: "allow" | "deny" = "allow";
          // "toggle": Up/Down move between Allow/Deny. "reason": Right or
          // Tab from the toggle enters an inline text field for that
          // choice; Enter submits from either stage (empty reason if
          // still on "toggle"). Esc always denies immediately, from
          // either stage, with no reason.
          let stage: "toggle" | "reason" = "toggle";
          let cachedLines: string[] | undefined;

          const editorTheme: EditorTheme = {
            borderColor: (s) => theme.fg("accent", s),
            selectList: {
              selectedPrefix: (t) => theme.fg("accent", t),
              selectedText: (t) => theme.fg("accent", t),
              description: (t) => theme.fg("muted", t),
              scrollInfo: (t) => theme.fg("dim", t),
              noMatch: (t) => theme.fg("warning", t),
            },
          };
          const editor = new Editor(tui, editorTheme);

          function refresh() {
            cachedLines = undefined;
            tui.requestRender();
          }

          editor.onSubmit = (value) => {
            done({ approved: choice === "allow", note: value.trim() });
          };

          function handleInput(data: string) {
            if (stage === "reason") {
              // Esc or Tab always back out of the reason field to the
              // toggle; Up does too, but only at the start of the text
              // (so it still moves the cursor within a multi-line
              // reason). None of these submit — the Allow/Deny choice is
              // kept, only the reason draft is discarded.
              if (matchesKey(data, Key.escape) || matchesKey(data, Key.tab)) {
                stage = "toggle";
                editor.setText("");
                refresh();
                return;
              }
              if (matchesKey(data, Key.up)) {
                const cursor = editor.getCursor();
                if (cursor.line === 0 && cursor.col === 0) {
                  stage = "toggle";
                  editor.setText("");
                  refresh();
                  return;
                }
              }
              editor.handleInput(data);
              refresh();
              return;
            }

            if (matchesKey(data, Key.escape)) {
              done({ approved: false, note: "" });
              return;
            }

            if (matchesKey(data, Key.left) || matchesKey(data, Key.right)) {
              choice = choice === "allow" ? "deny" : "allow";
              refresh();
              return;
            }
            if (matchesKey(data, Key.down) || matchesKey(data, Key.tab)) {
              stage = "reason";
              editor.setText("");
              refresh();
              return;
            }
            if (matchesKey(data, Key.enter)) {
              done({ approved: choice === "allow", note: "" });
            }
          }

          function render(width: number): string[] {
            if (cachedLines) return cachedLines;
            const renderWidth = Math.max(1, width);
            const lines: string[] = [];

            function addWrapped(text: string) {
              lines.push(...wrapTextWithAnsi(text, renderWidth));
            }

            lines.push(theme.fg("accent", "─".repeat(renderWidth)));
            addWrapped(
              theme.bold(
                theme.fg(
                  "text",
                  `Agent wants to change mode -> ${params.mode.toUpperCase()}`,
                ),
              ),
            );
            lines.push("");

            const allowLabel =
              choice === "allow"
                ? theme.bg("selectedBg", theme.fg("text", " Allow "))
                : theme.fg("success", " Allow ");
            const denyLabel =
              choice === "deny"
                ? theme.bg("selectedBg", theme.fg("text", " Deny "))
                : theme.fg("error", " Deny ");
            lines.push(`${allowLabel}  ${denyLabel}`);
            lines.push("");

            if (stage === "reason") {
              addWrapped(
                theme.fg(
                  "muted",
                  `Reason for "${choice === "allow" ? "Allow" : "Deny"}" (optional, Enter to submit, Esc/Tab/↑ to go back):`,
                ),
              );
              for (const line of editor.render(Math.max(1, renderWidth - 2))) {
                lines.push(` ${line}`);
              }
            } else {
              addWrapped(
                theme.fg(
                  "dim",
                  "←→ select • ↓ / Tab add a reason • Enter confirm • Esc deny",
                ),
              );
            }

            lines.push(theme.fg("accent", "─".repeat(renderWidth)));
            cachedLines = lines;
            return lines;
          }

          return {
            render,
            invalidate: () => {
              cachedLines = undefined;
            },
            handleInput,
          };
        },
      );

      if (result.approved) {
        setMode(params.mode, ctx);
        // pi's agent-session.js documents that setActiveTools() "takes
        // effect on the next agent turn" — the tool list for the turn
        // already in flight (this one) was fixed before this tool ran.
        // Queue a silent follow-up so a new turn starts as soon as this
        // one ends, picking up write/edit/bash without the user having
        // to send another message themselves.
        const clarification = result.note ? ` User note: ${result.note}` : "";
        pi.sendMessage(
          {
            customType: "change-mode-followup",
            content: `${params.mode.toUpperCase()} mode is now active. Continue with the task.${clarification}`,
            display: false,
          },
          // deliverAs: "followUp" only fires if this.isStreaming is true
          // at this exact moment (see agent-session.js's
          // sendCustomMessage branch order); if that assumption is ever
          // wrong, the call falls through to a silent no-op with no turn
          // triggered at all. triggerTurn is a no-op when isStreaming is
          // true (the current, expected path) but is the fallback that
          // routes to _runAgentPrompt instead of silently doing nothing
          // if it's ever false.
          { deliverAs: "followUp", triggerTurn: true },
        );
      }

      const text = result.approved
        ? `User approved switching to ${params.mode.toUpperCase()} mode. Tool access resumes automatically in a follow-up turn right after this one.${result.note ? ` Note: ${result.note}` : ""}`
        : `User denied switching to ${params.mode.toUpperCase()} mode; remaining in SAFE mode.${result.note ? ` Reason: ${result.note}` : ""}`;

      return {
        content: [{ type: "text", text }],
        details: result,
      };
    },

    renderCall(args, theme) {
      const targetMode = (args as { mode?: string }).mode ?? "";
      let text = theme.fg("toolTitle", theme.bold("Change Mode"));
      text += theme.fg("muted", ` SAFE → ${targetMode.toUpperCase()}`);
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme) {
      const details = result.details as ChangeModeResult | undefined;
      if (!details) {
        const t = result.content[0];
        return new Text(t?.type === "text" ? t.text : "", 0, 0);
      }
      const label = details.approved
        ? theme.fg("success", "✓ Approved")
        : theme.fg("warning", "✗ Denied — staying SAFE");
      const note = details.note ? `\n${theme.fg("muted", details.note)}` : "";
      return new Text(`${label}${note}`, 0, 0);
    },
  });

  pi.registerCommand("safe", {
    description:
      "Enable safe mode (removes write/edit/bash, adds grep/find/ls)",
    handler: async (_args, ctx) => setMode("safe", ctx),
  });

  pi.registerCommand("yolo", {
    description: "Disable safe mode (restore prior tool access)",
    handler: async (_args, ctx) => setMode("yolo", ctx),
  });

  pi.registerCommand("auto", {
    description: "Disable safe mode (alias for /yolo)",
    handler: async (_args, ctx) => setMode("yolo", ctx),
  });

  // Requires "app.thinking.cycle" freed in ~/.pi/agent/keybindings.json,
  // otherwise this is silently dropped as a reserved-key conflict.
  pi.registerShortcut("shift+tab", {
    description: "Toggle YOLO/SAFE mode",
    handler: async (ctx) => setMode(mode === "safe" ? "yolo" : "safe", ctx),
  });

  // Show the mode label from the start of every session, not just after
  // the first toggle.
  pi.on("session_start", async (_event, ctx) => {
    mode = "yolo";
    preSafeTools = null;
    // change_mode is safe-mode-only; a fresh session starts in yolo, so
    // strip it in case registerTool() defaults it into the active set.
    const active = pi.getActiveTools();
    if (active.includes(CHANGE_MODE_TOOL)) {
      pi.setActiveTools(active.filter((name) => name !== CHANGE_MODE_TOOL));
    }
    applyStatus(ctx);
  });

  // Defense-in-depth: if the tool is somehow still reachable (e.g. another
  // extension re-adds it while safe mode is on), still refuse to run it.
  pi.on("tool_call", async (event) => {
    if (mode === "safe" && BLOCKED_TOOLS.has(event.toolName)) {
      return {
        block: true,
        reason: `Blocked by safe mode: ${event.toolName} is disabled. Use /yolo or /auto to restore access.`,
      };
    }
    if (mode === "yolo" && event.toolName === CHANGE_MODE_TOOL) {
      return {
        block: true,
        reason: `${CHANGE_MODE_TOOL} is only available in safe mode — yolo is already the highest permission level.`,
      };
    }
    return undefined;
  });

  // Proactive signal: unlike tool_call's block+reason (only fires after
  // the model has already tried and failed a blocked call), this runs on
  // every LLM call — including mid-turn, e.g. right after shift+tab flips
  // mode while the agent loop is still going — so the model has standing
  // knowledge that write/edit/bash are gone before it ever attempts them.
  // Never persisted to session history (context hook output isn't written
  // back), so the filter below is defensive, not load-bearing.
  pi.on("context", async (event) => {
    const withoutStale = event.messages.filter(
      (m) =>
        (m as AgentMessage & { customType?: string }).customType !==
        SAFE_MODE_CUSTOM_TYPE,
    );
    if (mode !== "safe") return { messages: withoutStale };
    return {
      messages: [
        ...withoutStale,
        {
          role: "user",
          customType: SAFE_MODE_CUSTOM_TYPE,
          content: safeModeReminder(),
          display: false,
          timestamp: Date.now(),
        },
      ],
    };
  });

  // Refresh the status bar whenever tools or skills may have changed.
  pi.on("turn_start", async (_event, ctx) => {
    applyStatus(ctx);
  });

  pi.on("resources_discover", async (_event, ctx) => {
    applyStatus(ctx);
  });
}
