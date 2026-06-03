import { execFile as _execFile } from 'node:child_process';
import { promisify } from 'node:util';
const _execFilePromise = promisify(_execFile);
const defaultExecFile = (cmd, args) => _execFilePromise(cmd, args, { cwd: process.cwd() });
export async function capturePane(paneId, execFileFn = defaultExecFile) {
    const { stdout } = await execFileFn('zellij', [
        'action',
        'dump-screen',
        '--pane-id',
        String(paneId),
    ]);
    return stdout;
}
export async function inject(paneId, text, execFileFn = defaultExecFile) {
    await execFileFn('zellij', ['action', 'write-chars', '--pane-id', String(paneId), text]);
    await execFileFn('zellij', ['action', 'write', '--pane-id', String(paneId), '13']);
}
export async function resolvePaneId(execFileFn = defaultExecFile) {
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
            if (!trimmed)
                continue;
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
    }
    catch {
        // list-clients failed — fall through to list-panes
    }
    // 3. list-panes -j → filter is_plugin=false → find title contains "claude"
    try {
        const { stdout: panesOut } = await execFileFn('zellij', ['action', 'list-panes', '-j']);
        const panes = JSON.parse(panesOut);
        const match = panes.find((p) => !p.is_plugin && p.title?.toLowerCase().includes('claude'));
        if (match !== undefined) {
            return String(match.id);
        }
    }
    catch {
        // list-panes failed — fall through to abort
    }
    // 4. Abort
    throw new Error('Cannot resolve Claude pane ID. Set CLAUDE_PANE_ID env var or --pane-id.');
}
//# sourceMappingURL=zellij.js.map