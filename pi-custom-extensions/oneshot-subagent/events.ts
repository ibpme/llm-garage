import type { Usage } from "@earendil-works/pi-ai";
import type { JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { JsonEventStream } from "./json-stream.ts";
import type { Agent } from "./backend.ts";

export interface RunDetails {
  agent?: Agent;
  name: string;
  task: string;
  cwd: string;
  model?: string;
  status: "running" | "success" | "error" | "aborted";
  activity: string[];
  preview: string;
  turns: number;
  toolCalls: number;
  durationMs: number;
  jobDir?: string;
  result?: string;
  exitCode?: number;
  totalTokens?: number;
  usagePartial?: boolean;
  costUsd?: number;
  /** Only present in results saved by versions that supported nested delegation. */
  depth?: number;
  maxDepth?: number;
  children?: unknown[];
  childrenOmitted?: number;
}

export const oneLine = (text: string, limit = 180): string =>
  text.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim().slice(0, limit);

export function emptyUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

export class EventState {
  readonly usage = emptyUsage();
  finalText = "";
  stopReason?: string;
  errorMessage?: string;
  settled = false;
  aborted = false;
  private readonly stream = new JsonEventStream((event) => this.accept(event as JsonAgentSessionEvent));

  readonly details: RunDetails;

  constructor(details: RunDetails) { this.details = details; }

  feed(chunk: string, eof = false): void {
    this.stream.feed(chunk, eof);
  }

  private addUsage(usage: Usage | undefined): void {
    if (!usage) return;
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const)
      this.usage[key] += usage[key] ?? 0;
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const)
      this.usage.cost[key] += usage.cost?.[key] ?? 0;
    for (const key of ["reasoning", "cacheWrite1h"] as const)
      if (usage[key] !== undefined) this.usage[key] = (this.usage[key] ?? 0) + usage[key];
  }

  private activity(text: string): void {
    this.details.activity.push(oneLine(text));
    if (this.details.activity.length > 80) this.details.activity.shift();
  }

  private accept(event: JsonAgentSessionEvent): void {
    switch (event.type) {
      case "message_start":
        if (event.message.role === "assistant") this.details.preview = "";
        break;
      case "message_update": {
        const update = event.assistantMessageEvent;
        if (update.type === "text_delta")
          this.details.preview = (this.details.preview + update.delta).slice(-2000);
        break;
      }
      case "message_end": {
        const message = event.message;
        if (message.role === "assistant") {
          this.details.turns++;
          this.addUsage(message.usage);
          this.finalText = message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
          this.details.preview = this.finalText.slice(-2000);
          this.stopReason = message.stopReason;
          this.errorMessage = message.errorMessage;
        } else if (message.role === "toolResult") {
          this.addUsage(message.usage);
        }
        break;
      }
      case "tool_execution_start": {
        this.details.toolCalls++;
        const args = event.args as Record<string, unknown>;
        const target = args.path ?? args.command ?? args.query ?? args.pattern ?? args.name ?? "";
        this.activity(`→ ${event.toolName} ${typeof target === "string" ? target : ""}`);
        break;
      }
      case "tool_execution_end":
        if (event.isError) this.activity(`✗ ${event.toolName} failed`);
        break;
      case "auto_retry_start": this.activity(`↻ Retry ${event.attempt}: ${event.errorMessage}`); break;
      case "compaction_start": this.activity("↻ Compacting context"); break;
      case "agent_settled": this.settled = true; this.aborted = event.aborted; break;
    }
  }

  failure(exitCode: number): string | undefined {
    if (exitCode !== 0) return `Pi exited with status ${exitCode}`;
    if (this.aborted || this.stopReason === "aborted") return this.errorMessage || "Child agent was aborted";
    if (!this.settled) return "Pi exited without an agent_settled event";
    if (this.stopReason !== "stop") return this.errorMessage || `Child agent did not finish normally (${this.stopReason ?? "no assistant response"})`;
    if (!this.finalText.trim()) return "Child agent returned no final text";
    return undefined;
  }
}
