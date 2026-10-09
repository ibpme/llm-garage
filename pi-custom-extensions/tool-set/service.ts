import type { ToolSet } from "./contracts.ts";

// Extension import graphs are isolated; only the process-wide symbol shares the running instance.
const TOOL_SET_GLOBAL_KEY = Symbol.for("llm-garage.pi-custom-extensions.tool-set");
const services = globalThis as Record<symbol, unknown>;

export function tryGetToolSet(): ToolSet | undefined {
  return services[TOOL_SET_GLOBAL_KEY] as ToolSet | undefined;
}

export function getRequiredToolSet(): ToolSet {
  const toolSet = tryGetToolSet();
  if (!toolSet) throw new Error("tool-set extension has not loaded yet");
  return toolSet;
}

export function publishToolSet(toolSet: ToolSet): () => void {
  services[TOOL_SET_GLOBAL_KEY] = toolSet;
  return () => {
    // An old runtime must not unregister the replacement installed by a reload.
    if (services[TOOL_SET_GLOBAL_KEY] === toolSet) delete services[TOOL_SET_GLOBAL_KEY];
  };
}
