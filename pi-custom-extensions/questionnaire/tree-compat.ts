import { type SessionEntry, type SessionTreeNode, TreeSelectorComponent } from "@earendil-works/pi-coding-agent";
import { formatAnswers, parseAnswers, parseQuestions } from "./model.ts";

const QUESTION_TREE_PROTOTYPE_PATCH = Symbol.for(
  "llm-garage.question-tree-filter-prototype-patch",
);

const QUESTION_TREE_INSTANCE_PATCH = Symbol(
  "llm-garage.question-tree-filter-instance-patch",
);

function visibleQuestionEntry(entry: SessionEntry): SessionEntry {
  if (
    entry.type !== "message" ||
    entry.message.role !== "toolResult" ||
    entry.message.toolName !== "question"
  ) {
    return entry;
  }

  const details = entry.message.details as
    | { questions?: unknown; answers?: unknown }
    | undefined;
  const questions = parseQuestions(details?.questions);
  const answers = parseAnswers(details?.answers);
  const prompts = questions?.map((question) => question.prompt).join(" | ");
  const formattedAnswers = questions
    ? formatAnswers(questions, answers).replaceAll("\n", "; ")
    : "";
  const content = [prompts, formattedAnswers].filter(Boolean).join(" — ");

  return {
    type: "custom_message",
    id: entry.id,
    parentId: entry.parentId,
    timestamp: entry.timestamp,
    customType: "question",
    content: content || "Questionnaire",
    display: true,
  };
}

export function installQuestionTreeFilterPatch(): void {
  type TreeListInternals = {
    flatNodes: Array<{ node: SessionTreeNode }>;
    applyFilter(): void;
  };
  type TreeSelectorInternals = {
    treeList: TreeListInternals;
    [QUESTION_TREE_INSTANCE_PATCH]?: boolean;
  };
  type TreeSelectorPrototype = typeof TreeSelectorComponent.prototype & {
    [QUESTION_TREE_PROTOTYPE_PATCH]?: boolean;
  };

  const prototype = TreeSelectorComponent.prototype as TreeSelectorPrototype;
  if (prototype[QUESTION_TREE_PROTOTYPE_PATCH]) return;

  const originalRender = prototype.render;
  prototype.render = function patchedQuestionTreeRender(width: number) {
    const selector = this as unknown as TreeSelectorInternals;
    if (!selector[QUESTION_TREE_INSTANCE_PATCH]) {
      let changed = false;
      for (const flatNode of selector.treeList.flatNodes) {
        const visibleEntry = visibleQuestionEntry(flatNode.node.entry);
        if (visibleEntry !== flatNode.node.entry) {
          flatNode.node.entry = visibleEntry;
          changed = true;
        }
      }
      if (changed) selector.treeList.applyFilter();
      selector[QUESTION_TREE_INSTANCE_PATCH] = true;
    }
    return originalRender.call(this, width);
  };
  prototype[QUESTION_TREE_PROTOTYPE_PATCH] = true;
}
