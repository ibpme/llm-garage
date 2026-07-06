# User Agent Prerogative

Rules and prerogative that apply to every project, regardless of which coding agent is driving.

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

## Context7

Use Context7 MCP, the context7-mcp or context7-docs skill if available to fetch current documentation whenever you need information about a library, framework, SDK, API, CLI tool, or cloud service -- even well-known ones like React, Next.js, Prisma, Express, Tailwind, Django, or Spring Boot. This includes API syntax, configuration, version migration, library-specific debugging, setup instructions, and CLI tool usage. Use even when you think you know the answer -- your training data may not reflect recent changes. Prefer this over web search for library docs.

DO NOT USE FOR: general questions, general programming concepts, non-programming concepts or debugging business logic. Refer to other web search or fetch tools if available.
