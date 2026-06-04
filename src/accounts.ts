import { defaultConfigDir, type AccountUsage } from './usage.ts';
import type { PaneTarget } from './zellij.ts';

export interface AccountSnapshot {
  byDir: Map<string, AccountUsage>;
}

export function parseConfigDirFromEnviron(buf: string): string | null {
  const entries = buf.split('\0');
  for (const entry of entries) {
    if (entry.startsWith('CLAUDE_CONFIG_DIR=')) {
      const val = entry.slice('CLAUDE_CONFIG_DIR='.length);
      return val.length > 0 ? val : null;
    }
  }
  return null;
}

export interface DiscoverDeps {
  platform: string;
  readdir: (path: string) => Promise<string[]>;
  readFile: (path: string) => Promise<string>;
  defaultDir: () => string;
}

export interface ProcDeps {
  platform?: string;
  listProcPids: () => Promise<string[]>;
  readCmdline: (pid: string) => Promise<string>;
  readEnviron: (pid: string) => Promise<string>;
  listFds: (pid: string) => Promise<string[]>;
  readlink: (path: string) => Promise<string>;
}

function defaultProcDeps(): ProcDeps {
  return {
    platform: process.platform,
    listProcPids: async () => {
      const { readdir } = await import('node:fs/promises');
      const entries = await readdir('/proc');
      return entries.filter(e => /^\d+$/.test(e));
    },
    readCmdline: async (pid: string) => {
      const { readFile } = await import('node:fs/promises');
      return readFile(`/proc/${pid}/cmdline`, 'utf8');
    },
    readEnviron: async (pid: string) => {
      const { readFile } = await import('node:fs/promises');
      return readFile(`/proc/${pid}/environ`, 'utf8');
    },
    listFds: async (pid: string) => {
      const { readdir } = await import('node:fs/promises');
      return readdir(`/proc/${pid}/fd`);
    },
    readlink: async (path: string) => {
      const { readlink } = await import('node:fs/promises');
      return readlink(path);
    },
  };
}

interface ClaudeProc {
  pid: string;
  configDir: string;
  pts: string | null;
}

interface ZellijServer {
  session: string;
  pts: Set<string>;
}

const CONTRACT_VERSION_SEG = '/contract_version_1/';

export async function listClaudeProcs(deps: ProcDeps): Promise<ClaudeProc[]> {
  const result: ClaudeProc[] = [];
  let pids: string[];
  try {
    pids = await deps.listProcPids();
  } catch {
    return result;
  }

  await Promise.all(pids.map(async pid => {
    try {
      const cmdline = await deps.readCmdline(pid);
      if (!cmdline.includes('claude')) return;

      let configDir: string;
      try {
        const environ = await deps.readEnviron(pid);
        configDir = parseConfigDirFromEnviron(environ) ?? defaultConfigDir();
      } catch {
        configDir = defaultConfigDir();
      }

      let pts: string | null = null;
      try {
        const target = await deps.readlink(`/proc/${pid}/fd/0`);
        if (/^\/dev\/pts\/\d+$/.test(target)) {
          pts = target;
        }
      } catch {
        // fd/0 unreadable — pts stays null
      }

      result.push({ pid, configDir, pts });
    } catch {
      // skip unreadable pid
    }
  }));

  return result;
}

export async function listZellijServers(deps: ProcDeps): Promise<ZellijServer[]> {
  const result: ZellijServer[] = [];
  let pids: string[];
  try {
    pids = await deps.listProcPids();
  } catch {
    return result;
  }

  await Promise.all(pids.map(async pid => {
    try {
      const cmdline = await deps.readCmdline(pid);
      const args = cmdline.split('\0');
      const serverIdx = args.indexOf('--server');
      if (serverIdx === -1) return;

      const serverPath = args[serverIdx + 1];
      if (serverPath === undefined) return;

      const idx = serverPath.lastIndexOf(CONTRACT_VERSION_SEG);
      if (idx === -1) return;

      const session = serverPath.slice(idx + CONTRACT_VERSION_SEG.length).trimEnd();
      if (!session) return;

      const pts = new Set<string>();
      try {
        const fds = await deps.listFds(pid);
        await Promise.all(fds.map(async fd => {
          try {
            const target = await deps.readlink(`/proc/${pid}/fd/${fd}`);
            if (/^\/dev\/pts\/\d+$/.test(target)) {
              pts.add(target);
            }
          } catch {
            // skip unreadable fd
          }
        }));
      } catch {
        // listFds failed — server with empty pts still recorded
      }

      result.push({ session, pts });
    } catch {
      // skip unreadable pid
    }
  }));

  return result;
}

export async function discoverAccountDirs(deps?: Partial<DiscoverDeps>): Promise<string[]> {
  const platform = deps?.platform ?? process.platform;
  const readdirFn = deps?.readdir ?? (async (p: string) => {
    const { readdir } = await import('node:fs/promises');
    return readdir(p);
  });
  const readFileFn = deps?.readFile ?? (async (p: string) => {
    const { readFile } = await import('node:fs/promises');
    return readFile(p, 'utf8');
  });
  const defaultDir = deps?.defaultDir ?? (() => defaultConfigDir());

  const base = defaultDir();
  const dirs = new Set<string>([base]);

  if (platform !== 'linux') {
    return [base];
  }

  try {
    const entries = await readdirFn('/proc');
    const pids = entries.filter(e => /^\d+$/.test(e));

    await Promise.all(pids.map(async pid => {
      try {
        const cmdline = await readFileFn(`/proc/${pid}/cmdline`);
        if (!cmdline.includes('claude')) return;
        const environ = await readFileFn(`/proc/${pid}/environ`);
        const dir = parseConfigDirFromEnviron(environ) ?? base;
        dirs.add(dir);
      } catch {
        // skip unreadable pids
      }
    }));
  } catch {
    // /proc unreadable or other failure → return default only
    return [base];
  }

  return Array.from(dirs);
}

export async function resolvePaneConfigDir(
  target: PaneTarget,
  _snapshot: AccountSnapshot,
  deps?: ProcDeps,
): Promise<string | null> {
  try {
    const d = deps ?? defaultProcDeps();
    const platform = d.platform ?? process.platform;

    if (platform !== 'linux') return null;

    const [servers, claudeProcs] = await Promise.all([
      listZellijServers(d),
      listClaudeProcs(d),
    ]);

    const server = servers.find(s => s.session === target.session);
    if (server === undefined) return null;

    const dirs = new Set<string>();
    for (const proc of claudeProcs) {
      if (proc.pts !== null && server.pts.has(proc.pts)) {
        dirs.add(proc.configDir);
      }
    }

    if (dirs.size === 1) {
      return [...dirs][0]!;
    }
    return null;
  } catch {
    return null;
  }
}
