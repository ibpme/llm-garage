import assert from "node:assert/strict";
import { test } from "node:test";
import { createBashToolDefinition, createReadTool } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import sshExtension from "../ssh.ts";

test("remote tool descriptions identify their action and destination before local defaults", () => {
  const tools: Array<{ name: string; description: string; promptSnippet?: string }> = [];
  const pi = {
    registerFlag() {},
    registerTool(tool: { name: string; description: string; promptSnippet?: string }) { tools.push(tool); },
    registerCommand() {},
    on() {},
  } as unknown as ExtensionAPI;
  sshExtension(pi);

  assert.equal(tools.length, 7);
  assert.equal(new Set(tools.map((tool) => tool.description)).size, 7);
  for (const tool of tools) {
    assert.match(tool.description.split("\n")[0], /SSH remote host connected via \/ssh, not the local machine\./);
  }
  const bash = tools.find((tool) => tool.name === "bash_remote")!.description;
  const read = tools.find((tool) => tool.name === "read_remote")!.description;
  assert.match(bash, /^Execute a shell command on the SSH remote host/);
  assert.match(read, /^Read a file on the SSH remote host/);
  assert.ok(bash.endsWith(createBashToolDefinition(process.cwd()).description));
  assert.ok(read.endsWith(createReadTool(process.cwd()).description));
  const bashSnippet = tools.find((tool) => tool.name === "bash_remote")!.promptSnippet;
  assert.match(bashSnippet!, /Execute bash commands on the SSH remote host/);
  assert.notEqual(bashSnippet, createBashToolDefinition(process.cwd()).promptSnippet);
});
