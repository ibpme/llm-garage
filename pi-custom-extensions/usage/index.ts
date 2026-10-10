import { readStoredCredential, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { openPager, textSource } from "../shared/pager.ts";
import { formatUsage } from "./formatting.ts";
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
        const text = formatUsage(reports);
        if (ctx.mode === "rpc") {
          ctx.ui.notify(text, "info");
        } else {
          await openPager(ctx, { title: "Account Usage", source: textSource(text), plainText: text });
        }
      } catch (error) {
        ctx.ui.notify(error instanceof UsageError ? error.message : "Usage lookup failed.", "warning");
      } finally {
        if (active === controller) active = undefined;
      }
    },
  });
}
