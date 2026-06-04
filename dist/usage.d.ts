export interface WindowUsage {
    utilization: number;
    resetsAtMs: number | null;
}
export interface AccountUsage {
    limited: boolean;
    resetsAtMs: number | null;
}
export type FetchFn = (url: string, init: {
    headers: Record<string, string>;
}) => Promise<{
    status: number;
    json: () => Promise<unknown>;
}>;
export type ReadFileFn = (path: string) => Promise<string>;
export declare const LIMIT_THRESHOLD: number;
export declare function defaultConfigDir(env?: NodeJS.ProcessEnv): string;
export declare function readAccessToken(configDir: string, readFile?: ReadFileFn): Promise<{
    token: string;
    expiresAtMs: number | null;
} | null>;
export declare function fetchUsage(token: string, fetchFn?: FetchFn, threshold?: number): Promise<AccountUsage | null>;
//# sourceMappingURL=usage.d.ts.map