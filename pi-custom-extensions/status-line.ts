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

const BAR_WIDTH = 40;

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
  if (percent > 90) return "error";
  if (percent > 70) return "warning";
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
    default:
      return "thinkingOff" as const;
  }
}

export default function statusLineExtension(pi: ExtensionAPI) {
  let enabled = true;

  function install(ctx: ExtensionContext) {
    ctx.ui.setFooter((tui, theme, footerData) => {
      const unsub = footerData.onBranchChange(() => tui.requestRender());

      return {
        dispose: unsub,
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
          statParts.push(
            `${bar} ${theme.fg(color, percentText)}${theme.fg("dim", `/${formatTokens(contextWindow)}`)}`,
          );

          let statsLeft = statParts.join(theme.fg("dim", " · "));

          const modelName = ctx.model?.id || "no-model";
          let rightSide = theme.fg("accent", theme.bold(modelName));
          if (ctx.model?.reasoning) {
            const level = pi.getThinkingLevel() || "off";
            rightSide +=
              theme.fg("dim", " • ") + theme.fg(thinkingColor(level), level);
          }

          const statsLeftWidth = visibleWidth(statsLeft);
          const rightSideWidth = visibleWidth(rightSide);
          const minPadding = 2;
          let line2: string;
          if (statsLeftWidth + minPadding + rightSideWidth <= width) {
            const padding = " ".repeat(width - statsLeftWidth - rightSideWidth);
            line2 = statsLeft + padding + rightSide;
          } else {
            line2 = truncateToWidth(statsLeft, width, theme.fg("dim", "..."));
          }

          const lines = [line1, line2];

          const extensionStatuses = footerData.getExtensionStatuses();
          if (extensionStatuses.size > 0) {
            const statusLine = Array.from(extensionStatuses.entries())
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([, text]) =>
                text
                  .replace(/[\r\n\t]/g, " ")
                  .replace(/ +/g, " ")
                  .trim(),
              )
              .join(theme.fg("dim", " · "));
            lines.push(
              truncateToWidth(statusLine, width, theme.fg("dim", "...")),
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
