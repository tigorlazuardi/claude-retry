import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseConfigDirFromEnviron,
  discoverAccountDirs,
  resolvePaneConfigDir,
  listZellijServers,
  listClaudeProcs,
  type AccountSnapshot,
  type ProcDeps,
} from '../src/accounts.ts';
import type { PaneTarget } from '../src/zellij.ts';

const DEFAULT_DIR = '/home/user/.claude';

function makeDiscoverDeps(opts: {
  platform: string;
  procs: Record<string, { cmdline: string; environ?: string }>;
  defaultDir?: string;
}) {
  const dir = opts.defaultDir ?? DEFAULT_DIR;
  return {
    platform: opts.platform,
    defaultDir: () => dir,
    readdir: async (path: string): Promise<string[]> => {
      if (path === '/proc') return Object.keys(opts.procs);
      throw new Error(`unexpected readdir: ${path}`);
    },
    readFile: async (path: string): Promise<string> => {
      for (const [pid, proc] of Object.entries(opts.procs)) {
        if (path === `/proc/${pid}/cmdline`) return proc.cmdline;
        if (path === `/proc/${pid}/environ`) {
          if (proc.environ === undefined) throw new Error('no environ');
          return proc.environ;
        }
      }
      throw new Error(`unexpected readFile: ${path}`);
    },
  };
}

// --- parseConfigDirFromEnviron ---

describe('parseConfigDirFromEnviron', () => {
  test('returns value when CLAUDE_CONFIG_DIR is set', () => {
    const buf = 'HOME=/root\0CLAUDE_CONFIG_DIR=/custom/dir\0PATH=/usr/bin\0';
    assert.equal(parseConfigDirFromEnviron(buf), '/custom/dir');
  });

  test('returns null when CLAUDE_CONFIG_DIR is absent', () => {
    const buf = 'HOME=/root\0PATH=/usr/bin\0TERM=xterm\0';
    assert.equal(parseConfigDirFromEnviron(buf), null);
  });

  test('returns null when CLAUDE_CONFIG_DIR is empty string', () => {
    const buf = 'HOME=/root\0CLAUDE_CONFIG_DIR=\0PATH=/usr/bin\0';
    assert.equal(parseConfigDirFromEnviron(buf), null);
  });

  test('returns null on empty buffer', () => {
    assert.equal(parseConfigDirFromEnviron(''), null);
  });

  test('handles CLAUDE_CONFIG_DIR as only entry (no trailing NUL)', () => {
    const buf = 'CLAUDE_CONFIG_DIR=/x';
    assert.equal(parseConfigDirFromEnviron(buf), '/x');
  });

  test('handles CLAUDE_CONFIG_DIR first in list', () => {
    const buf = 'CLAUDE_CONFIG_DIR=/first\0OTHER=val\0';
    assert.equal(parseConfigDirFromEnviron(buf), '/first');
  });
});

// --- discoverAccountDirs ---

