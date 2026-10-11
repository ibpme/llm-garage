import { readStoredCredential, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { openPager, type PagerSource } from "../shared/pager.ts";
import { formatUsage, plainTheme, renderUsage } from "./formatting.ts";
import { PROVIDERS, UsageError, type UsageProvider, type UsageReport } from "./providers.ts";
import { collectUsage, selectProviders, type UsageDependencies } from "./service.ts";

interface LazyView {
  reports?: UsageReport[];
  capturedAt?: number;
  error?: string;
  redraw?: () => void;
}

function lazyLines(view: LazyView, width: number, theme: ExtensionCommandContext["ui"]["theme"]): string[] {
  if (view.error) return [theme.fg("warning", view.error)];
  if (!view.reports || view.capturedAt === undefined) return [theme.fg("muted", "Loading account usage…")];
  return renderUsage(view.reports, { now: view.capturedAt, theme, width });
}

/** Opens the viewer immediately and fills it in when the lookup settles. */
function showLazyUsage(
  ctx: ExtensionCommandContext,
  providers: readonly UsageProvider[],
  deps: UsageDependencies,
  controller: AbortController,
  release: () => void,
): void {
  const view: LazyView = {};
  const source: PagerSource = {
    lines: (width) => lazyLines(view, width, ctx.ui.theme),
    attach: (redraw) => { view.redraw = redraw; },
    // Closing the viewer cancels the pending requests.
    detach: () => controller.abort(),
  };

  openPager(ctx, { title: "Account Usage", source, plainText: "Loading account usage…" })
    .catch(() => controller.abort());

  collectUsage(providers, ctx, deps, controller.signal)
    .then((reports) => {
      if (controller.signal.aborted) {
        view.error ??= "Usage lookup was cancelled.";
        return;
      }
      // Countdowns are fixed at lookup time, not when the viewer is opened or resized.
      view.reports = reports;
      view.capturedAt = Date.now();
    })
    .catch(() => { view.error = "Usage lookup failed."; })
    .finally(() => {
      release();
      view.redraw?.();
    });
}

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
      let handedOff = false;
      try {
        const providers = selectProviders(args, ctx);
        const deps: UsageDependencies = {
          fetch: globalThis.fetch,
          readCredential: readStoredCredential,
        };
        if (ctx.mode === "tui") {
          // The lookup owns the busy guard from here until it settles.
          handedOff = true;
          showLazyUsage(ctx, providers, deps, controller, () => {
            if (active === controller) active = undefined;
          });
          return;
        }
        const reports = await collectUsage(providers, ctx, deps, controller.signal);
        if (controller.signal.aborted) return;
        // Countdowns are fixed at lookup time, not when the viewer is opened or resized.
        const capturedAt = Date.now();
        if (ctx.mode === "rpc") {
          ctx.ui.notify(formatUsage(reports, capturedAt), "info");
        } else {
          await openPager(ctx, {
            title: "Account Usage",
            source: {
              lines: (width) => renderUsage(reports, { now: capturedAt, theme: plainTheme, width }),
            },
            plainText: formatUsage(reports, capturedAt),
          });
        }
      } catch (error) {
        ctx.ui.notify(error instanceof UsageError ? error.message : "Usage lookup failed.", "warning");
      } finally {
        if (!handedOff && active === controller) active = undefined;
      }
    },
  });
}
