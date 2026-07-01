#!/usr/bin/env python3
"""Pull the current Context7 skill + rule content from Upstash's public
sources (the same ones the `ctx7` setup CLI uses) and diff them against
what's checked into this repo.

This never touches any live tool config -- only this repo's own canonical
files (skills/context7-mcp/SKILL.md, context/GLOBAL.md). Review the result
with `git diff` and commit if it looks right; nothing here auto-commits.

Run manually whenever you want to check for upstream drift.
"""
import json
import os
import re
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SKILL_PATH = os.path.join(ROOT, "skills", "context7-mcp", "SKILL.md")
GLOBAL_MD = os.path.join(ROOT, "context", "GLOBAL.md")

SKILL_META_URL = "https://context7.com/api/v2/skills?project=%2Fupstash%2Fcontext7&skill=context7-mcp"
RULE_URLS = [
    "https://raw.githubusercontent.com/upstash/context7/master/rules/context7-mcp.md",
    "https://raw.githubusercontent.com/upstash/context7/main/rules/context7-mcp.md",
]

MARKER = "<!-- context7 -->"


def fetch(url):
    with urllib.request.urlopen(url, timeout=15) as resp:
        return resp.read().decode("utf-8")


def fetch_rule():
    last_err = None
    for url in RULE_URLS:
        try:
            return fetch(url)
        except Exception as e:
            last_err = e
    raise RuntimeError(f"could not fetch context7 rule from any known URL: {last_err}")


def update_file(path, new_content):
    old_content = ""
    if os.path.isfile(path):
        with open(path) as f:
            old_content = f.read()
    if old_content == new_content:
        return False
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write(new_content)
    return True


def update_global_md_section(rule_text):
    section = f"{MARKER}\n## Context7\n\n{rule_text.strip()}\n{MARKER}\n"
    with open(GLOBAL_MD) as f:
        content = f.read()
    pattern = re.compile(re.escape(MARKER) + r".*?" + re.escape(MARKER) + r"\n?", re.DOTALL)
    if pattern.search(content):
        new_content = pattern.sub(section, content)
    else:
        new_content = content.rstrip("\n") + "\n\n" + section
    return update_file(GLOBAL_MD, new_content)


def main():
    skill_meta = json.loads(fetch(SKILL_META_URL))
    skill_content = fetch(skill_meta["url"])
    rule_content = fetch_rule()

    changed = []
    if update_file(SKILL_PATH, skill_content):
        changed.append(SKILL_PATH)
    if update_global_md_section(rule_content):
        changed.append(GLOBAL_MD)

    if changed:
        print("context7: updated from upstream -- review with 'git diff' before committing:")
        for p in changed:
            print(f"  {os.path.relpath(p, ROOT)}")
    else:
        print("context7: no upstream changes")


if __name__ == "__main__":
    main()
