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
    "ask": "AskUserQuestion",
    "websearch": "WebSearch",
    "webfetch": "WebFetch",
    "task": "Task",
}

# OpenCode has no allow-list -- it's a per-tool boolean deny-map (default
# true if unspecified), with its own tool names for a couple of these.
OPENCODE_TOOL_MAP = {
    "read": "read",
    "edit": "edit",
    "write": "write",
    "bash": "bash",
    "grep": "grep",
    "find": "glob",
    "ls": "list",
    "webfetch": "webfetch",
    "task": "task",
    # "ask" (Claude's AskUserQuestion) and "websearch" have no OpenCode
    # built-in equivalent -- left unmapped so opencode_tools() warns
    # instead of silently granting nothing.
}
# All of OpenCode's built-in tools, so unlisted (denied) ones are turned
# off explicitly rather than left at their true-by-default value.
OPENCODE_ALL_TOOLS = [
    "bash", "edit", "glob", "grep", "list", "patch",
    "read", "task", "todoread", "todowrite", "webfetch", "write",
]

# Codex has no per-tool allow-list at all -- access is governed by
# sandbox_mode (read-only / workspace-write / danger-full-access), which
# blocks filesystem writes regardless of which tool issues them. "bash" is
# deliberately excluded here: read-only sandbox still runs shell commands
# (e.g. grep/find), it just denies writes -- so bash alone isn't a write
# signal, only "write"/"edit" are.
CODEX_WRITE_TOOLS = {"write", "edit"}


NESTED_SPEC_KEYS = ("model", "mcp_tools")


def parse_spec(path):
    """Parse the constrained YAML subset used by subagents/*/spec.yaml:
    flat top-level scalars, plus nested mappings under 'model:' (per-target
    model id) and 'mcp_tools:' (per-target raw MCP tool names/wildcards,
    since those aren't portable across targets -- see gen_subagents).
    Not a general YAML parser -- keep spec.yaml within this shape.
    """
    spec = {}
    nested = {k: {} for k in NESTED_SPEC_KEYS}
    current = None
    with open(path) as f:
        for raw in f:
            line = raw.rstrip("\n")
            if not line.strip() or line.strip().startswith("#"):
                continue
            if line.startswith((" ", "\t")) and current:
                key, _, val = line.strip().partition(":")
                nested[current][key.strip()] = val.strip()
                continue
            current = None
            key, _, val = line.partition(":")
            key = key.strip()
            val = val.strip()
            if key in NESTED_SPEC_KEYS and val == "":
                current = key
                continue
            spec[key] = val
    spec.update(nested)
    return spec


def write(path, content):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write(content)


def claude_tools(tools_csv):
    names = [t.strip() for t in tools_csv.split(",") if t.strip()]
    mapped = []
    for t in names:
        if t not in CLAUDE_TOOL_MAP:
            print(f"warning: tool '{t}' has no claude mapping, passing through as-is")
        m = CLAUDE_TOOL_MAP.get(t, t)
        if m not in mapped:
            mapped.append(m)
    return ", ".join(mapped)


def opencode_tools(tools_csv):
    """Render an OpenCode `tools:` deny-map block from the canonical CSV.
    Unknown canonical names are skipped (with a warning) rather than
    guessed at, since a wrong tool name here silently fails open.
    """
    names = [t.strip() for t in tools_csv.split(",") if t.strip()]
    enabled = set()
    for t in names:
        m = OPENCODE_TOOL_MAP.get(t)
        if m is None:
            print(f"warning: tool '{t}' has no opencode mapping, omitted")
            continue
        enabled.add(m)
    return [f"  {t}: {'true' if t in enabled else 'false'}" for t in OPENCODE_ALL_TOOLS]


def codex_sandbox_mode(tools_csv):
    """Codex has no per-tool allow-list -- translate intent (does this
    subagent need to write?) into a sandbox_mode instead.
    """
    names = {t.strip() for t in tools_csv.split(",") if t.strip()}
    return "workspace-write" if names & CODEX_WRITE_TOOLS else "read-only"


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
        # Raw, per-target tool names/wildcards (mainly for MCP tools, whose
        # names aren't portable: Claude wants "mcp__server__tool", OpenCode
        # wants "server_tool"). Bypasses all translation -- see parse_spec.
        mcp_tools = spec.get("mcp_tools", {})

        # Claude Code: .claude/agents/<name>.md
        fm = ["---", f"name: {name}", f"description: {description}"]
        claude_tool_parts = []
        if tools:
            claude_tool_parts.append(claude_tools(tools))
        if mcp_tools.get("claude"):
            claude_tool_parts.append(mcp_tools["claude"])
        if claude_tool_parts:
            fm.append(f"tools: {', '.join(claude_tool_parts)}")
        if model.get("claude"):
            fm.append(f"model: {model['claude']}")
        fm.append("---")
        write(os.path.join(BUILD_DIR, "claude", "agents", f"{name}.md"),
              "\n".join(fm) + "\n\n" + prompt)

        # OpenCode: agents/<name>.md
        fm = ["---", f"description: {description}"]
        if model.get("opencode"):
            fm.append(f"model: {model['opencode']}")
        opencode_mcp_raw = [t.strip() for t in mcp_tools.get("opencode", "").split(",") if t.strip()]
        if tools or opencode_mcp_raw:
            fm.append("tools:")
            fm.extend(opencode_tools(tools))
            fm.extend(f"  {t}: true" for t in opencode_mcp_raw)
        fm.append("---")
        write(os.path.join(BUILD_DIR, "opencode", "agents", f"{name}.md"),
              "\n".join(fm) + "\n\n" + prompt)

        # pi: agents/<name>.md (pi's native tool/model vocabulary, pass through)
        fm = ["---", f"description: {description}"]
        pi_tool_parts = [p for p in (tools, mcp_tools.get("pi", "")) if p]
        if pi_tool_parts:
            fm.append(f"tools: {', '.join(pi_tool_parts)}")
        if model.get("pi"):
            fm.append(f"model: {model['pi']}")
        if spec.get("thinking"):
            fm.append(f"thinking: {spec['thinking']}")
        if spec.get("max_turns"):
            fm.append(f"max_turns: {spec['max_turns']}")
        fm.append("---")
        write(os.path.join(BUILD_DIR, "pi", "agents", f"{name}.md"),
              "\n".join(fm) + "\n\n" + prompt)

        # Codex CLI: agents/<name>.toml. Codex has no per-agent tool or MCP
        # scoping at all (confirmed against its agent TOML schema: only
        # name/description/model_reasoning_effort/sandbox_mode/
        # developer_instructions -- MCP servers are wired up globally in
        # config.toml, not per role), so mcp_tools.codex can't be honored.
        if mcp_tools.get("codex"):
            print(f"warning: subagent '{name}' sets mcp_tools.codex, but "
                  "Codex has no per-agent tool/MCP scoping -- ignored")
        lines = [f'name = "{name}"', f"description = {toml_string(description)}"]
        if model.get("codex"):
            lines.append(f'model = "{model["codex"]}"')
        if tools:
            lines.append(f'sandbox_mode = "{codex_sandbox_mode(tools)}"')
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
