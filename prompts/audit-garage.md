---
description: Audit whether this coding agent's configs (skills, prompts, memory) are canonical (symlinked from the llm-garage repo) or have drifted.
argument-hint: ""
---

Audit the current coding agent's user-level configuration against the
`llm-garage` source-of-truth repo. This is a **read-only check** -- do not
edit, symlink, move, delete, or run any sync script. Only report back.

Only global memory, skills, and commands/prompts are canonical (synced from
the repo). Subagents, MCP servers, and project-level memory are non-canonical
by design and out of scope for this audit -- don't flag them as drifted.

## Step 1: Locate the repo

Resolve symlinks for the active tool's config to find the repo, e.g.
`readlink ~/.claude/CLAUDE.md` (or the equivalent `AGENTS.md`/skills/commands
path for whichever tool is currently driving). If nothing is symlinked yet,
fall back to searching common locations (`~/Documents/Code/`, `~/code/`,
`~/dev/`, `~/projects/`) for a directory containing `sync/generate.py` and
`context/GLOBAL.md`. If the repo can't be found at all, report that and stop.

## Step 2: Check each category for the active tool

Using the repo's README "Per-tool targets" table to know the expected paths
for the active tool, check:

- **Global memory** (`CLAUDE.md`/`AGENTS.md`): is it a symlink into
  `context/GLOBAL.md` in the repo? If it's a plain file, or a symlink
  pointing somewhere else, it has drifted.
- **Skills**: for each dir under the tool's skills directory, is it a
  symlink into `skills/<name>/` in the repo? Flag any that are plain
  files/dirs (local-only or drifted), and any skills present in the repo but
  missing entirely from the tool's skills dir (not synced).
- **Commands/prompts**: for each file under the tool's commands/prompts
  directory, is it a symlink into the repo's generated `build/<target>/...`
  output (which in turn comes from `prompts/<name>.md`)? Flag plain files or
  broken/missing symlinks the same way.
- **Subagents, MCP servers, project-level memory**: ignore these. They are
  not synced from the repo, and non-canonical/local-only config for them is
  expected and fine.

## Step 3: Report back -- do not fix anything

Summarize findings as three buckets: canonical (in sync), drifted/non-canonical
(exists locally but not a symlink into the repo, or content differs), and
missing/not-synced (in the repo but absent locally, or vice versa).

For each drifted or missing item, suggest a recommended approach (e.g. "move
local content into the repo's canonical path and let sync symlink it back",
"run `./sync/sync-all.sh` to pick up a repo change that hasn't been synced
yet", "this looks like a deliberate one-off local file -- confirm with the
user whether to keep it as-is or fold it into the repo"). Present these as
options, not actions taken.

End with a short summary and the recommended next steps, and stop there --
do not implement any of them. Let the user decide.
