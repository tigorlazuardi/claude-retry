export type ExecFileFn = (cmd: string, args: string[]) => Promise<{
    stdout: string;
    stderr: string;
}>;
export declare function capturePane(paneId: string | number, execFileFn?: ExecFileFn): Promise<string>;
export declare function inject(paneId: string | number, text: string, execFileFn?: ExecFileFn): Promise<void>;
/**
 * A single Claude pane to watch, addressable across zellij sessions.
 * `label` is a stable human-readable key (session:paneId) used for state
 * tracking and logs.
 */
export interface PaneTarget {
    session: string;
    paneId: string;
    label: string;
}
/**
 * List all live zellij session names, skipping EXITED/resurrectable ones and
 * the daemon's own session (ZELLIJ_SESSION_NAME) so it never watches itself.
 */
export declare function listSessions(execFileFn?: ExecFileFn): Promise<string[]>;
/**
 * Walk every live session and return every non-plugin, non-exited pane as a
 * target. We do NOT try to identify which pane is Claude — pane titles and
 * commands are unreliable (interactive `claude` reports the shell, titles are
 * the cwd). Instead the monitor dumps each pane's screen and only acts on the
 * ones actually showing a rate-limit banner. Works on detached sessions via
 * the global `--session` flag; the daemon's own session is already excluded by
 * listSessions, so its logs are never scanned.
 */
export declare function listPaneTargets(execFileFn?: ExecFileFn): Promise<PaneTarget[]>;
/** Dump a target pane's visible screen across sessions. */
export declare function captureTarget(t: PaneTarget, execFileFn?: ExecFileFn): Promise<string>;
/**
 * Inject into a target pane across sessions: Ctrl+C to clear any half-typed
 * input first, then type text + Enter. A single Ctrl+C in Claude Code only
 * clears the input box (shows "Press Ctrl-C again to exit"), it does not quit.
 */
export declare function injectTarget(t: PaneTarget, text: string, execFileFn?: ExecFileFn): Promise<void>;
/**
 * Discover every live Claude pane (deduped pane IDs).
 *
 * Honors CLAUDE_PANE_ID as an explicit single-pane override. Otherwise parses
 * `zellij action list-clients` and returns every pane whose RUNNING_COMMAND is
 * the `claude` CLI. Returns [] on failure so the caller can retry next tick.
 */
export declare function listClaudePanes(execFileFn?: ExecFileFn): Promise<string[]>;
export declare function resolvePaneId(execFileFn?: ExecFileFn): Promise<string>;
//# sourceMappingURL=zellij.d.ts.map