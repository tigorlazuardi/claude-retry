import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseConfigDirFromEnviron,
  discoverAccountDirs,
  resolvePaneConfigDir,
  type AccountSnapshot,
} from '../src/accounts.ts';

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

// --- resolvePaneConfigDir (phase 2 stub) ---

describe('resolvePaneConfigDir', () => {
  test('returns null (phase 2 stub)', async () => {
    const snapshot: AccountSnapshot = { byDir: new Map() };
    const result = await resolvePaneConfigDir('pane-1', snapshot);
    assert.equal(result, null);
  });

  test('returns null regardless of snapshot contents', async () => {
    const snapshot: AccountSnapshot = {
      byDir: new Map([
        ['/x', { limited: true, resetsAtMs: 9999 }],
      ]),
    };
    const result = await resolvePaneConfigDir({ paneId: 'abc' }, snapshot, {});
    assert.equal(result, null);
  });
});
