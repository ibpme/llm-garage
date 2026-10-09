import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseSshTarget, SshConnection } from "./transport.ts";

/** Opens a connection. Without an explicit path, the remote cwd is the login directory. */
export async function connectSsh(arg: string): Promise<SshConnection> {
  const { remote, remoteCwd } = parseSshTarget(arg);
  if (remoteCwd !== undefined) return new SshConnection(remote, remoteCwd);
  const home = (await new SshConnection(remote, "").exec("pwd")).toString().trim();
  return new SshConnection(remote, home);
}

/** `Host` aliases from ~/.ssh/config, for /ssh argument hints. Wildcards excluded. */
export function listSshConfigHosts(): string[] {
  try {
    const raw = readFileSync(join(homedir(), ".ssh", "config"), "utf8");
    const hosts = new Set<string>();
    for (const line of raw.split("\n")) {
      const match = line.match(/^\s*Host\s+(.+)$/i);
      if (!match) continue;
      for (const host of match[1].trim().split(/\s+/)) {
        if (host && !host.includes("*") && !host.includes("?")) hosts.add(host);
      }
    }
    return [...hosts];
  } catch {
    return [];
  }
}
