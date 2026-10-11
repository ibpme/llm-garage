import { readStoredCredential, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { openPager, type PagerSource } from "../shared/pager.ts";
import { formatUsage, plainTheme, renderUsage } from "./formatting.ts";
import { PROVIDERS, UsageError } from "./providers.ts";
import { collectUsage, selectProviders } from "./service.ts";

export default function usageExtension(pi: ExtensionAPI) {
  let active: AbortController | undefined;
  const cancel = () => {
    active?.abort();
    active = undefined;
  };
  pi.on("session_start", cancel);
  pi.on("session_shutdown", cancel);

  pi.registerCommand("usage", {
    description: "Show account usage and quota resets for OpenCode Go and OpenAI",
    getArgumentCompletions: (prefix) => ["all", ...PROVIDERS]
      .filter((provider) => provider.startsWith(prefix))
      .map((provider) => ({ value: provider, label: provider })),
    handler: async (args, ctx) => {
      if (active) {
        ctx.ui.notify("A usage lookup is already running.", "info");
        return;
      }
      const controller = new AbortController();
      active = controller;
      try {
        const providers = selectProviders(args, ctx);
        const reports = await collectUsage(providers, ctx, {
          fetch: globalThis.fetch,
          readCredential: readStoredCredential,
        }, controller.signal);
        if (controller.signal.aborted) return;
        // Countdowns are fixed at lookup time, not when the viewer is opened or resized.
        const capturedAt = Date.now();
        if (ctx.mode === "rpc") {
          ctx.ui.notify(formatUsage(reports, capturedAt), "info");
        } else {
          const source: PagerSource = {
            lines: (width) => renderUsage(reports, {
              now: capturedAt,
              theme: ctx.mode === "tui" ? ctx.ui.theme : plainTheme,
              width,
            }),
          };
          await openPager(ctx, {
            title: "Account Usage",
            source,
            plainText: formatUsage(reports, capturedAt),
          });
        }
      } catch (error) {
        ctx.ui.notify(error instanceof UsageError ? error.message : "Usage lookup failed.", "warning");
      } finally {
        if (active === controller) active = undefined;
      }
    },
  });
}
