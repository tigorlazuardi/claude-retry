import { defaultConfigDir, type AccountUsage } from './usage.ts';

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
  _target: unknown,
  _snapshot: AccountSnapshot,
  _deps?: unknown,
): Promise<string | null> {
  // TODO phase 2: zellij-server fd->pts + proc tty correlation
  return null;
}
