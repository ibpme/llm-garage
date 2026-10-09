import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { extractTextParts } from "../shared/message-text.ts";

const MAX_CONTEXT_CHARS = 24_000;

const MAX_MESSAGE_CHARS = 4_000;

const MAX_TOOL_RESULT_CHARS = 800;

const MAX_TOOL_ARGS_CHARS = 300;

type TranscriptRole = "user" | "assistant" | "tool" | "summary";

interface TranscriptSection {
  role: TranscriptRole;
  text: string;
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.7);
  const tail = max - head;
  const omitted = text.length - max;
  return `${text.slice(0, head)}\n[...${omitted} chars omitted...]\n${text.slice(-tail)}`;
}

function summarizeArguments(args: unknown): string {
  try {
    return clip(JSON.stringify(args ?? {}), MAX_TOOL_ARGS_CHARS);
  } catch {
    return "{}";
  }
}

export function transcriptSections(ctx: ExtensionContext): TranscriptSection[] {
  const sections: TranscriptSection[] = [];

  for (const entry of ctx.sessionManager.buildContextEntries()) {
    if (entry.type === "compaction") {
      sections.push({ role: "summary", text: `[EARLIER SUMMARY]\n${entry.summary}` });
      continue;
    }
    if (entry.type === "branch_summary") {
      sections.push({ role: "summary", text: `[BRANCH SUMMARY]\n${entry.summary}` });
      continue;
    }
    if (entry.type !== "message") continue;

    const { message } = entry;

    if (message.role === "user") {
      const text = extractTextParts(message.content).trim();
      if (text) sections.push({ role: "user", text: clip(text, MAX_MESSAGE_CHARS) });
      continue;
    }

    if (message.role === "assistant") {
      // Tool calls carry the actual work (edits, commands), so they must stay visible.
      const parts: string[] = [];
      for (const part of message.content) {
        if (part.type === "text" && part.text.trim()) {
          parts.push(clip(part.text.trim(), MAX_MESSAGE_CHARS));
        } else if (part.type === "toolCall") {
          parts.push(`[called ${part.name} ${summarizeArguments(part.arguments)}]`);
        }
      }
      if (parts.length) sections.push({ role: "assistant", text: parts.join("\n") });
      continue;
    }

    if (message.role === "toolResult") {
      const text = extractTextParts(message.content).trim();
      const status = message.isError ? " (error)" : "";
      sections.push({
        role: "tool",
        text: `[tool ${message.toolName}${status}] ${clip(text || "(no output)", MAX_TOOL_RESULT_CHARS)}`,
      });
      continue;
    }

    if (message.role === "bashExecution" && !message.excludeFromContext) {
      const output = clip(message.output.trim() || "(no output)", MAX_TOOL_RESULT_CHARS);
      sections.push({
        role: "tool",
        text: `[user ran shell] $ ${message.command}\n${output}`,
      });
    }
  }

  return sections;
}

/**
 * Keeps the original request (first user message) and as much recent history
 * as fits. Dropping the oldest turns is safe; dropping the goal is not.
 */
export function serializeContext(sections: TranscriptSection[]): string {
  const full = sections.map((section) => section.text).join("\n\n");
  if (full.length <= MAX_CONTEXT_CHARS) return full;

  const note = "[Earlier conversation truncated]";
  const pinnedIndex = sections.findIndex((section) => section.role === "user");
  const kept = new Set<number>();
  let length = note.length;

  if (pinnedIndex >= 0) {
    kept.add(pinnedIndex);
    length += sections[pinnedIndex]!.text.length + 2;
  }

  for (let index = sections.length - 1; index >= 0; index--) {
    if (kept.has(index)) continue;
    const cost = sections[index]!.text.length + 2;
    if (length + cost > MAX_CONTEXT_CHARS) break;
    kept.add(index);
    length += cost;
  }

  const parts: string[] = [];
  let skipped = false;
  for (let index = 0; index < sections.length; index++) {
    if (!kept.has(index)) {
      skipped = true;
      continue;
    }
    if (skipped && parts.length) parts.push("[...]");
    skipped = false;
    parts.push(sections[index]!.text);
  }

  return `${note}\n\n${parts.join("\n\n")}`;
}

export function endsWithCompletedAssistantTurn(ctx: ExtensionContext): boolean {
  const last = ctx.sessionManager
    .buildContextEntries()
    .filter((entry) => entry.type === "message")
    .at(-1);
  if (!last || last.type !== "message") return false;
  const { message } = last;
  return (
    message.role === "assistant" &&
    message.stopReason !== "error" &&
    message.stopReason !== "aborted"
  );
}