describe('discoverAccountDirs', () => {
  test('non-linux platform returns [defaultDir]', async () => {
    const deps = makeDiscoverDeps({ platform: 'darwin', procs: {} });
    const result = await discoverAccountDirs(deps);
    assert.deepEqual(result, [DEFAULT_DIR]);
  });

  test('linux: no claude procs -> [defaultDir]', async () => {
    const deps = makeDiscoverDeps({
      platform: 'linux',
      procs: {
        '100': { cmdline: 'node\0server.js\0', environ: 'HOME=/root\0' },
        '101': { cmdline: 'bash\0', environ: 'HOME=/root\0' },
      },
    });
    const result = await discoverAccountDirs(deps);
    assert.deepEqual(result, [DEFAULT_DIR]);
  });

  test('linux: claude proc without CLAUDE_CONFIG_DIR -> uses defaultDir, deduplicated', async () => {
    const deps = makeDiscoverDeps({
      platform: 'linux',
      procs: {
        '200': { cmdline: '/usr/bin/claude\0--session\0', environ: 'HOME=/home/user\0PATH=/usr/bin\0' },
      },
    });
    const result = await discoverAccountDirs(deps);
    assert.deepEqual(result, [DEFAULT_DIR]);
  });

  test('linux: claude proc with CLAUDE_CONFIG_DIR -> includes that dir + default', async () => {
    const deps = makeDiscoverDeps({
      platform: 'linux',
      procs: {
        '300': {
          cmdline: '/usr/local/bin/claude\0',
          environ: 'HOME=/home/user\0CLAUDE_CONFIG_DIR=/x\0PATH=/usr/bin\0',
        },
      },
    });
    const result = await discoverAccountDirs(deps);
    assert.equal(result.length, 2);
    assert.ok(result.includes(DEFAULT_DIR));
    assert.ok(result.includes('/x'));
  });

  test('linux: mix of procs - one unset, one with custom dir -> distinct', async () => {
    const deps = makeDiscoverDeps({
      platform: 'linux',
      procs: {
        '400': {
          cmdline: 'node\0/path/to/claude\0',
          environ: 'HOME=/home/user\0',
        },
        '401': {
          cmdline: '/usr/bin/claude\0',
          environ: 'HOME=/home/other\0CLAUDE_CONFIG_DIR=/work/.claude\0',
        },
        '402': {
          cmdline: '/usr/bin/claude\0',
          environ: 'HOME=/home/other\0CLAUDE_CONFIG_DIR=/work/.claude\0',
        },
      },
    });
    const result = await discoverAccountDirs(deps);
    // Should have DEFAULT_DIR and /work/.claude, no duplicates
    const unique = [...new Set(result)];
    assert.equal(unique.length, result.length, 'no duplicates');
    assert.ok(result.includes(DEFAULT_DIR));
    assert.ok(result.includes('/work/.claude'));
    assert.equal(result.length, 2);
  });

  test('linux: /proc readdir throws -> [defaultDir]', async () => {
    const deps = {
      platform: 'linux',
      defaultDir: () => DEFAULT_DIR,
      readdir: async (_path: string): Promise<string[]> => {
        throw new Error('permission denied');
      },
      readFile: async (_path: string): Promise<string> => '',
    };
    const result = await discoverAccountDirs(deps);
    assert.deepEqual(result, [DEFAULT_DIR]);
  });

  test('linux: unreadable environ for one pid -> skip that pid, still return default', async () => {
    const deps = makeDiscoverDeps({
      platform: 'linux',
      procs: {
        '500': {
          cmdline: '/usr/bin/claude\0',
          // no environ key -> readFile throws
        },
      },
    });
    const result = await discoverAccountDirs(deps);
    assert.deepEqual(result, [DEFAULT_DIR]);
  });
});

// --- Helpers for ProcDeps-based tests ---

/**
 * Synthetic /proc layout:
 *   Each entry: pid -> { cmdline, environ?, fd0target?, fds? }
 * fds: map of fd name -> readlink target (for server pts scanning)
 */
interface FakeProcEntry {
  cmdline: string;
  environ?: string;
  fd0target?: string;       // readlink of /proc/<pid>/fd/0
  fds?: Record<string, string>; // fd name -> readlink target
}

function makeProcDeps(opts: {
  platform?: string;
  procs: Record<string, FakeProcEntry>;
}): ProcDeps {
  const procs = opts.procs;
  return {
    platform: opts.platform ?? 'linux',
    listProcPids: async () => Object.keys(procs),
    readCmdline: async (pid: string) => {
      const p = procs[pid];
      if (p === undefined) throw new Error(`no proc ${pid}`);
      return p.cmdline;
    },
    readEnviron: async (pid: string) => {
      const p = procs[pid];
      if (p === undefined || p.environ === undefined) throw new Error(`no environ ${pid}`);
      return p.environ;
    },
    listFds: async (pid: string) => {
      const p = procs[pid];
      if (p === undefined) throw new Error(`no proc ${pid}`);
      return Object.keys(p.fds ?? {});
    },
    readlink: async (path: string) => {
      // /proc/<pid>/fd/<fd>
      const m = path.match(/^\/proc\/(\d+)\/fd\/(.+)$/);
      if (m !== null) {
        const [, pid, fd] = m as [string, string, string];
        const p = procs[pid];
        if (p === undefined) throw new Error(`no proc ${pid}`);
        if (fd === '0') {
          if (p.fd0target === undefined) throw new Error(`no fd0 for ${pid}`);
          return p.fd0target;
        }
        const target = p.fds?.[fd];
        if (target === undefined) throw new Error(`no fd ${fd} for ${pid}`);
        return target;
      }
      throw new Error(`unexpected readlink: ${path}`);
    },
  };
}

