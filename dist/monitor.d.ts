import type { PaneTarget } from './zellij.ts';
export interface MonitorDeps {
    capture: (paneId: string) => Promise<string>;
    inject: (paneId: string, text: string) => Promise<void>;
    now: () => number;
    sleep: (ms: number) => Promise<void>;
}
/** Deps for watching many Claude panes across sessions. Capture/inject are
 *  addressed by PaneTarget rather than a bare pane id. */
export interface MultiMonitorDeps {
    listTargets: () => Promise<PaneTarget[]>;
    capture: (target: PaneTarget) => Promise<string>;
    inject: (target: PaneTarget, text: string) => Promise<void>;
    now: () => number;
    sleep: (ms: number) => Promise<void>;
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
 * One discovery+monitor pass over every Claude pane in every live session.
 *
 * Re-discovers targets each call so new Claude sessions/panes are picked up and
 * closed ones are pruned. Per-pane state lives in `states`, keyed by the
 * target's label (session:paneId), and persists across calls. A failed
 * discovery or a single pane's capture/inject error is swallowed so one bad
 * pane never stops the others.
 */
export declare function multiTick(states: PaneStates, deps: MultiMonitorDeps, marginSeconds?: number, fallbackHours?: number): Promise<void>;
export declare function runMultiMonitor(deps: MultiMonitorDeps, pollIntervalMs?: number, marginSeconds?: number, fallbackHours?: number): Promise<void>;
//# sourceMappingURL=monitor.d.ts.map