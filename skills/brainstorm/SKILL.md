---
name: brainstorm
description: Use ONLY when the user explicitly runs /brainstorm or literally says the word "brainstorm" — do NOT auto-activate on vague, exploratory, or ambiguous prompts by themselves. Facilitates a structured, Socratic session that develops the topic into a concrete, continuously-updated written document through an iterative question-and-feedback loop.
---

# Brainstorm

Turn a vague idea, plan, question, or learning goal into something concrete
through a Socratic, iterative, dialectical loop — and capture the result in a
living document as you go.

## Setup (once, at the start)

1. Confirm the topic in one sentence and reflect it back.
2. Confirm the output document:
   - **Default:** `./notes/<slug>.md` in the current working directory
     (`<slug>` = a short kebab-case name derived from the topic).
   - Let the user override the path, filename, and format.
   - Default format is Markdown. Other formats (html/docx/pdf) are export-only,
     on request — see [Exporting](#exporting-on-request-only).
3. Before creating anything: if the target file already exists, **do not
   overwrite it** — read it and offer to resume that brainstorm from its
   current state. Otherwise create the `notes/` directory if needed and start
   the document from the [template](#document-template), even if mostly empty.
   It is a living artifact from the first exchange.

## The loop

Run a genuine dialogue, not an interview script. Each turn:

1. **Never assume — ask.** When anything is ambiguous, underspecified, or has
   multiple reasonable readings, surface it and ask. Do not silently pick an
   interpretation and move on.
2. **Ask well.** If a question tool is available (e.g. `AskUserQuestion`,
   `ask_user_input`, or any interactive prompt tool), use it for crisp,
   scoped clarifications with concrete options. If no such tool exists, or the
   user wants to go deep on something, ask open-ended questions instead.
3. **Be critical and objective.** Challenge assumptions, offer counterpoints,
   name trade-offs, and probe for gaps and risks. Your job is the best possible
   feedback, not agreement. Push back when something seems weak.
4. **Contribute, don't just extract.** Bring your own ideas, options, and
   framings to the table — propose approaches, offer analogies and prior art,
   and say what you'd choose and why. Brainstorming is bidirectional; don't
   only mine the user's head.
5. **Batch, don't flood.** Ask a few high-value questions at a time; let the
   conversation breathe.
6. **Feed back what you learn.** Synthesize the user's answers, reflect the
   sharper version back, and identify the next open question.
7. **Update the document** after each meaningful exchange (see below).

Prefer procedure over prescription: adapt the order and depth to the topic and
the user's energy. Move between breadth (mapping the space) and depth (drilling
into one thread) deliberately, and say which you're doing.

## The moving document

The document is the running record of the brainstorm, not a final report.

- **Update continuously** — after each meaningful exchange, edit the file so it
  always reflects the current state of thinking, open questions, and decisions.
- **Never auto-finalize.** Do not declare the document "done" or produce a
  distinct "final" version on your own. Keep it in the living, in-progress form
  unless the user explicitly asks you to finalize or clean it up.
- Keep it honest: record open questions and disagreements, not just conclusions.

### Document template

```markdown
# <Topic>

_Brainstorm in progress — last updated <date/time>_

## Intent
<What the user is trying to figure out, do, or learn — in their words, sharpened.>

## Current thinking
<The best current articulation of the idea/plan/answer, evolving over time.>

## Open questions
- [ ] <Unresolved question or ambiguity>

## Options & trade-offs
<Approaches considered, with pros/cons. Note which are favored and why.>

## Decisions
<Things that have been settled, with the reasoning behind them.>

## Research & sources
<Findings from external research, each with a citation/link.>

## Next steps
<Concrete next actions or threads to pursue.>
```

Adapt sections to the topic (e.g. a learning goal may add a "Reading list" or
"Concepts to master"; a plan may add "Milestones"). Drop sections that don't
apply.

## Research augmentation

Be proactive about enriching the conversation with external knowledge — don't
rely only on what you already know.

- Use **whatever research tools are actually available** in this session:
  web search / web fetch, `context7` for library or framework docs, wiki or
  scholarly search, other search integrations, or a research/librarian subagent
  if one exists.
- Bring findings back as feedback: correct misconceptions, surface prior art,
  add data points, and challenge or support the user's direction.
- **Always cite sources** in the document's "Research & sources" section (title
  + link).
- **Degrade gracefully:** if no research tools are available, say so briefly and
  continue with reasoning and questioning. Only use tools that exist.

## Exporting (on request only)

Default output stays Markdown. If the user asks for another format
(html/docx/pdf), convert with `pandoc`, e.g.:

```bash
pandoc notes/<slug>.md -o notes/<slug>.pdf
```

If `pandoc` is not installed, tell the user and keep the Markdown file. Do not
block the brainstorm on export tooling.

## Gotchas

- **Explicit-trigger-only.** Only run when the user says "brainstorm" or runs
  `/brainstorm`; never self-activate from a merely vague prompt.
- **Never clobber an existing doc.** If the target file already exists, read it
  and resume from its current state instead of overwriting — it may be a prior
  brainstorm you didn't create.
- **Resume on return.** When the user asks to continue an earlier brainstorm,
  load the existing notes doc first and pick up from its current state rather
  than starting a new one.
- **Re-anchor from the doc.** Long sessions may drop these instructions from
  context. The notes doc is the durable record — re-read it to recover the
  current state, then keep updating it in place and never auto-finalize.
- **Create `notes/` if missing** before writing the file.
