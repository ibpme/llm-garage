import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { connectClaudeEndpoint, readClaudeEndpoint } from "./registry.ts";
import { parseClaudeSessions } from "./discovery.ts";
import { parseProcesses, run, type Runner } from "./tmux.ts";

export function registerClaudeEndpointsCommand(pi: ExtensionAPI, directory: string): void {
  pi.registerCommand("diagnostics:claude-endpoints", {
    description: "Inspect live Claude messaging endpoint records (use --probe to test reachability, --paths to reveal paths)",
    handler: async (args, ctx) => {
      const flags = args.trim().split(/\s+/).filter(Boolean);
      if (flags.some((flag) => flag !== "--probe" && flag !== "--paths")) {
        ctx.ui.notify("Usage: /diagnostics:claude-endpoints [--probe] [--paths]", "warning");
        return;
      }
      try {
        const rows = await claudeEndpointRows(directory, flags.includes("--probe"));
        ctx.ui.notify(formatClaudeEndpoints(rows, flags.includes("--paths")), "info");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`/diagnostics:claude-endpoints: ${message.replace(/[\x00-\x1f\x7f-\x9f]/g, " ")}`, "error");
      }
    },
  });
}

export interface EndpointRow {
  pid: number;
  sessionId?: string;
  kind: string;
  state: string;
  endpoint: "no session ID" | "not captured or invalid" | "recorded (not probed)" | "reachable" | "unavailable";
  socketPath?: string;
}

export async function claudeEndpointRows(
  directory: string, probe = false, runner: Runner = run,
): Promise<EndpointRow[]> {
  const sessions = parseClaudeSessions(await runner("claude", ["agents", "--json"]));
  const processes = parseProcesses(await runner("ps", ["-axo", "pid=,ppid=,lstart=,comm=,args="]));
  const rows: EndpointRow[] = [];
  for (const session of sessions) {
    const info = processes.get(session.pid);
    if (!info) continue;
    const record = readClaudeEndpoint(directory, session.sessionId, info);
    let endpoint: EndpointRow["endpoint"] = !session.sessionId ? "no session ID" :
      !record ? "not captured or invalid" : "recorded (not probed)";
    if (record && probe) {
      const socket = await connectClaudeEndpoint(directory, session.sessionId!, info, runner);
      endpoint = socket ? "reachable" : "unavailable";
      socket?.destroy();
    }
    rows.push({
      pid: info.pid, sessionId: session.sessionId, kind: session.kind,
      state: session.status ?? session.state ?? "unknown", endpoint,
      socketPath: record?.socketPath,
    });
  }
  return rows;
}

export function formatClaudeEndpoints(rows: EndpointRow[], showPaths = false): string {
  if (!rows.length) return "No live Claude sessions reported by claude agents --json.";
  const clean = (value: string) => value.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
  return rows.map((row) => clean(
    `PID ${row.pid} · ${row.kind} · ${row.state} · session ${row.sessionId ?? "unknown"} · ${row.endpoint}` +
    (showPaths && row.socketPath ? ` · ${row.socketPath}` : ""),
  )).join("\n");
}