// --- listClaudeProcs ---

describe('listClaudeProcs', () => {
  test('pts parsing: /dev/pts/7 kept, non-pts fd ignored', async () => {
    const deps = makeProcDeps({
      procs: {
        '10': {
          cmdline: '/usr/bin/claude\0',
          environ: 'CLAUDE_CONFIG_DIR=/home/a/.claude\0',
          fd0target: '/dev/pts/7',
        },
      },
    });
    const procs = await listClaudeProcs(deps);
    assert.equal(procs.length, 1);
    assert.equal(procs[0]!.pts, '/dev/pts/7');
    assert.equal(procs[0]!.configDir, '/home/a/.claude');
  });

  test('non-pts fd/0 target -> pts null', async () => {
    const deps = makeProcDeps({
      procs: {
        '11': {
          cmdline: '/usr/bin/claude\0',
          environ: 'CLAUDE_CONFIG_DIR=/home/b/.claude\0',
          fd0target: '/dev/null',
        },
      },
    });
    const procs = await listClaudeProcs(deps);
    assert.equal(procs.length, 1);
    assert.equal(procs[0]!.pts, null);
  });

  test('no fd0 -> pts null, does not throw', async () => {
    const deps = makeProcDeps({
      procs: {
        '12': {
          cmdline: '/usr/bin/claude\0',
          environ: '',
        },
      },
    });
    const procs = await listClaudeProcs(deps);
    assert.equal(procs.length, 1);
    assert.equal(procs[0]!.pts, null);
  });
});

// --- listZellijServers ---

describe('listZellijServers', () => {
  test('parses session name from --server path', async () => {
    const deps = makeProcDeps({
      procs: {
        '20': {
          cmdline: 'zellij\0--server\0/run/user/1000/zellij/contract_version_1/My Session\0',
          fds: { '3': '/dev/pts/2', '4': '/dev/pts/5', '5': '/dev/null' },
        },
      },
    });
    const servers = await listZellijServers(deps);
    assert.equal(servers.length, 1);
    assert.equal(servers[0]!.session, 'My Session');
    assert.ok(servers[0]!.pts.has('/dev/pts/2'));
    assert.ok(servers[0]!.pts.has('/dev/pts/5'));
    assert.ok(!servers[0]!.pts.has('/dev/null'));
  });

  test('session name with spaces preserved', async () => {
    const deps = makeProcDeps({
      procs: {
        '21': {
          cmdline: 'zellij\0--server\0/run/user/1000/zellij/contract_version_1/XPrivate Education Development\0',
          fds: {},
        },
      },
    });
    const servers = await listZellijServers(deps);
    assert.equal(servers[0]!.session, 'XPrivate Education Development');
  });

  test('proc without --server skipped', async () => {
    const deps = makeProcDeps({
      procs: {
        '22': { cmdline: 'zellij\0--something\0else\0', fds: {} },
      },
    });
    const servers = await listZellijServers(deps);
    assert.equal(servers.length, 0);
  });
});

// --- resolvePaneConfigDir ---

