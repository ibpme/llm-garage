import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Answer, Question, ReanswerCandidate } from "./contracts.ts";
import { parseAnswers, parseQuestions } from "./model.ts";

export const REANSWER_MESSAGE_TYPE = "question-reanswer";

export function findReanswerCandidates(
  branch: SessionEntry[],
): ReanswerCandidate[] {
  const resultsByCallId = new Map<
    string,
    { entryId: string; questions?: Question[]; answers: Answer[] }
  >();

  for (const entry of branch) {
    if (
      entry.type !== "message" ||
      entry.message.role !== "toolResult" ||
      entry.message.toolName !== "question"
    ) {
      continue;
    }

    const details = entry.message.details as
      | { questions?: unknown; answers?: unknown }
      | undefined;
    resultsByCallId.set(entry.message.toolCallId, {
      entryId: entry.id,
      questions: parseQuestions(details?.questions),
      answers: parseAnswers(details?.answers),
    });
  }

  const candidates: ReanswerCandidate[] = [];
  for (const entry of branch) {
    if (entry.type !== "message" || entry.message.role !== "assistant") {
      continue;
    }

    for (const content of entry.message.content) {
      if (content.type !== "toolCall" || content.name !== "question") continue;
      const result = resultsByCallId.get(content.id);
      if (!result) continue;

      const callArguments = content.arguments as
        | { questions?: unknown }
        | undefined;
      const questions =
        result.questions || parseQuestions(callArguments?.questions);
      if (!questions) continue;

      candidates.push({
        resultEntryId: result.entryId,
        toolCallId: content.id,
        questions,
        previousAnswers: result.answers,
      });
    }
  }

  return candidates;
}
