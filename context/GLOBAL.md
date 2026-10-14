# User Agent Prerogative

Rules and prerogative that apply to every project, regardless of which coding agent is driving.

## Editing agent configurations (memory, skills, commands)

- This machine's global memory file (`CLAUDE.md`/`AGENTS.md`), skills, and
  commands/prompts are strictly user-only managed symlinks. Never edit them directly without permission.
- Project-scoped config (a repo's own `CLAUDE.md`/`AGENTS.md`, or a
  skills/commands dir inside a repo), subagents, and MCP servers are
  by dynamic by design -- edit those directly, no restriction.

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

## Language Switching

- User default language is English. Only switch when the user requests/permits it.
- You may switch when faced with a task that requires generating or editing other languages, but keep your responses in English.
- Code contents including docs and comments must remain in English.
