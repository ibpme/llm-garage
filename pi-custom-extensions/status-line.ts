/**
 * Colorful Status Line Extension
 *
 * Replaces the built-in footer with a more colorful one: colored token
 * stats, a colored context-usage bar, a colored git branch, and a colored
 * model/thinking-level indicator. Enabled by default; toggle with
 * /statusline.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const BAR_WIDTH = 10;

/** Extension statuses hoisted onto line 2 instead of the trailing status line. */
const INLINE_STATUS_KEYS = ["mode", "ssh"] as const;

function sanitizeStatus(text: string): string {
  return text
    .replace(/[\r\n\t]/g, " ")
    .replace(/ +/g, " ")
    .trim();
}

function formatTokens(count: number): string {
  if (count < 1000) return `${count}`;
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

function formatCwd(cwd: string, home: string | undefined): string {
  if (!home) return cwd;
  if (cwd === home) return "~";
  if (cwd.startsWith(`${home}/`)) return `~${cwd.slice(home.length)}`;
  return cwd;
}

function contextColor(percent: number): "success" | "warning" | "error" {
  if (percent > 70) return "error";
  if (percent > 40) return "warning";
  return "success";
}

function thinkingColor(level: string) {
  switch (level) {
    case "minimal":
      return "thinkingMinimal" as const;
    case "low":
      return "thinkingLow" as const;
    case "medium":
      return "thinkingMedium" as const;
    case "high":
      return "thinkingHigh" as const;
    case "xhigh":
      return "thinkingXhigh" as const;
    case "max":
      return "thinkingMax" as const;
    default:
      return "thinkingOff" as const;
  }
}

export default function statusLineExtension(pi: ExtensionAPI) {
  let enabled = true;
  let activeTui: { requestRender(): void } | undefined;

  function install(ctx: ExtensionContext) {
    ctx.ui.setFooter((tui, theme, footerData) => {
      activeTui = tui;
      const unsub = footerData.onBranchChange(() => tui.requestRender());

      return {
        dispose() {
          unsub();
          if (activeTui === tui) activeTui = undefined;
        },
        invalidate() {},
        render(width: number): string[] {
          let input = 0,
            output = 0,
            cacheRead = 0,
            cacheWrite = 0,
            cost = 0;
          for (const e of ctx.sessionManager.getBranch()) {
            if (e.type === "message" && e.message.role === "assistant") {
              const m = e.message as AssistantMessage;
              input += m.usage.input;
              output += m.usage.output;
              cacheRead += m.usage.cacheRead;
              cacheWrite += m.usage.cacheWrite;
              cost += m.usage.cost.total;
            }
          }

          // --- Line 1: cwd + git branch + session name ---
          const home = process.env.HOME || process.env.USERPROFILE;
          const pwd = formatCwd(ctx.sessionManager.getCwd(), home);
          const branch = footerData.getGitBranch();
          const sessionName = ctx.sessionManager.getSessionName();

          let line1 = theme.fg("accent", theme.bold(pwd));
          if (branch) {
            line1 +=
              theme.fg("dim", " on ") + theme.fg("success", `⎇ ${branch}`);
          }
          if (sessionName) {
            line1 += theme.fg("dim", " • ") + theme.fg("muted", sessionName);
          }
          line1 = truncateToWidth(line1, width, theme.fg("dim", "..."));

          // --- Line 2: token stats + context bar + model ---
          const statParts: string[] = [];
          if (input)
            statParts.push(theme.fg("accent", `↑${formatTokens(input)}`));
          if (output)
            statParts.push(theme.fg("success", `↓${formatTokens(output)}`));
          if (cacheRead)
            statParts.push(theme.fg("muted", `R${formatTokens(cacheRead)}`));
          if (cacheWrite)
            statParts.push(theme.fg("muted", `W${formatTokens(cacheWrite)}`));

          const usingSubscription = ctx.model
            ? ctx.modelRegistry.isUsingOAuth(ctx.model)
            : false;
          if (cost || usingSubscription) {
            statParts.push(
              theme.fg(
                "warning",
                `$${cost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`,
              ),
            );
          }

          const contextUsage = ctx.getContextUsage();
          const contextWindow =
            contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
          const percent = contextUsage?.percent ?? 0;
          const color = contextColor(percent);
          const filled = Math.round((Math.min(100, percent) / 100) * BAR_WIDTH);
          const bar =
            theme.fg(color, "█".repeat(filled)) +
            theme.fg("dim", "░".repeat(BAR_WIDTH - filled));
          const percentText =
            contextUsage?.percent != null ? `${percent.toFixed(0)}%` : "?";
          const usedTokens = contextUsage?.tokens ?? 0;
          statParts.push(
            `${bar} ${theme.fg(color, percentText)}${theme.fg("dim", ` ${formatTokens(usedTokens)}/${formatTokens(contextWindow)}`)}`,
          );

          const extensionStatuses = footerData.getExtensionStatuses();

          // Prepended (in reverse) rather than appended so the width
          // truncation below eats the stats before it eats these badges.
          for (let index = INLINE_STATUS_KEYS.length - 1; index >= 0; index--) {
            const inlineStatus = extensionStatuses.get(INLINE_STATUS_KEYS[index]);
            if (inlineStatus) {
              statParts.unshift(sanitizeStatus(inlineStatus));
            }
          }

          let statsLeft = statParts.join(theme.fg("dim", " · "));

          const modelName = ctx.model?.id || "no-model";
          let rightSide = theme.fg("accent", theme.bold(modelName));
          if (ctx.model?.reasoning) {
            const level = pi.getThinkingLevel() || "off";
            rightSide +=
              theme.fg("dim", " • ") + theme.fg(thinkingColor(level), level);
          }

          const rightSideWidth = visibleWidth(rightSide);
          const minPadding = 2;
          let line2: string;
          if (rightSideWidth >= width) {
            // Keep the model visible even on very narrow terminals. The model
            // label is the only part allowed to lose content in this case.
            line2 = truncateToWidth(rightSide, width, theme.fg("dim", "..."));
          } else {
            // The model/thinking indicator is the primary status. Truncate the
            // stats to the space left by it rather than dropping it entirely.
            const statsWidth = width - minPadding - rightSideWidth;
            const visibleStats = truncateToWidth(
              statsLeft,
              statsWidth,
              theme.fg("dim", "..."),
            );
            const padding = " ".repeat(
              Math.max(0, width - visibleWidth(visibleStats) - rightSideWidth),
            );
            line2 = visibleStats + padding + rightSide;
          }

          const lines = [line1, line2];

          const rest = Array.from(extensionStatuses.entries())
            .filter(([key]) => !(INLINE_STATUS_KEYS as readonly string[]).includes(key))
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([, text]) => sanitizeStatus(text));
          if (rest.length > 0) {
            lines.push(
              truncateToWidth(
                rest.join(theme.fg("dim", " · ")),
                width,
                theme.fg("dim", "..."),
              ),
            );
          }

          return lines;
        },
      };
    });
  }

  function uninstall(ctx: ExtensionContext) {
    ctx.ui.setFooter(undefined);
  }

  pi.on("model_select", async () => {
    activeTui?.requestRender();
  });

  pi.registerCommand("statusline", {
    description: "Toggle the colorful status line",
    handler: async (_args, ctx) => {
      enabled = !enabled;
      if (enabled) {
        install(ctx);
        ctx.ui.notify("Colorful status line enabled", "info");
      } else {
        uninstall(ctx);
        ctx.ui.notify("Default status line restored", "info");
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    if (enabled) install(ctx);
  });
}
