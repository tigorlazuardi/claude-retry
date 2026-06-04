import { type AccountUsage } from './usage.ts';
import type { PaneTarget } from './zellij.ts';
export interface AccountSnapshot {
    byDir: Map<string, AccountUsage>;
}
export declare function parseConfigDirFromEnviron(buf: string): string | null;
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
interface ClaudeProc {
    pid: string;
    configDir: string;
    pts: string | null;
}
interface ZellijServer {
    session: string;
    pts: Set<string>;
}
export declare function listClaudeProcs(deps: ProcDeps): Promise<ClaudeProc[]>;
export declare function listZellijServers(deps: ProcDeps): Promise<ZellijServer[]>;
export declare function discoverAccountDirs(deps?: Partial<DiscoverDeps>): Promise<string[]>;
export declare function resolvePaneConfigDir(target: PaneTarget, _snapshot: AccountSnapshot, deps?: ProcDeps): Promise<string | null>;
export {};
//# sourceMappingURL=accounts.d.ts.map