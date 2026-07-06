---
name: commit
description: Create conventional git commits with precise formatting. Use when the user asks to commit staged changes, generate commit messages, or follow conventional commit standards.
---

# Git Commit Skill

Create well-formatted git commits following conventional commit standards.

## Usage

```
/commit
```

## Commit Workflow

Follow this sequence. Do not skip steps.

1. Inspect changes:
   a. Run `git diff --staged --stat`.
   b. If nothing is staged, inform the user and fall back to unstaged changes: run `git diff --stat`.
   c. Review the file list and propose a staging plan grouped by scope or concern (e.g., `git add src/auth/`, `git add tests/`, `git add docs/`). Ask the user which group to stage, or stage the most logical single group automatically if the grouping is obvious.
   d. Stage the chosen group with `git add <paths>` and re-run `git diff --staged --stat`.
2. Determine if the now-staged changes span unrelated scopes. If yes, suggest splitting into multiple commits first.
3. Pick the single best type from the allowed list below.
4. Determine scope: use the affected module/package/directory name, or **omit entirely** for repo-wide changes.
5. Draft the subject line using the template and constraints below.
6. Run the Validation Checklist. Fix any failures before proceeding.
7. Add a body only if the "why" is not obvious from the subject.
8. Add footers only if needed (breaking changes, issue refs, co-authors).
9. Execute:
   - Single-line message: `git commit -m "<message>"`
   - Multi-line message: `git commit -F-` with a heredoc, or a temporary file.

## Commit Format Template

Pattern-match against this exact structure. Omit empty optional lines.

```
<type>(<scope>): <imperative description>

[optional body]

[optional footer(s)]
```

## Types

Allowed types. Pick the single best fit. Do not invent new ones.

- **feat**: New feature or capability
- **fix**: Bug fix
- **perf**: Performance improvement
- **refactor**: Code change that neither fixes a bug nor adds a feature
- **style**: Code style changes (formatting, semicolons, etc.) with no logic change
- **test**: Adding or correcting tests
- **docs**: Documentation-only changes
- **build**: Build system or dependency changes
- **ci**: CI/CD configuration and scripts
- **chore**: Maintenance tasks not covered above
- **revert**: Reverting a previous commit

## Scope Rules

- **Include** a scope when the change is localized to one module, package, or directory.  
  Examples: `feat(auth)`, `fix(api)`, `docs(readme)`.
- **Omit** the scope entirely (including the parentheses) for repo-wide, cross-cutting, or multi-module changes.  
  Example: `feat: add CI pipeline`.
- **Never leave empty parentheses**: use `feat: thing` not `feat(): thing`.

## Subject Line Constraints

The subject line is fragile. Follow these rules exactly.

- **Mood**: Imperative. Use "add", "fix", "update", "remove" — never "added", "adds", "fixed", "fixing".
- **Length**: Maximum 50 characters, measured from the first letter after the type/scope prefix.
- **Punctuation**: No trailing period.
- **Capitalization**: Lowercase first letter after the colon (unless it's a proper noun or acronym).

## Body and Footer Rules

- **Body**: Add only when the reasoning isn't obvious. Use short paragraphs or imperative bullets (`- `). Wrap lines at 72 characters.
- **Footers**: Each footer on its own line, separated from the body by a blank line.
  - **Breaking change**: Append `!` to the type/scope (`feat(api)!: remove v1 endpoint`) **and/or** include a `BREAKING CHANGE: <description>` footer. Prefer `!` for simple cases; add the footer for detailed explanations.
  - **Issue references**: `Fixes #123`, `Closes #456`
  - **Co-authors**: `Co-authored-by: Name <email@example.com>`

## Gotchas

- **Past-tense slips**: Agents frequently write "added" or "fixed" in subjects. Always correct to imperative "add" / "fix".
- **Empty scope**: Do not write `feat(): description`. Either pick a scope or omit the parentheses completely.
- **Line length**: The agent will almost always exceed 50/72 chars unless explicitly checked. Count characters or estimate visually.
- **Periods in subject**: Never end the subject description with a period.
- **Body verbosity**: If the diff is trivial (e.g., single file, obvious change), do not add a body. The subject should stand alone.
- **Amend awareness**: If the user is correcting the very last commit and the diff is tiny, prefer `git commit --amend --no-edit` (for message-only fixes) or `git commit --amend -m "<new message>"` instead of a new commit. Only amend if the user implies they are fixing the previous commit.
- **No-verify escape hatch**: If pre-commit hooks (Husky, lint-staged) are failing and blocking the commit, add `--no-verify` to the commit command and warn the user that checks were bypassed.

## Validation Checklist

Before executing `git commit`, verify. Fix failures before proceeding.

- [ ] Subject is imperative (add/fix/update/remove, not added/fixed/updated/removed)
- [ ] Subject ≤ 50 characters (excluding type/scope prefix)
- [ ] No empty scope `()`
- [ ] No trailing period in subject
- [ ] Body lines ≤ 72 characters (if body present)
- [ ] Type is in the allowed list
- [ ] Breaking changes use `!` syntax or `BREAKING CHANGE:` footer

## Example

```
feat(auth): add password reset flow

- Validate token expiry before allowing reset
- Enforce minimum 12 character requirement

Fixes #892
```
