import { emptyUsage, oneLine, type RunDetails } from "./events.ts";
import { JsonEventStream } from "./json-stream.ts";

type JsonObject = Record<string, unknown>;
const object = (value: unknown): JsonObject => value && typeof value === "object" ? value as JsonObject : {};
const number = (value: unknown): number => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
const text = (value: unknown): string => typeof value === "string" ? value : "";

export class ClaudeEventState {
  readonly usage = emptyUsage();
  finalText = "";
  private result?: JsonObject;
  private currentMessageId?: string;
  private readonly messageUsage = new Map<string, JsonObject>();
  private readonly toolIds = new Set<string>();
  private readonly stream = new JsonEventStream((event) => this.accept(object(event)));

  readonly details: RunDetails;
  constructor(details: RunDetails) { this.details = details; this.details.usagePartial = true; }
  feed(chunk: string, eof = false): void { this.stream.feed(chunk, eof); }

  private activity(line: string): void {
    this.details.activity.push(oneLine(line));
    if (this.details.activity.length > 80) this.details.activity.shift();
  }

  private provisionalUsage(id: string | undefined, raw: unknown): void {
    if (!id || this.result) return;
    const incoming = object(raw);
    const previous = this.messageUsage.get(id) ?? {};
    const merged = { ...previous };
    for (const key of ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"])
      if (typeof incoming[key] === "number") merged[key] = incoming[key];
    this.messageUsage.set(id, merged);
    this.usage.input = this.usage.output = this.usage.cacheRead = this.usage.cacheWrite = 0;
    for (const usage of this.messageUsage.values()) {
      this.usage.input += number(usage.input_tokens);
      this.usage.output += number(usage.output_tokens);
      this.usage.cacheRead += number(usage.cache_read_input_tokens);
      this.usage.cacheWrite += number(usage.cache_creation_input_tokens);
    }
    this.usage.totalTokens = this.usage.input + this.usage.output + this.usage.cacheRead + this.usage.cacheWrite;
  }

  private accept(event: JsonObject): void {
    // Leaf runs should never contain subagent messages. Do not let any that
    // appear overwrite the main response or double-count its tools.
    if (event.parent_tool_use_id) return;
    if (event.type === "system" && event.subtype === "init") {
      if (!this.details.model) this.details.model = text(event.model) || undefined;
    } else if (event.type === "stream_event") {
      const update = object(event.event);
      if (update.type === "message_start") {
        this.details.preview = "";
        const message = object(update.message);
        this.currentMessageId = text(message.id) || undefined;
        this.provisionalUsage(this.currentMessageId, message.usage);
      } else if (update.type === "message_delta") {
        this.provisionalUsage(this.currentMessageId, update.usage);
      }
      const delta = object(update.delta);
      if (update.type === "content_block_delta" && delta.type === "text_delta")
        this.details.preview = (this.details.preview + text(delta.text)).slice(-2000);
    } else if (event.type === "assistant" || event.type === "user") {
      const message = object(event.message);
      if (event.type === "assistant") this.provisionalUsage(text(message.id) || undefined, message.usage);
      const content = message.content;
      if (!Array.isArray(content)) return;
      for (const raw of content) {
        const block = object(raw);
        if (block.type === "tool_use") {
          const id = text(block.id);
          if (id && this.toolIds.has(id)) continue;
          if (id) this.toolIds.add(id);
          this.details.toolCalls++;
          const input = object(block.input);
          this.activity(`→ ${text(block.name)} ${text(input.file_path ?? input.path ?? input.command ?? input.query ?? input.pattern)}`);
        } else if (block.type === "tool_result" && block.is_error) {
          this.activity(`✗ tool ${text(block.tool_use_id)} failed`);
        } else if (event.type === "assistant" && block.type === "text") {
          this.details.preview = text(block.text).slice(-2000);
        }
      }
    } else if (event.type === "result") {
      this.result = event;
      this.details.usagePartial = false;
      this.messageUsage.clear();
      this.finalText = text(event.result);
      this.details.preview = this.finalText.slice(-2000);
      this.details.turns = number(event.num_turns);
      // Terminal totals are cumulative, not incremental. modelUsage includes
      // compaction/sidechain calls that the top-level usage may omit.
      const models = Object.values(object(event.modelUsage));
      this.usage.input = this.usage.output = this.usage.cacheRead = this.usage.cacheWrite = 0;
      if (models.length) {
        for (const raw of models) {
          const model = object(raw);
          this.usage.input += number(model.inputTokens);
          this.usage.output += number(model.outputTokens);
          this.usage.cacheRead += number(model.cacheReadInputTokens);
          this.usage.cacheWrite += number(model.cacheCreationInputTokens);
        }
      } else {
        const usage = object(event.usage);
        this.usage.input = number(usage.input_tokens);
        this.usage.output = number(usage.output_tokens);
        this.usage.cacheRead = number(usage.cache_read_input_tokens);
        this.usage.cacheWrite = number(usage.cache_creation_input_tokens);
      }
      this.usage.totalTokens = this.usage.input + this.usage.output + this.usage.cacheRead + this.usage.cacheWrite;
      this.usage.cost.total = number(event.total_cost_usd);
      const denials = event.permission_denials;
      if (Array.isArray(denials)) for (const denial of denials)
        this.activity(`✗ permission denied: ${text(object(denial).tool_name)}`);
    }
  }

  failure(exitCode: number): string | undefined {
    const result = this.result;
    const reasons = Array.isArray(result?.errors) ? result.errors.filter((item) => typeof item === "string").join("; ") : "";
    const error = reasons || (result?.is_error === true ? this.finalText : "");
    if (exitCode !== 0) return `Claude exited with status ${exitCode}${error ? `: ${error}` : ""}`;
    if (!result) return "Claude exited without a result event";
    if (result.subtype !== "success" || result.is_error !== false)
      return reasons || this.finalText || `Claude did not finish normally (${text(result.subtype) || "invalid result"})`;
    if (result.terminal_reason && result.terminal_reason !== "completed")
      return `Claude did not finish normally (${text(result.terminal_reason)})`;
    if (result.stop_reason === "max_tokens") return "Claude response was truncated (max_tokens)";
    if (!this.finalText.trim()) return "Child agent returned no final text";
    return undefined;
  }
}
