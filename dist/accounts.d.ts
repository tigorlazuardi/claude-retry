import { type AccountUsage } from './usage.ts';
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
export declare function discoverAccountDirs(deps?: Partial<DiscoverDeps>): Promise<string[]>;
export declare function resolvePaneConfigDir(_target: unknown, _snapshot: AccountSnapshot, _deps?: unknown): Promise<string | null>;
//# sourceMappingURL=accounts.d.ts.map