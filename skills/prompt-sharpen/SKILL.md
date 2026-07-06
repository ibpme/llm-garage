---
name: prompt-sharpen
description: Use ONLY when the user explicitly runs /prompt-sharpen or literally says "sharpen this prompt" (or close variants) — do NOT auto-activate just because the user is asking for help writing or improving a prompt. Interviews the user iteratively to turn a rough idea or draft prompt into a direct, concise, specific prompt, then outputs a single refined prompt ready to paste into a new coding-agent session.
---

# Prompt Sharpen

Take a vague or rough prompt idea and turn it into a tight, unambiguous prompt
the user can hand to a coding agent in a fresh session — through a short,
targeted interview, not a one-shot rewrite.

## Setup (once, at the start)

1. Get the starting material: either a rough draft prompt the user already has,
   or just a topic/goal they want to turn into a prompt. Restate it back in one
   sentence to confirm you understood the intent.
2. Do not write the refined prompt yet — first identify what's missing or
   ambiguous (see below).

## The loop

Run a short interview, not a fixed checklist — adapt depth and question count
to how underspecified the starting material is. A already-tight draft may need
only one round; a one-line idea may need two or three.

1. **Scan for gaps** across these dimensions, but only surface the ones that are
   actually unclear or unstated — don't ask about things the user already made
   obvious:
   - **Goal** — what outcome does "done" look like?
   - **Scope/boundaries** — what files, systems, or areas are in vs. out of
     bounds?
   - **Constraints** — language/framework/style requirements, things to avoid,
     backwards-compatibility needs, performance or security constraints.
   - **Context the agent will lack** — prior decisions, why this matters,
     relevant background the user has in their head but didn't write down.
   - **Success criteria** — how will the user (or the agent) know the result is
     right? Tests to pass, behavior to demonstrate, review to satisfy.
   - **Output form** — code change vs. explanation vs. plan vs. artifact;
     verbosity expectations.
2. **Ask well.** If a question tool is available (e.g. `AskUserQuestion` or `question`), use
   it for crisp, scoped questions with concrete options — this is the common
   case in coding-agent sessions. If no such tool exists, ask concise open
   questions instead. Batch a few related questions per round; don't flood.
3. **Push back where it helps.** If the user's draft is internally
   inconsistent, over-broad, or likely to produce a bad result from a coding
   agent (e.g. no success criteria, contradictory constraints), say so plainly
   before moving on — don't just silently absorb it.
4. **Reflect and continue.** After each round, summarize what's now known and
   ask only about what's still open. Stop when the remaining gaps are minor
   enough that a reasonable coding agent could fill them in without
   misfiring, or when the user says it's good enough.

## Final output

When the interview converges, produce exactly one deliverable: the refined
prompt itself, in a fenced code block, ready to copy-paste into a new coding
agent session. Conventions for the refined prompt:

- Written in second person imperative, as if the user is instructing the
  agent directly (not "the user wants..." — write "Do X").
- Direct, concise, specific: concrete file paths, names, and constraints
  where known; no filler, no meta-commentary about the interview that
  produced it.
- Self-contained — a fresh session has no memory of this conversation, so
  include whatever context, constraints, and success criteria the agent will
  need, but nothing superfluous.
- Structured with short sections or a list only if the content genuinely
  benefits from it (multiple distinct constraints, multi-step task); a simple
  ask stays a simple paragraph.

After the code block, add at most one short line noting any open question the
user chose not to resolve (only if one exists) — do not pad with a summary of
the interview.

## Gotchas

- **Explicit-trigger-only.** Only run when the user runs `/prompt-sharpen` or
  literally says "sharpen this prompt" (or a close variant); never self-activate
  just because the user asked for general help writing or improving a prompt.
- **One deliverable only.** Don't produce intermediate draft prompts as
  separate artifacts/files unless the user asks — the interview is
  conversational, the output is a single final code block.
- **Don't over-interview.** If the user's first message is already
  well-specified, skip straight to a light confirmation round or straight to
  output — the goal is a better prompt, not exhaustive process.
- **Never answer the underlying task.** This skill produces a prompt _about_
  the user's task, not a solution to it — don't start writing code or doing
  the work the eventual prompt describes.
