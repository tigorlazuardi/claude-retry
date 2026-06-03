export type ExecFileFn = (cmd: string, args: string[]) => Promise<{
    stdout: string;
    stderr: string;
}>;
export declare function capturePane(paneId: string | number, execFileFn?: ExecFileFn): Promise<string>;
export declare function inject(paneId: string | number, text: string, execFileFn?: ExecFileFn): Promise<void>;
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