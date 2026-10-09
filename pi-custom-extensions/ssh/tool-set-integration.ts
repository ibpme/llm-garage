import type { ToolSet } from "../tool-set/contracts.ts";

const ALWAYS_REMOTE_TOOL_NAMES = ["read_remote"];
export const SAFE_BLOCKED_REMOTE_TOOL_NAMES = ["write_remote", "edit_remote", "bash_remote"];
export const SAFE_ONLY_REMOTE_TOOL_NAMES = ["grep_remote", "ls_remote", "find_remote"];
export const REMOTE_TOOL_NAMES = [
  ...ALWAYS_REMOTE_TOOL_NAMES,
  ...SAFE_BLOCKED_REMOTE_TOOL_NAMES,
  ...SAFE_ONLY_REMOTE_TOOL_NAMES,
];

export function integrateRemoteTools(
  toolSet: ToolSet,
  isConnected: () => boolean,
  refreshStatus: () => void,
) {
  function synchronize() {
    const selection = toolSet.getSelection();
    let next: string[];
    if (!isConnected()) {
      next = selection.filter((name) => !REMOTE_TOOL_NAMES.includes(name));
    } else if (toolSet.getMode() === "safe") {
      next = [...new Set([...selection, ...SAFE_ONLY_REMOTE_TOOL_NAMES])];
    } else {
      next = selection.filter((name) => !SAFE_ONLY_REMOTE_TOOL_NAMES.includes(name));
    }
    if (next.length !== selection.length || next.some((name, i) => name !== selection[i])) {
      toolSet.setSelection(next);
    }
    refreshStatus();
  }

  toolSet.addBlockedTools(SAFE_BLOCKED_REMOTE_TOOL_NAMES);
  synchronize();
  const unsubscribe = toolSet.onChange(synchronize);

  return {
    activate() {
      const selection = new Set(toolSet.getSelection());
      for (const name of [...ALWAYS_REMOTE_TOOL_NAMES, ...SAFE_BLOCKED_REMOTE_TOOL_NAMES]) {
        selection.add(name);
      }
      if (toolSet.getMode() === "safe") {
        for (const name of SAFE_ONLY_REMOTE_TOOL_NAMES) selection.add(name);
      }
      toolSet.setSelection([...selection]);
    },
    deactivate() {
      toolSet.setSelection(toolSet.getSelection().filter((name) => !REMOTE_TOOL_NAMES.includes(name)));
    },
    dispose: unsubscribe,
  };
}
