export type ExecFileFn = (cmd: string, args: string[]) => Promise<{
    stdout: string;
    stderr: string;
}>;
export declare function capturePane(paneId: string | number, execFileFn?: ExecFileFn): Promise<string>;
export declare function inject(paneId: string | number, text: string, execFileFn?: ExecFileFn): Promise<void>;
export declare function resolvePaneId(execFileFn?: ExecFileFn): Promise<string>;
//# sourceMappingURL=zellij.d.ts.map