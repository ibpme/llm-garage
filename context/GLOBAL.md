# Global context

Rules that apply to every project, regardless of which coding agent is driving.

## Python

Avoid using system python directly. Use `uv run` or `uv run python` instead, especially if you need external libraries/modules.
