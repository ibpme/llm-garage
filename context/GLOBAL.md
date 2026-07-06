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

- Always use `uv` — never system Python or `pip` directly.
- For ad-hoc Python that needs external libraries: `uv run --with some-ext-library`.
- For project-based work: use `uv run`, `uv add`, `uv sync` — never `pip install`.
- For standalone scripts (no project dependency), use the `uv` script shebang with inline metadata:

```python
#!/usr/bin/env -S uv run --script
#
# /// script
# requires-python = ">=3.12"
# dependencies = ["httpx"]  # list actual deps needed
# ///
```

Run via `uv run script.py` or directly as `./script.py` (after `chmod +x`).

- If possible it is encouraged to use type annotations/type hints when writing Python code

## Comments

- Only comment non-obvious logic; avoid redundant or self-evident comments

## Context7

Use Context7 MCP, the context7-mcp or context7-docs skill if available to fetch current documentation whenever you need information about a library, framework, SDK, API, CLI tool, or cloud service -- even well-known ones like React, Next.js, Prisma, Express, Tailwind, Django, or Spring Boot. This includes API syntax, configuration, version migration, library-specific debugging, setup instructions, and CLI tool usage. Use even when you think you know the answer -- your training data may not reflect recent changes. Prefer this over web search for library docs.

DO NOT USE FOR: general questions, general programming concepts, non-programming concepts or debugging business logic. Refer to other web search or fetch tools if available.
