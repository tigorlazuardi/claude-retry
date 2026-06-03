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
    // Ctrl+C first clears any half-typed input (does not quit Claude), then type + Enter.
    await execFileFn('zellij', ['action', 'write', '--pane-id', String(paneId), '3']);
    await execFileFn('zellij', ['action', 'write-chars', '--pane-id', String(paneId), text]);
    await execFileFn('zellij', ['action', 'write', '--pane-id', String(paneId), '13']);
}
/**
 * List all live zellij session names, skipping EXITED/resurrectable ones and
 * the daemon's own session (ZELLIJ_SESSION_NAME) so it never watches itself.
 */
export async function listSessions(execFileFn = defaultExecFile) {
    const own = process.env['ZELLIJ_SESSION_NAME'];
    const names = [];
    const { stdout } = await execFileFn('zellij', ['list-sessions', '-n']);
    for (const line of stdout.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed)
            continue;
        if (/\(EXITED/.test(trimmed))
            continue; // skip dead/resurrectable sessions
        // Session names may contain spaces ("Rainbow Road"); the name is everything
        // before the " [Created ...]" suffix that zellij appends.
        const idx = trimmed.indexOf(' [');
        const name = (idx >= 0 ? trimmed.slice(0, idx) : trimmed).trim();
        if (!name)
            continue;
        if (own && name === own)
            continue; // never watch our own session
        names.push(name);
    }
    return names;
}
/**
 * Walk every live session and return every non-plugin, non-exited pane as a
 * target. We do NOT try to identify which pane is Claude — pane titles and
 * commands are unreliable (interactive `claude` reports the shell, titles are
 * the cwd). Instead the monitor dumps each pane's screen and only acts on the
 * ones actually showing a rate-limit banner. Works on detached sessions via
 * the global `--session` flag; the daemon's own session is already excluded by
 * listSessions, so its logs are never scanned.
 */
export async function listPaneTargets(execFileFn = defaultExecFile) {
    const sessions = await listSessions(execFileFn);
    const targets = [];
    for (const session of sessions) {
        let panes;
        try {
            const { stdout } = await execFileFn('zellij', [
                '--session',
                session,
                'action',
                'list-panes',
                '-j',
            ]);
            panes = JSON.parse(stdout);
        }
        catch {
            continue; // session vanished or output unparseable — skip this round
        }
        for (const p of panes) {
            if (p.is_plugin || p.exited)
                continue;
            targets.push({ session, paneId: String(p.id), label: `${session}:${p.id}` });
        }
    }
    return targets;
}
/** Dump a target pane's visible screen across sessions. */
export async function captureTarget(t, execFileFn = defaultExecFile) {
    const { stdout } = await execFileFn('zellij', [
        '--session',
        t.session,
        'action',
        'dump-screen',
        '--pane-id',
        t.paneId,
    ]);
    return stdout;
}
/**
 * Inject into a target pane across sessions: Ctrl+C to clear any half-typed
 * input first, then type text + Enter. A single Ctrl+C in Claude Code only
 * clears the input box (shows "Press Ctrl-C again to exit"), it does not quit.
 */
export async function injectTarget(t, text, execFileFn = defaultExecFile) {
    const base = ['--session', t.session, 'action'];
    await execFileFn('zellij', [...base, 'write', '--pane-id', t.paneId, '3']); // Ctrl+C clears input
    await execFileFn('zellij', [...base, 'write-chars', '--pane-id', t.paneId, text]);
    await execFileFn('zellij', [...base, 'write', '--pane-id', t.paneId, '13']); // Enter
}
/** True when a list-clients RUNNING_COMMAND is the `claude` CLI itself.
 *  Excludes `claude-retry` (the monitor's own pane) and other claude-* tools. */
function paneCommandIsClaude(runningCommand) {
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
export async function listClaudePanes(execFileFn = defaultExecFile) {
    const envId = process.env['CLAUDE_PANE_ID'];
    if (envId)
        return [envId];
    const ids = new Set();
    try {
        const { stdout } = await execFileFn('zellij', ['action', 'list-clients']);
        for (const line of stdout.split('\n').slice(1)) {
            const trimmed = line.trim();
            if (!trimmed)
                continue;
            const parts = trimmed.split(/\s+/);
            const paneId = parts[1];
            const runningCommand = parts.slice(2).join(' ');
            if (paneId !== undefined && paneCommandIsClaude(runningCommand)) {
                ids.add(paneId);
            }
        }
    }
    catch {
        // list-clients failed — return what we have; next tick retries.
    }
    return [...ids];
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