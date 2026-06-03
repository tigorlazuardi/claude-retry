export interface MonitorDeps {
    capture: (paneId: string) => Promise<string>;
    inject: (paneId: string, text: string) => Promise<void>;
    now: () => number;
    sleep: (ms: number) => Promise<void>;
}
export interface MultiMonitorDeps extends MonitorDeps {
    listPanes: () => Promise<string[]>;
    /** Optional sink for chatty progress logs (wired to stderr by the CLI). */
    log?: (msg: string) => void;
}
export type PaneStates = Map<string, MonitorState>;
export type MonitorStatus = 'monitoring' | 'rate-limited' | 'retried' | 'exited';
export interface MonitorState {
    status: 'monitoring' | 'waiting';
    waitUntil: number;
}
export declare function createState(): MonitorState;
export declare function tick(paneId: string, state: MonitorState, deps: MonitorDeps, marginSeconds?: number, fallbackHours?: number): Promise<MonitorStatus>;
export declare function runMonitor(paneId: string, deps: MonitorDeps, pollIntervalMs?: number, marginSeconds?: number, fallbackHours?: number): Promise<void>;
/**
 * One discovery+monitor pass over every live Claude pane.
 *
 * Re-discovers panes each call so new Claude sessions are picked up and
 * closed panes are pruned. Per-pane state lives in `states`, keyed by pane ID,
 * and persists across calls. A failed discovery or a single pane's
 * capture/inject error is swallowed so one bad pane never stops the others.
 */
export declare function multiTick(states: PaneStates, deps: MultiMonitorDeps, marginSeconds?: number, fallbackHours?: number): Promise<void>;
export declare function runMultiMonitor(deps: MultiMonitorDeps, pollIntervalMs?: number, marginSeconds?: number, fallbackHours?: number): Promise<void>;
//# sourceMappingURL=monitor.d.ts.map