import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { openBrowser } from "./browser.ts";
import { readRegistry, registryDirectory } from "./reader.ts";
import { performPaneAction } from "./tmux-actions.ts";
import { clean } from "./view.ts";

export default function agentsExtension(pi: ExtensionAPI): void {
  pi.registerCommand("agents", {
    description: "Browse live agents and session transcripts; inspect metadata, attach, split or kill tmux panes",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") { ctx.ui.notify("/agents requires interactive TUI mode.", "error"); return; }
      const tmux = process.env.TMUX;
      const paneId = process.env.TMUX_PANE;
      const origin = tmux && paneId ? { server: tmux.replace(/,\d+,\d+$/, ""), paneId } : undefined;
      const directory = registryDirectory();
      try {
        await openBrowser(ctx, { readRegistry: () => readRegistry(directory), origin, performPaneAction });
      } catch (error) { ctx.ui.notify(`/agents: ${clean(error instanceof Error ? error.message : String(error))}`, "error"); }
    },
  });
}
