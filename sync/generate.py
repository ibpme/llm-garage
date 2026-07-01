#!/usr/bin/env python3
"""Generate per-agent native files from the canonical subagents/ and prompts/ specs.

Run this (or sync-all.sh, which calls it) after editing anything under
subagents/ or prompts/, then re-run the per-target sync-*.sh scripts to
re-link. Output goes to build/, which is regenerated from scratch every run.
"""
import json
import os
import shutil

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SUBAGENTS_DIR = os.path.join(ROOT, "subagents")
PROMPTS_DIR = os.path.join(ROOT, "prompts")
MCP_DIR = os.path.join(ROOT, "mcp")
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


def parse_mcp_spec(path):
    """Parse mcp/<name>/spec.yaml: flat scalar keys only (name, command,
    args as a space-separated string). Not a general YAML parser.
    """
    spec = {}
    with open(path) as f:
        for raw in f:
            line = raw.rstrip("\n")
            if not line.strip() or line.strip().startswith("#"):
                continue
            key, _, val = line.partition(":")
            spec[key.strip()] = val.strip()
    return spec


def gen_mcp():
    """Translate mcp/<name>/spec.yaml (a stdio MCP server: command + args)
    into each target's native fragment. Claude Code and pi share the same
    mcpServers entry shape, so one JSON fragment covers both. Codex's TOML
    table is written as bare key/value lines -- the sync script wraps them
    in a `[mcp_servers.<name>]` header when merging into config.toml, since
    that header also encodes the server name.

    Optional `auth_env` + `auth_flag` keys let a spec take an API key from
    the *local* environment at generate time (e.g. CONTEXT7_API_KEY) rather
    than storing it in the repo -- if the env var isn't set, the flag is
    silently omitted and the server runs in its unauthenticated/anonymous
    mode instead of failing. The resolved value only ever lands in
    build/ (gitignored) and the merged live config file, never in git.

    OpenCode is intentionally not generated here -- it doesn't need one.
    """
    if not os.path.isdir(MCP_DIR):
        return
    for name in sorted(os.listdir(MCP_DIR)):
        d = os.path.join(MCP_DIR, name)
        spec_path = os.path.join(d, "spec.yaml")
        if not os.path.isfile(spec_path):
            continue

        spec = parse_mcp_spec(spec_path)
        command = spec.get("command", "")
        args = [a for a in spec.get("args", "").split(" ") if a]

        auth_env = spec.get("auth_env", "")
        auth_flag = spec.get("auth_flag", "")
        if auth_env and auth_flag:
            auth_value = os.environ.get(auth_env, "")
            if auth_value:
                args = args + [auth_flag, auth_value]

        entry = {"command": command, "args": args}
        entry_json = json.dumps(entry, indent=2) + "\n"
        write(os.path.join(BUILD_DIR, "claude", "mcp", f"{name}.json"), entry_json)
        write(os.path.join(BUILD_DIR, "pi", "mcp", f"{name}.json"), entry_json)

        args_toml = ", ".join(toml_string(a) for a in args)
        toml_lines = [f"command = {toml_string(command)}", f"args = [{args_toml}]"]
        write(os.path.join(BUILD_DIR, "codex", "mcp", f"{name}.toml"),
              "\n".join(toml_lines) + "\n")


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
    gen_mcp()
    print(f"generated into {BUILD_DIR}")


if __name__ == "__main__":
    main()
