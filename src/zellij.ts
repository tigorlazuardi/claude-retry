import { execFile as _execFile } from 'node:child_process';
import { promisify } from 'node:util';

const _execFilePromise = promisify(_execFile);

export type ExecFileFn = (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

const defaultExecFile: ExecFileFn = (cmd, args) =>
  _execFilePromise(cmd, args, { cwd: process.cwd() });

export async function capturePane(
  paneId: string | number,
  execFileFn: ExecFileFn = defaultExecFile,
): Promise<string> {
  const { stdout } = await execFileFn('zellij', [
    'action',
    'dump-screen',
    '--pane-id',
    String(paneId),
  ]);
  return stdout;
}

export async function inject(
  paneId: string | number,
  text: string,
  execFileFn: ExecFileFn = defaultExecFile,
): Promise<void> {
  await execFileFn('zellij', ['action', 'write-chars', '--pane-id', String(paneId), text]);
  await execFileFn('zellij', ['action', 'write', '--pane-id', String(paneId), '13']);
}

/** True when a list-clients RUNNING_COMMAND is the `claude` CLI itself.
 *  Excludes `claude-retry` (the monitor's own pane) and other claude-* tools. */
function paneCommandIsClaude(runningCommand: string): boolean {
  const first = runningCommand.trim().split(/\s+/)[0] ?? '';
  const base = first.split('/').pop() ?? '';
  return base === 'claude';
}

/**
 * Discover every live Claude pane (deduped pane IDs).
 *
 * Honors CLAUDE_PANE_ID as an explicit single-pane override. Otherwise parses
 * `zellij action list-clients` and returns every pane whose RUNNING_COMMAND is
 * the `claude` CLI. Returns [] on failure so the caller can retry next tick.
 */
export async function listClaudePanes(
  execFileFn: ExecFileFn = defaultExecFile,
): Promise<string[]> {
  const envId = process.env['CLAUDE_PANE_ID'];
  if (envId) return [envId];

  const ids = new Set<string>();
  try {
    const { stdout } = await execFileFn('zellij', ['action', 'list-clients']);
    for (const line of stdout.split('\n').slice(1)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parts = trimmed.split(/\s+/);
      const paneId = parts[1];
      const runningCommand = parts.slice(2).join(' ');
      if (paneId !== undefined && paneCommandIsClaude(runningCommand)) {
        ids.add(paneId);
      }
    }
  } catch {
    // list-clients failed — return what we have; next tick retries.
  }
  return [...ids];
}

export async function resolvePaneId(execFileFn: ExecFileFn = defaultExecFile): Promise<string> {
  // 1. Explicit env var
  const envId = process.env['CLAUDE_PANE_ID'];
  if (envId) {
    return envId;
  }

  // 2. list-clients → parse tabular output → find row with "claude" in RUNNING_COMMAND
  try {
    const { stdout: clientsOut } = await execFileFn('zellij', ['action', 'list-clients']);
    const clientsLines = clientsOut.split('\n');
    // Header: CLIENT_ID ZELLIJ_PANE_ID RUNNING_COMMAND
    // Skip header line (index 0), iterate remaining non-empty lines
    for (const line of clientsLines.slice(1)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parts = trimmed.split(/\s+/);
      // parts[0] = CLIENT_ID, parts[1] = ZELLIJ_PANE_ID, parts[2..] = RUNNING_COMMAND
      const runningCommand = parts.slice(2).join(' ');
      if (runningCommand.toLowerCase().includes('claude')) {
        const paneId = parts[1];
        if (paneId !== undefined) {
          return paneId;
        }
      }
    }
  } catch {
    // list-clients failed — fall through to list-panes
  }

  // 3. list-panes -j → filter is_plugin=false → find title contains "claude"
  try {
    const { stdout: panesOut } = await execFileFn('zellij', ['action', 'list-panes', '-j']);
    const panes = JSON.parse(panesOut) as Array<{
      id: number | string;
      is_plugin: boolean;
      title?: string;
    }>;
    const match = panes.find(
      (p) => !p.is_plugin && p.title?.toLowerCase().includes('claude'),
    );
    if (match !== undefined) {
      return String(match.id);
    }
  } catch {
    // list-panes failed — fall through to abort
  }

  // 4. Abort
  throw new Error(
    'Cannot resolve Claude pane ID. Set CLAUDE_PANE_ID env var or --pane-id.',
  );
}
