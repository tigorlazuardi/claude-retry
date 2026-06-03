export interface MonitorDeps {
    capture: (paneId: string) => Promise<string>;
    inject: (paneId: string, text: string) => Promise<void>;
    now: () => number;
    sleep: (ms: number) => Promise<void>;
}
export type MonitorStatus = 'monitoring' | 'rate-limited' | 'retried' | 'exited';
export interface MonitorState {
    status: 'monitoring' | 'waiting';
    waitUntil: number;
}
export declare function createState(): MonitorState;
export declare function tick(paneId: string, state: MonitorState, deps: MonitorDeps, marginSeconds?: number, fallbackHours?: number): Promise<MonitorStatus>;
export declare function runMonitor(paneId: string, deps: MonitorDeps, pollIntervalMs?: number, marginSeconds?: number, fallbackHours?: number): Promise<void>;
//# sourceMappingURL=monitor.d.ts.map