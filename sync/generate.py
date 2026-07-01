#!/usr/bin/env python3
"""Generate per-agent native files from the canonical subagents/ and prompts/ specs.

Run this (or sync-all.sh, which calls it) after editing anything under
subagents/ or prompts/, then re-run the per-target sync-*.sh scripts to
re-link. Output goes to build/, which is regenerated from scratch every run.
"""
import os
import shutil

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SUBAGENTS_DIR = os.path.join(ROOT, "subagents")
PROMPTS_DIR = os.path.join(ROOT, "prompts")
BUILD_DIR = os.path.join(ROOT, "build")

# Canonical tool vocabulary (matches pi's native names) mapped to each
# target's own tool names. Best-effort: extend as you hit gaps.
CLAUDE_TOOL_MAP = {
    "read": "Read",
    "edit": "Edit",
    "write": "Write",
    "bash": "Bash",
    "grep": "Grep",
    "find": "Glob",
    "ls": "Bash",
}


def parse_spec(path):
    """Parse the constrained YAML subset used by subagents/*/spec.yaml:
    flat top-level scalars, plus one nested 'model:' mapping. Not a general
    YAML parser -- keep spec.yaml within this shape.
    """
    spec = {}
    model = {}
    in_model = False
    with open(path) as f:
        for raw in f:
            line = raw.rstrip("\n")
            if not line.strip() or line.strip().startswith("#"):
                continue
            if line.startswith((" ", "\t")) and in_model:
                key, _, val = line.strip().partition(":")
                model[key.strip()] = val.strip()
                continue
            in_model = False
            key, _, val = line.partition(":")
            key = key.strip()
            val = val.strip()
            if key == "model" and val == "":
                in_model = True
                continue
            spec[key] = val
    spec["model"] = model
    return spec


def write(path, content):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write(content)


def claude_tools(tools_csv):
    names = [t.strip() for t in tools_csv.split(",") if t.strip()]
    mapped = []
    for t in names:
        m = CLAUDE_TOOL_MAP.get(t, t)
        if m not in mapped:
            mapped.append(m)
    return ", ".join(mapped)


def toml_string(s):
    escaped = s.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n")
    return f'"{escaped}"'


def gen_subagents():
    if not os.path.isdir(SUBAGENTS_DIR):
        return
    for name in sorted(os.listdir(SUBAGENTS_DIR)):
        d = os.path.join(SUBAGENTS_DIR, name)
        spec_path = os.path.join(d, "spec.yaml")
        prompt_path = os.path.join(d, "prompt.md")
        if not os.path.isfile(spec_path):
            continue

        spec = parse_spec(spec_path)
        prompt = ""
        if os.path.isfile(prompt_path):
            prompt = open(prompt_path).read().strip() + "\n"

        model = spec.get("model", {})
        description = spec.get("description", "")
        tools = spec.get("tools", "")

        # Claude Code: .claude/agents/<name>.md
        fm = ["---", f"name: {name}", f"description: {description}"]
        if tools:
            fm.append(f"tools: {claude_tools(tools)}")
        if model.get("claude"):
            fm.append(f"model: {model['claude']}")
        fm.append("---")
        write(os.path.join(BUILD_DIR, "claude", "agents", f"{name}.md"),
              "\n".join(fm) + "\n\n" + prompt)

        # OpenCode: agents/<name>.md
        fm = ["---", f"description: {description}"]
        if model.get("opencode"):
            fm.append(f"model: {model['opencode']}")
        fm.append("---")
        write(os.path.join(BUILD_DIR, "opencode", "agents", f"{name}.md"),
              "\n".join(fm) + "\n\n" + prompt)

        # pi: agents/<name>.md (pi's native tool/model vocabulary, pass through)
        fm = ["---", f"description: {description}"]
        if tools:
            fm.append(f"tools: {tools}")
        if model.get("pi"):
            fm.append(f"model: {model['pi']}")
        if spec.get("thinking"):
            fm.append(f"thinking: {spec['thinking']}")
        if spec.get("max_turns"):
            fm.append(f"max_turns: {spec['max_turns']}")
        fm.append("---")
        write(os.path.join(BUILD_DIR, "pi", "agents", f"{name}.md"),
              "\n".join(fm) + "\n\n" + prompt)

        # Codex CLI: agents/<name>.toml
        lines = [f'name = "{name}"', f"description = {toml_string(description)}"]
        if model.get("codex"):
            lines.append(f'model = "{model["codex"]}"')
        lines.append(f"developer_instructions = {toml_string(prompt)}")
        write(os.path.join(BUILD_DIR, "codex", "agents", f"{name}.toml"),
              "\n".join(lines) + "\n")


def gen_prompts():
    if not os.path.isdir(PROMPTS_DIR):
        return
    for fname in sorted(os.listdir(PROMPTS_DIR)):
        if not fname.endswith(".md"):
            continue
        content = open(os.path.join(PROMPTS_DIR, fname)).read()

        # Body + frontmatter (description/argument-hint) are compatible
        # as-is across all four; pass through unchanged.
        write(os.path.join(BUILD_DIR, "claude", "commands", fname), content)
        write(os.path.join(BUILD_DIR, "codex", "prompts", fname), content)
        write(os.path.join(BUILD_DIR, "pi", "prompts", fname), content)
        write(os.path.join(BUILD_DIR, "opencode", "commands", fname), content)


def main():
    if os.path.isdir(BUILD_DIR):
        shutil.rmtree(BUILD_DIR)
    gen_subagents()
    gen_prompts()
    print(f"generated into {BUILD_DIR}")


if __name__ == "__main__":
    main()
