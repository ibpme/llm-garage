import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type AgentToolResult, defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { Static } from "typebox";
import type { Answer, Question, QuestionnaireResult, ReanswerMessageDetails } from "./contracts.ts";
import { formatAnswers } from "./model.ts";
import { findReanswerCandidates, REANSWER_MESSAGE_TYPE } from "./reanswer.ts";
import { QuestionnaireParams } from "./schema.ts";
import { installQuestionTreeFilterPatch } from "./tree-compat.ts";
import { runQuestionnaire as showQuestionnaire } from "./ui.ts";

export default function questionnaire(pi: ExtensionAPI) {
  installQuestionTreeFilterPatch();

  let initialAnswersForNextExecution: Answer[] | undefined;

  async function runQuestionnaire(params: Static<typeof QuestionnaireParams>, ctx: Pick<ExtensionContext, "mode" | "ui">): Promise<AgentToolResult<unknown>> {
    const initialAnswers = initialAnswersForNextExecution;
    initialAnswersForNextExecution = undefined;
    return showQuestionnaire(params, ctx, initialAnswers);
  }

  const questionTool = defineTool({
    // name: "questionnaire", Custom override
    // label: "Questionnaire",
    name: "question",
    label: "Question(s) tool",
    description: "Ask the user one or more single or multi-select questions.",
    parameters: QuestionnaireParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return runQuestionnaire(params, ctx);
    },

    renderCall(args, theme, _context) {
      const qs = (args.questions as Question[]) || [];
      const count = qs.length;
      const labels = qs.map((q) => q.label || q.id).join(", ");
      let text = theme.fg("toolTitle", theme.bold("Question Tool "));
      text += theme.fg("muted", `${count} question${count !== 1 ? "s" : ""}`);
      if (labels) {
        text += theme.fg("dim", ` (${labels})`);
      }
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme, _context) {
      const details = result.details as QuestionnaireResult | undefined;
      if (!details) {
        const text = result.content[0];
        return new Text(text?.type === "text" ? text.text : "", 0, 0);
      }
      if (details.cancelled) {
        return new Text(theme.fg("warning", "Cancelled"), 0, 0);
      }
      const lines = details.answers.map((a) => {
        const parts = a.values.map((v) => {
          if (v.wasCustom) {
            return `${theme.fg("muted", "(wrote) ")}${v.label}`;
          }
          return v.index ? `${v.index}. ${v.label}` : v.label;
        });
        return `${theme.fg("success", "✓ ")}${theme.fg("accent", a.id)}: ${parts.join(", ")}`;
      });
      return new Text(lines.join("\n"), 0, 0);
    },
  });

  pi.registerTool(questionTool);

  pi.registerMessageRenderer<ReanswerMessageDetails>(
    REANSWER_MESSAGE_TYPE,
    (message, _options, theme) => {
      const details = message.details;
      if (!details) {
        return new Text(theme.fg("warning", "Revised questionnaire answers"), 0, 0);
      }

      const heading = theme.fg(
        "accent",
        theme.bold("Revised questionnaire answers"),
      );
      const answers = formatAnswers(
        details.result.questions,
        details.result.answers,
      );
      return new Text(`${heading}\n${theme.fg("text", answers)}`, 0, 0);
    },
  );

  pi.on("context", (event) => {
    const replacements = new Map<string, QuestionnaireResult>();
    for (const message of event.messages) {
      if (
        message.role === "custom" &&
        message.customType === REANSWER_MESSAGE_TYPE
      ) {
        const details = message.details as ReanswerMessageDetails | undefined;
        if (details) replacements.set(details.toolCallId, details.result);
      }
    }
    if (replacements.size === 0) return;

    const messages = event.messages
      .filter(
        (message) =>
          !(
            message.role === "custom" &&
            message.customType === REANSWER_MESSAGE_TYPE
          ),
      )
      .map((message): AgentMessage => {
        if (message.role !== "toolResult") return message;

        const replacement = replacements.get(message.toolCallId);
        if (!replacement) return message;
        return {
          ...message,
          content: [
            {
              type: "text" as const,
              text: formatAnswers(
                replacement.questions,
                replacement.answers,
              ),
            },
          ],
          details: replacement,
          isError: false,
        };
      });
    return { messages };
  });

  pi.registerCommand("reanswer", {
    description:
      "Reopen a completed question tool call and branch with revised answers",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/reanswer is only available in interactive TUI mode", "error");
        return;
      }

      await ctx.waitForIdle();
      const candidates = findReanswerCandidates(ctx.sessionManager.getBranch());
      if (candidates.length === 0) {
        ctx.ui.notify("No completed question tool calls on this branch", "warning");
        return;
      }

      const newestFirst = [...candidates].reverse();
      let candidate = newestFirst[0];
      if (newestFirst.length > 1) {
        const labels = newestFirst.map((item, index) => {
          const questionLabels = item.questions
            .map((question) => question.label)
            .join(", ");
          const previous = formatAnswers(
            item.questions,
            item.previousAnswers,
          )
            .replaceAll("\n", "; ")
            .slice(0, 120);
          return `${index + 1}. ${questionLabels}${previous ? ` — ${previous}` : ""}`;
        });
        const selected = await ctx.ui.select(
          "Re-answer which questionnaire?",
          labels,
        );
        if (selected === undefined) return;
        candidate = newestFirst[labels.indexOf(selected)];
      }

      initialAnswersForNextExecution = candidate.previousAnswers;
      let rerun;
      try {
        rerun = await runQuestionnaire({ questions: candidate.questions }, ctx);
      } finally {
        initialAnswersForNextExecution = undefined;
      }
      const revised = rerun.details as QuestionnaireResult | undefined;
      if (!revised || revised.cancelled) {
        ctx.ui.notify("Re-answer cancelled", "info");
        return;
      }

      const navigation = await ctx.navigateTree(candidate.resultEntryId, {
        summarize: false,
      });
      if (navigation.cancelled) {
        ctx.ui.notify("Could not create the re-answer branch", "error");
        return;
      }

      const formatted = formatAnswers(revised.questions, revised.answers);
      pi.sendMessage(
        {
          customType: REANSWER_MESSAGE_TYPE,
          content:
            "The user reopened the questionnaire and revised their answers. " +
            "These answers supersede the earlier question tool result; use only " +
            `the revised answers below.\n\n${formatted}`,
          display: true,
          details: {
            toolCallId: candidate.toolCallId,
            result: revised,
          } satisfies ReanswerMessageDetails,
        },
        { triggerTurn: true },
      );
    },
  });
}
