import type {
  BashOperations,
  EditOperations,
  FindOperations,
  GrepOperations,
  LsOperations,
  ReadOperations,
  WriteOperations,
} from "@earendil-works/pi-coding-agent";
import { globToRegExp, shq, SshConnection } from "./transport.ts";

export function createRemoteReadOps(conn: SshConnection, localCwd: string): ReadOperations {
  const toRemote = (p: string) => p.replace(localCwd, conn.remoteCwd);
  return {
    readFile: (p) => conn.exec(`cat ${JSON.stringify(toRemote(p))}`),
    access: (p) => conn.exec(`test -r ${JSON.stringify(toRemote(p))}`).then(() => { }),
    detectImageMimeType: async (p) => {
      try {
        const r = await conn.exec(`file --mime-type -b ${JSON.stringify(toRemote(p))}`);
        const m = r.toString().trim();
        return ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(m) ? m : null;
      } catch {
        return null;
      }
    },
  };
}

export function createRemoteWriteOps(conn: SshConnection, localCwd: string): WriteOperations {
  const toRemote = (p: string) => p.replace(localCwd, conn.remoteCwd);
  return {
    writeFile: async (p, content) => {
      const b64 = Buffer.from(content).toString("base64");
      await conn.exec(`echo ${JSON.stringify(b64)} | base64 -d > ${JSON.stringify(toRemote(p))}`);
    },
    mkdir: (dir) => conn.exec(`mkdir -p ${JSON.stringify(toRemote(dir))}`).then(() => { }),
  };
}

export function createRemoteEditOps(conn: SshConnection, localCwd: string): EditOperations {
  const r = createRemoteReadOps(conn, localCwd);
  const w = createRemoteWriteOps(conn, localCwd);
  return { readFile: r.readFile, access: r.access, writeFile: w.writeFile };
}

export function createRemoteBashOps(conn: SshConnection, localCwd: string): BashOperations {
  const toRemote = (p: string) => p.replace(localCwd, conn.remoteCwd);
  return {
    exec: async (command, cwd, { onData, signal, timeout }) => {
      const result = await conn.run(`cd ${shq(toRemote(cwd))} && ${command}`, {
        onData,
        signal,
        timeoutMs: timeout ? timeout * 1000 : undefined,
      });
      return { exitCode: result.code };
    },
  };
}

/** "MISSING" | "DIR" | "FILE" for a remote path, shared by grep/ls's isDirectory/stat. */
async function remoteStatKind(conn: SshConnection, absolutePath: string): Promise<"MISSING" | "DIR" | "FILE"> {
  const quoted = JSON.stringify(absolutePath);
  const out = await conn.exec(`if [ ! -e ${quoted} ]; then echo MISSING; elif [ -d ${quoted} ]; then echo DIR; else echo FILE; fi`,
  );
  return out.toString().trim() as "MISSING" | "DIR" | "FILE";
}

export function createRemoteGrepOps(conn: SshConnection, localCwd: string): GrepOperations {
  const toRemote = (p: string) => p.replace(localCwd, conn.remoteCwd);
  return {
    isDirectory: async (p) => {
      const kind = await remoteStatKind(conn, toRemote(p));
      if (kind === "MISSING") throw new Error(`No such file or directory: ${p}`);
      return kind === "DIR";
    },
    readFile: async (p) => (await conn.exec(`cat ${JSON.stringify(toRemote(p))}`)).toString(),
  };
}

export function createRemoteLsOps(conn: SshConnection, localCwd: string): LsOperations {
  const toRemote = (p: string) => p.replace(localCwd, conn.remoteCwd);
  return {
    exists: async (p) => (await remoteStatKind(conn, toRemote(p))) !== "MISSING",
    stat: async (p) => {
      const kind = await remoteStatKind(conn, toRemote(p));
      if (kind === "MISSING") throw new Error(`No such file or directory: ${p}`);
      return { isDirectory: () => kind === "DIR" };
    },
    readdir: async (p) => {
      const out = await conn.exec(`ls -A ${JSON.stringify(toRemote(p))}`);
      return out.toString().split("\n").filter(Boolean);
    },
  };
}

/**
 * Best-effort remote find: lists all files under the search root over SSH
 * and glob-matches them locally. Unlike the local find tool (fd-backed),
 * this does not respect .gitignore — the remote host may not have fd/rg
 * available, and shelling out per-.gitignore-rule isn't worth it here.
 */
export function createRemoteFindOps(conn: SshConnection, localCwd: string): FindOperations {
  const toRemote = (p: string) => p.replace(localCwd, conn.remoteCwd);
  return {
    exists: async (p) => (await remoteStatKind(conn, toRemote(p))) !== "MISSING",
    glob: async (pattern, cwd, { ignore, limit }) => {
      const remoteSearchCwd = toRemote(cwd);
      const prune = ignore.map((name) => `-name ${JSON.stringify(name)} -prune -o`).join(" ");
      const out = await conn.exec(`find ${JSON.stringify(remoteSearchCwd)} ${prune} -type f -print 2>/dev/null`,
      );
      const re = globToRegExp(pattern);
      const matches: string[] = [];
      for (const line of out.toString().split("\n")) {
        if (!line) continue;
        const rel = line.startsWith(remoteSearchCwd) ? line.slice(remoteSearchCwd.length + 1) : line;
        if (re.test(rel)) matches.push(rel);
        if (matches.length >= limit) break;
      }
      return matches;
    },
  };
}
