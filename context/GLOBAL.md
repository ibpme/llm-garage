# Global context

Rules that apply to every project, regardless of which coding agent is driving.

## Editing agent garage config (memory, skills, commands)

This machine's _global_ memory file (`CLAUDE.md`/`AGENTS.md`), skills, and
commands/prompts are symlinks into the source-of-truth repo `llm-garage` --
the only canonical config. Never edit them directly at their synced
location; that bypasses the repo and won't sync to other coding agents.
Project-scoped config (a repo's own `CLAUDE.md`/`AGENTS.md`, or a
skills/commands dir inside a repo), subagents, and MCP servers are
non-canonical by design -- edit those directly, no restriction.

Before touching global memory/skills/commands, use the `config-garage` skill
to locate the repo and the canonical way to change it, then ask the user
before editing the synced location.

## Python

Avoid using system python directly. Use `uv run` or `uv run python` instead, especially if you need external libraries/modules.

<!-- context7 -->

## Context7

Use Context7 MCP to fetch current documentation whenever the user asks about a library, framework, SDK, API, CLI tool, or cloud service -- even well-known ones like React, Next.js, Prisma, Express, Tailwind, Django, or Spring Boot. This includes API syntax, configuration, version migration, library-specific debugging, setup instructions, and CLI tool usage. Use even when you think you know the answer -- your training data may not reflect recent changes. Prefer this over web search for library docs.

Do not use for: refactoring, writing scripts from scratch, debugging business logic, code review, or general programming concepts.

### Steps

1. Always start with `resolve-library-id` using the library name and the user's question, unless the user provides an exact library ID in `/org/project` format
2. Pick the best match (ID format: `/org/project`) by: exact name match, description relevance, code snippet count, source reputation (High/Medium preferred), and benchmark score (higher is better). If results don't look right, try alternate names or queries (e.g., "next.js" not "nextjs", or rephrase the question). Use version-specific IDs when the user mentions a version
3. `query-docs` with the selected library ID and the user's full question (not single words)
4. Answer using the fetched docs
<!-- context7 -->
