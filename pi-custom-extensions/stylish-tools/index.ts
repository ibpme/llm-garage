import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createStylishBashTool,
  createStylishEditTool,
  createStylishFindTool,
  createStylishGrepTool,
  createStylishLsTool,
  createStylishReadTool,
  createStylishWriteTool,
} from "./factories.ts";
import { clearOperationsOverride } from "./overrides.ts";

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  const cwd = process.cwd();
  const timers = new Set<NodeJS.Timeout>();

  pi.registerTool(createStylishBashTool(cwd, timers, {
    getBashOptions: () => {
      const settings = pi.getSettings();
      return { shellPath: settings.shellPath, commandPrefix: settings.shellCommandPrefix };
    },
  }));
  pi.registerTool(createStylishReadTool(cwd, timers));
  pi.registerTool(createStylishEditTool(cwd, timers));
  pi.registerTool(createStylishWriteTool(cwd, timers));
  pi.registerTool(createStylishGrepTool(cwd, timers));
  pi.registerTool(createStylishLsTool(cwd, timers));
  pi.registerTool(createStylishFindTool(cwd, timers));

  pi.on("session_shutdown", async () => {
    for (const timer of timers) clearInterval(timer);
    timers.clear();
    clearOperationsOverride();
  });
}
