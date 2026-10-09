import type { AgentToolResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Editor, type EditorTheme, Key, matchesKey, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Static } from "typebox";
import type { Answer, AnswerValue, Question, QuestionnaireResult, RenderOption } from "./contracts.ts";
import { formatAnswers } from "./model.ts";
import type { QuestionnaireParams } from "./schema.ts";

export async function runQuestionnaire(
  params: Static<typeof QuestionnaireParams>,
  ctx: Pick<ExtensionContext, "mode" | "ui">,
  initialAnswers?: Answer[],
): Promise<AgentToolResult<unknown>> {
  if (ctx.mode !== "tui") {
    throw new Error(
      "Question UI is only available in interactive TUI mode",
    );
  }

  const questions: Question[] = params.questions.map((q, i) => ({
    ...q,
    label: q.label || `Q${i + 1}`,
    multiSelect: q.multiSelect === true,
  }));

  const questionIds = new Set<string>();
  for (const question of questions) {
    if (questionIds.has(question.id)) {
      throw new Error(`Duplicate question id: ${question.id}`);
    }
    questionIds.add(question.id);

    const optionValues = new Set<string>();
    for (const option of question.options) {
      if (optionValues.has(option.value)) {
        throw new Error(
          `Question ${question.id} has duplicate option value: ${option.value}`,
        );
      }
      optionValues.add(option.value);
    }
  }

  const isMulti = questions.length > 1;
  const totalTabs = questions.length + 1; // questions + Submit

  const result = await ctx.ui.custom<QuestionnaireResult>(
    (tui, theme, _kb, done) => {
      // State
      let currentTab = 0;
      let optionIndex = 0;
      let inputMode = false;
      let inputQuestionId: string | null = null;
      let validationMessage: string | undefined;
      let cachedWidth: number | undefined;
      let cachedLines: string[] | undefined;

      // Per-question state
      const selections = new Map<string, Set<number>>();
      const customInputs = new Map<string, string>();
      const confirmed = new Set<string>();

      for (const answer of initialAnswers || []) {
        const question = questions.find((item) => item.id === answer.id);
        if (!question) continue;

        const selected = new Set<number>();
        for (const value of answer.values) {
          if (value.wasCustom) {
            customInputs.set(question.id, value.value);
            selected.add(question.options.length);
            continue;
          }

          const optionIndex = question.options.findIndex(
            (option) => option.value === value.value,
          );
          if (optionIndex >= 0) selected.add(optionIndex);
        }
        if (selected.size > 0) {
          selections.set(question.id, selected);
          confirmed.add(question.id);
        }
      }

      const firstSelection = selections.get(questions[0].id);
      if (firstSelection && firstSelection.size > 0) {
        optionIndex = Math.min(...firstSelection);
      }

      // Editor for "Type something" option
      const editorTheme: EditorTheme = {
        borderColor: (s) => theme.fg("accent", s),
        selectList: {
          selectedPrefix: (t) => theme.fg("accent", t),
          selectedText: (t) => theme.fg("accent", t),
          description: (t) => theme.fg("muted", t),
          scrollInfo: (t) => theme.fg("dim", t),
          noMatch: (t) => theme.fg("warning", t),
        },
      };
      const editor = new Editor(tui, editorTheme);

      // Helpers
      function refresh() {
        cachedWidth = undefined;
        cachedLines = undefined;
        tui.requestRender();
      }

      function buildAnswer(questionId: string): Answer | undefined {
        const q = questions.find((q) => q.id === questionId);
        if (!q) return undefined;

        const sel = selections.get(questionId);
        if (!sel || sel.size === 0) return undefined;

        const values: AnswerValue[] = [];
        for (const idx of Array.from(sel).sort((a, b) => a - b)) {
          if (idx >= q.options.length) {
            // Other option
            const val = customInputs.get(questionId);
            if (val) {
              values.push({
                value: val,
                label: val,
                wasCustom: true,
              });
            }
          } else {
            const opt = q.options[idx];
            values.push({
              value: opt.value,
              label: opt.label,
              wasCustom: false,
              index: idx + 1,
            });
          }
        }
        if (values.length === 0) return undefined;
        return { id: questionId, values };
      }

      function buildAllAnswers(): Answer[] {
        const result: Answer[] = [];
        for (const q of questions) {
          const ans = buildAnswer(q.id);
          if (ans) result.push(ans);
        }
        return result;
      }

      function submit(cancelled: boolean) {
        done({
          questions,
          answers: cancelled ? [] : buildAllAnswers(),
          cancelled,
        });
      }

      function currentQuestion(): Question | undefined {
        return questions[currentTab];
      }

      function currentOptions(): RenderOption[] {
        const q = currentQuestion();
        if (!q) return [];
        const sel = selections.get(q.id) || new Set<number>();
        const opts: RenderOption[] = q.options.map((o, i) => ({
          ...o,
          isSelected: sel.has(i),
        }));
        const hasCustom = customInputs.has(q.id);
        opts.push({
          value: "__other__",
          label: hasCustom ? customInputs.get(q.id)! : "Type something.",
          isOther: true,
          isSelected: sel.has(q.options.length),
        });
        if (q.multiSelect) {
          opts.push({
            value: "__done__",
            label: "Done",
            isDone: true,
          });
        }
        return opts;
      }

      function allAnswered(): boolean {
        return questions.every((q) =>
          q.multiSelect
            ? confirmed.has(q.id) && buildAnswer(q.id) !== undefined
            : buildAnswer(q.id) !== undefined,
        );
      }

      function advanceAfterAnswer() {
        if (!isMulti) {
          submit(false);
          return;
        }
        if (currentTab < questions.length - 1) {
          currentTab++;
        } else {
          currentTab = questions.length; // Submit tab
        }
        optionIndex = 0;
        refresh();
      }

      // Editor submit callback
      editor.onSubmit = (value) => {
        if (!inputQuestionId) return;
        const trimmed = value.trim() || "(no response)";
        const q = questions.find((q) => q.id === inputQuestionId);
        if (!q) return;

        customInputs.set(inputQuestionId, trimmed);
        confirmed.delete(q.id);
        validationMessage = undefined;

        const otherIdx = q.options.length;
        if (q.multiSelect) {
          const sel = selections.get(inputQuestionId) || new Set<number>();
          sel.add(otherIdx);
          selections.set(inputQuestionId, sel);
        } else {
          selections.set(inputQuestionId, new Set([otherIdx]));
        }

        inputMode = false;
        inputQuestionId = null;
        editor.setText("");

        if (!q.multiSelect) {
          confirmed.add(q.id);
          advanceAfterAnswer();
        } else {
          refresh();
        }
      };

      function toggleSelection(q: Question, optIdx: number) {
        confirmed.delete(q.id);
        validationMessage = undefined;
        const sel = selections.get(q.id) || new Set<number>();
        if (sel.has(optIdx)) {
          sel.delete(optIdx);
          // Also clear custom input if deselecting Other
          if (optIdx >= q.options.length) {
            customInputs.delete(q.id);
          }
        } else {
          sel.add(optIdx);
        }
        if (sel.size === 0) {
          selections.delete(q.id);
        } else {
          selections.set(q.id, sel);
        }
        refresh();
      }

      function handleInput(data: string) {
        // Input mode: route to editor
        if (inputMode) {
          if (matchesKey(data, Key.escape)) {
            inputMode = false;
            inputQuestionId = null;
            editor.setText("");
            refresh();
            return;
          }
          editor.handleInput(data);
          refresh();
          return;
        }

        const q = currentQuestion();
        const opts = currentOptions();

        // Tab navigation (multi-question only)
        if (isMulti) {
          if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
            validationMessage = undefined;
            currentTab = (currentTab + 1) % totalTabs;
            optionIndex = 0;
            refresh();
            return;
          }
          if (
            matchesKey(data, Key.shift("tab")) ||
            matchesKey(data, Key.left)
          ) {
            validationMessage = undefined;
            currentTab = (currentTab - 1 + totalTabs) % totalTabs;
            optionIndex = 0;
            refresh();
            return;
          }
        }

        // Vim tab navigation (multi-question only)
        if (isMulti) {
          if (data === "l") {
            validationMessage = undefined;
            currentTab = (currentTab + 1) % totalTabs;
            optionIndex = 0;
            refresh();
            return;
          }
          if (data === "h") {
            validationMessage = undefined;
            currentTab = (currentTab - 1 + totalTabs) % totalTabs;
            optionIndex = 0;
            refresh();
            return;
          }
        }

        // Submit tab
        if (currentTab === questions.length) {
          if (matchesKey(data, Key.enter) && allAnswered()) {
            submit(false);
          } else if (matchesKey(data, Key.escape)) {
            submit(true);
          }
          return;
        }

        // Option navigation
        if (matchesKey(data, Key.up) || data === "k") {
          optionIndex = Math.max(0, optionIndex - 1);
          refresh();
          return;
        }
        if (matchesKey(data, Key.down) || data === "j") {
          optionIndex = Math.min(opts.length - 1, optionIndex + 1);
          refresh();
          return;
        }
        if (data === "g") {
          optionIndex = 0;
          refresh();
          return;
        }
        if (data === "G") {
          optionIndex = opts.length - 1;
          refresh();
          return;
        }

        // Select / toggle option
        if (matchesKey(data, Key.enter) && q) {
          const opt = opts[optionIndex];
          if (!opt) return;
          if (opt.isOther) {
            inputMode = true;
            inputQuestionId = q.id;
            editor.setText(customInputs.get(q.id) || "");
            refresh();
            return;
          }
          if (opt.isDone) {
            if (!buildAnswer(q.id)) {
              validationMessage =
                "Select at least one option before choosing Done";
              refresh();
              return;
            }
            confirmed.add(q.id);
            validationMessage = undefined;
            advanceAfterAnswer();
            return;
          }
          if (q.multiSelect) {
            toggleSelection(q, optionIndex);
            return;
          }
          // Single-select
          selections.set(q.id, new Set([optionIndex]));
          validationMessage = undefined;
          advanceAfterAnswer();
          return;
        }

        // Space toggles selection in multi-select mode
        if (data === " " && q && q.multiSelect) {
          const opt = opts[optionIndex];
          if (opt && !opt.isDone) {
            if (opt.isOther) {
              inputMode = true;
              inputQuestionId = q.id;
              editor.setText(customInputs.get(q.id) || "");
              refresh();
              return;
            }
            toggleSelection(q, optionIndex);
          }
          return;
        }

        // Cancel
        if (matchesKey(data, Key.escape)) {
          submit(true);
        }
      }

      function render(width: number): string[] {
        if (cachedLines && cachedWidth === width) return cachedLines;

        const lines: string[] = [];
        const renderWidth = Math.max(1, width);
        const q = currentQuestion();
        const opts = currentOptions();

        function addWrapped(text: string) {
          lines.push(...wrapTextWithAnsi(text, renderWidth));
        }

        function addWrappedWithPrefix(prefix: string, text: string) {
          const prefixWidth = visibleWidth(prefix);
          if (prefixWidth >= renderWidth) {
            addWrapped(prefix + text);
            return;
          }
          const wrapped = wrapTextWithAnsi(text, renderWidth - prefixWidth);
          const continuationPrefix = " ".repeat(prefixWidth);
          for (let i = 0; i < wrapped.length; i++) {
            lines.push(
              `${i === 0 ? prefix : continuationPrefix}${wrapped[i]}`,
            );
          }
        }

        lines.push(theme.fg("accent", "─".repeat(renderWidth)));

        // Tab bar (multi-question only)
        if (isMulti) {
          const tabs: string[] = ["← "];
          for (let i = 0; i < questions.length; i++) {
            const isActive = i === currentTab;
            const isAnswered = questions[i].multiSelect
              ? confirmed.has(questions[i].id)
              : selections.has(questions[i].id);
            const lbl = questions[i].label;
            const box = isAnswered ? "■" : "□";
            const color = isAnswered ? "success" : "muted";
            const text = ` ${box} ${lbl} `;
            const styled = isActive
              ? theme.bg("selectedBg", theme.fg("text", text))
              : theme.fg(color, text);
            tabs.push(`${styled} `);
          }
          const canSubmit = allAnswered();
          const isSubmitTab = currentTab === questions.length;
          const submitText = " ✓ Submit ";
          const submitStyled = isSubmitTab
            ? theme.bg("selectedBg", theme.fg("text", submitText))
            : theme.fg(canSubmit ? "success" : "dim", submitText);
          tabs.push(`${submitStyled} →`);
          addWrappedWithPrefix(" ", tabs.join(""));
          lines.push("");
        }

        // Helper to render options list
        function renderOptions() {
          for (let i = 0; i < opts.length; i++) {
            const opt = opts[i];
            const selected = i === optionIndex;
            const isOther = opt.isOther === true;
            const isDone = opt.isDone === true;

            const cursorPrefix = selected ? theme.fg("accent", "> ") : "  ";
            const selectionPrefix = !isDone
              ? q?.multiSelect
                ? opt.isSelected
                  ? "[x] "
                  : "[ ] "
                : opt.isSelected
                  ? theme.fg("success", "✓ ")
                  : "  "
              : "";
            const prefix = cursorPrefix + selectionPrefix;

            const numPrefix = isDone ? "" : `${i + 1}. `;
            const label = `${numPrefix}${opt.label}${isOther && inputMode ? " ✎" : ""}`;
            const color =
              selected || (isOther && inputMode) ? "accent" : "text";

            addWrappedWithPrefix(prefix, theme.fg(color, label));
            if (opt.description) {
              addWrappedWithPrefix(
                "     ",
                theme.fg("muted", opt.description),
              );
            }
          }
        }

        // Content
        if (inputMode && q) {
          addWrappedWithPrefix(" ", theme.fg("text", q.prompt));
          lines.push("");
          // Show options for reference
          renderOptions();
          lines.push("");
          addWrappedWithPrefix(" ", theme.fg("muted", "Your answer:"));
          for (const line of editor.render(Math.max(1, renderWidth - 2))) {
            lines.push(` ${line}`);
          }
          lines.push("");
          addWrappedWithPrefix(
            " ",
            theme.fg("dim", "Enter to submit • Esc to cancel"),
          );
        } else if (currentTab === questions.length) {
          addWrappedWithPrefix(
            " ",
            theme.fg("accent", theme.bold("Ready to submit")),
          );
          lines.push("");
          for (const question of questions) {
            const ans = buildAnswer(question.id);
            if (ans) {
              const parts = ans.values.map((v) => {
                if (v.wasCustom) return `(wrote) ${v.label}`;
                return `${v.index}. ${v.label}`;
              });
              const summary = `${theme.fg("muted", `${question.label}: `)}${theme.fg("text", parts.join(", "))}`;
              addWrappedWithPrefix(" ", summary);
            }
          }
          lines.push("");
          if (allAnswered()) {
            addWrappedWithPrefix(
              " ",
              theme.fg("success", "Press Enter to submit"),
            );
          } else {
            const missing = questions
              .filter((q) =>
                q.multiSelect
                  ? !confirmed.has(q.id)
                  : !selections.has(q.id),
              )
              .map((q) => q.label)
              .join(", ");
            addWrappedWithPrefix(
              " ",
              theme.fg("warning", `Unanswered: ${missing}`),
            );
          }
        } else if (q) {
          addWrappedWithPrefix(" ", theme.fg("text", q.prompt));
          lines.push("");
          renderOptions();
        }

        lines.push("");
        if (validationMessage) {
          addWrappedWithPrefix(" ", theme.fg("warning", validationMessage));
          lines.push("");
        }
        if (!inputMode) {
          let help: string;
          if (isMulti) {
            help = q?.multiSelect
              ? "Tab/h/l navigate • ↑↓/j/k/g/G select • Space/Enter toggle • Esc cancel"
              : "Tab/h/l navigate • ↑↓/j/k/g/G select • Enter confirm • Esc cancel";
          } else {
            help = q?.multiSelect
              ? "↑↓/j/k/g/G select • Space/Enter toggle • Esc cancel"
              : "↑↓/j/k/g/G select • Enter select • Esc cancel";
          }
          addWrappedWithPrefix(" ", theme.fg("dim", help));
        }
        lines.push(theme.fg("accent", "─".repeat(renderWidth)));

        cachedWidth = width;
        cachedLines = lines;
        return lines;
      }

      let focused = false;
      return {
        get focused() {
          return focused;
        },
        set focused(value: boolean) {
          focused = value;
          editor.focused = value;
        },
        render,
        invalidate: () => {
          cachedWidth = undefined;
          cachedLines = undefined;
          editor.invalidate();
        },
        handleInput,
      };
    },
  );

  if (result.cancelled) {
    return {
      content: [{ type: "text", text: "User cancelled the question tool" }],
      details: result,
    };
  }

  return {
    content: [{ type: "text", text: formatAnswers(questions, result.answers) }],
    details: result,
  };
}
