/** Read-only `/tools` registry viewer. Exposure is distinct from active declarations. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { openPager } from "../shared/pager.ts";
import type { ToolSet } from "./contracts.ts";
import { groupTools, toolDisplayName, toolStatus } from "./viewer-model.ts";

export function registerViewer(pi: ExtensionAPI, toolSet: ToolSet) {
  pi.registerCommand("tools", {
    description: "View tools grouped by kind and MCP server, with activation/exposure status (read-only)",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/tools requires TUI mode", "error");
        return;
      }

      const allTools = pi.getAllTools();
      const active = new Set(pi.getActiveTools());
      const sections = groupTools(allTools, active);
      const nameWidth = Math.min(45, Math.max(4, ...allTools.map((tool) => toolDisplayName(tool).length)));
      const modeHint = `${toolSet.getMode().toUpperCase()} mode — /safe /yolo to change`;
      const help = [
        "Deferred: discover via tool_search or codemode · Loaded: active declaration",
        "Unregistered/disabled servers: /mcp",
      ];

      await openPager(ctx, {
        title: "Tools",
        footerChips: [modeHint],
        source: {
          lines: (width) => [
            ...sections.flatMap((section) => [
              ctx.ui.theme.fg("dim", ctx.ui.theme.bold(`── ${section.title} ──`)),
              ...section.tools.map((tool) => {
                const status = toolStatus(tool, active, toolSet);
                const columns = Math.max(4, Math.min(nameWidth, width - status.label.length - 6));
                const name = truncateToWidth(toolDisplayName(tool), columns, "…", true);
                return `  ${name}  ${ctx.ui.theme.fg(status.color, status.label)}`;
              }),
            ]),
            "",
            ...help.map((line) => ctx.ui.theme.fg("dim", line)),
          ],
        },
        plainText: [
          modeHint,
          ...sections.flatMap((section) => [
            `── ${section.title} ──`,
            ...section.tools.map((tool) => `  ${toolDisplayName(tool)}  ${toolStatus(tool, active, toolSet).label}`),
          ]),
          "",
          ...help,
        ].join("\n"),
      });
    },
  });
}