describe('resolvePaneConfigDir', () => {
  const snapshot: AccountSnapshot = { byDir: new Map() };

  function makeTarget(session: string): PaneTarget {
    return { session, paneId: '1', label: `${session}:1` };
  }

  test('two sessions, each one claude on distinct pts -> resolves right dir per session', async () => {
    const deps = makeProcDeps({
      procs: {
        // session A server
        '100': {
          cmdline: 'zellij\0--server\0/run/user/1000/zellij/contract_version_1/SessionA\0',
          fds: { '3': '/dev/pts/2' },
        },
        // session B server
        '101': {
          cmdline: 'zellij\0--server\0/run/user/1000/zellij/contract_version_1/SessionB\0',
          fds: { '3': '/dev/pts/5' },
        },
        // claude on pts/2 -> account A
        '200': {
          cmdline: '/usr/bin/claude\0',
          environ: 'CLAUDE_CONFIG_DIR=/home/a/.claude\0',
          fd0target: '/dev/pts/2',
        },
        // claude on pts/5 -> account B
        '201': {
          cmdline: '/usr/bin/claude\0',
          environ: 'CLAUDE_CONFIG_DIR=/home/b/.claude\0',
          fd0target: '/dev/pts/5',
        },
      },
    });

    const dirA = await resolvePaneConfigDir(makeTarget('SessionA'), snapshot, deps);
    assert.equal(dirA, '/home/a/.claude');

    const dirB = await resolvePaneConfigDir(makeTarget('SessionB'), snapshot, deps);
    assert.equal(dirB, '/home/b/.claude');
  });

  test('claude with unset CLAUDE_CONFIG_DIR -> returns defaultConfigDir()', async () => {
    const deps = makeProcDeps({
      procs: {
        '110': {
          cmdline: 'zellij\0--server\0/run/user/1000/zellij/contract_version_1/DefaultSession\0',
          fds: { '3': '/dev/pts/3' },
        },
        '210': {
          cmdline: '/usr/bin/claude\0',
          environ: 'HOME=/home/user\0',  // no CLAUDE_CONFIG_DIR
          fd0target: '/dev/pts/3',
        },
      },
    });
    const dir = await resolvePaneConfigDir(makeTarget('DefaultSession'), snapshot, deps);
    // defaultConfigDir() uses process.env['CLAUDE_CONFIG_DIR'] or ~/.claude
    // in tests CLAUDE_CONFIG_DIR not set → falls back to os.homedir()/.claude
    assert.ok(dir !== null);
    assert.ok(dir!.endsWith('/.claude'));
  });

  test('2 claude procs on same session pts with DIFFERENT configDirs -> null (ambiguous)', async () => {
    const deps = makeProcDeps({
      procs: {
        '120': {
          cmdline: 'zellij\0--server\0/run/user/1000/zellij/contract_version_1/AmbigSession\0',
          fds: { '3': '/dev/pts/4', '4': '/dev/pts/6' },
        },
        '220': {
          cmdline: '/usr/bin/claude\0',
          environ: 'CLAUDE_CONFIG_DIR=/home/x/.claude\0',
          fd0target: '/dev/pts/4',
        },
        '221': {
          cmdline: '/usr/bin/claude\0',
          environ: 'CLAUDE_CONFIG_DIR=/home/y/.claude\0',
          fd0target: '/dev/pts/6',
        },
      },
    });
    const dir = await resolvePaneConfigDir(makeTarget('AmbigSession'), snapshot, deps);
    assert.equal(dir, null);
  });

  test('target.session with no matching server -> null', async () => {
    const deps = makeProcDeps({
      procs: {
        '130': {
          cmdline: 'zellij\0--server\0/run/user/1000/zellij/contract_version_1/OtherSession\0',
          fds: { '3': '/dev/pts/1' },
        },
        '230': {
          cmdline: '/usr/bin/claude\0',
          environ: 'CLAUDE_CONFIG_DIR=/home/z/.claude\0',
          fd0target: '/dev/pts/1',
        },
      },
    });
    const dir = await resolvePaneConfigDir(makeTarget('NoSuchSession'), snapshot, deps);
    assert.equal(dir, null);
  });

  test('platform=darwin -> null', async () => {
    const deps = makeProcDeps({
      platform: 'darwin',
      procs: {
        '140': {
          cmdline: 'zellij\0--server\0/run/user/1000/zellij/contract_version_1/SomeSession\0',
          fds: { '3': '/dev/pts/9' },
        },
        '240': {
          cmdline: '/usr/bin/claude\0',
          environ: 'CLAUDE_CONFIG_DIR=/home/m/.claude\0',
          fd0target: '/dev/pts/9',
        },
      },
    });
    const dir = await resolvePaneConfigDir(makeTarget('SomeSession'), snapshot, deps);
    assert.equal(dir, null);
  });
});
