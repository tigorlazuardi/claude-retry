import { match } from "./patterns.js";
import { parseResetTime, calculateWaitMs } from "./time-parser.js";
export function createState() {
    return { status: 'monitoring', waitUntil: 0 };
}
export async function tick(paneId, state, deps, marginSeconds, fallbackHours) {
    const screenText = await deps.capture(paneId);
    if (state.status === 'waiting') {
        if (deps.now() < state.waitUntil) {
            return 'rate-limited';
        }
        // Wait period elapsed — inject continue
        await deps.inject(paneId, 'continue');
        state.status = 'monitoring';
        state.waitUntil = 0;
        return 'retried';
    }
    // state.status === 'monitoring'
    const result = match(screenText);
    if (result.limited) {
        const resetLine = result.resetLine ?? '';
        const parsed = parseResetTime(resetLine);
        const waitMs = calculateWaitMs(parsed, marginSeconds, fallbackHours, new Date(deps.now()));
        state.waitUntil = deps.now() + waitMs;
        state.status = 'waiting';
        return 'rate-limited';
    }
    return 'monitoring';
}
export async function runMonitor(paneId, deps, pollIntervalMs, marginSeconds, fallbackHours) {
    const state = createState();
    for (;;) {
        await deps.sleep(pollIntervalMs ?? 5000);
        await tick(paneId, state, deps, marginSeconds, fallbackHours);
    }
}
/**
 * One discovery+monitor pass over every live Claude pane.
 *
 * Re-discovers panes each call so new Claude sessions are picked up and
 * closed panes are pruned. Per-pane state lives in `states`, keyed by pane ID,
 * and persists across calls. A failed discovery or a single pane's
 * capture/inject error is swallowed so one bad pane never stops the others.
 */
export async function multiTick(states, deps, marginSeconds, fallbackHours) {
    const log = deps.log ?? (() => { });
    let panes;
    try {
        panes = await deps.listPanes();
    }
    catch {
        // Discovery failed this round — keep existing states, retry next tick.
        log('scan failed: could not list panes (will retry)');
        return;
    }
    // Prune state for panes that no longer exist.
    const live = new Set(panes);
    for (const id of [...states.keys()]) {
        if (!live.has(id)) {
            states.delete(id);
            log(`pane ${id} gone — dropped from watch`);
        }
    }
    log(panes.length === 0
        ? 'scan: no Claude panes found'
        : `scan: watching ${panes.length} Claude pane(s) [${panes.join(', ')}]`);
    for (const id of panes) {
        let state = states.get(id);
        if (!state) {
            state = createState();
            states.set(id, state);
            log(`pane ${id} — new Claude session, now watching`);
        }
        const before = state.status;
        try {
            const status = await tick(id, state, deps, marginSeconds, fallbackHours);
            logPaneStatus(log, id, before, state, status);
        }
        catch {
            // This pane's capture/inject failed — leave its state, keep going.
            log(`pane ${id} — capture/inject error (skipped this round)`);
        }
    }
}
function logPaneStatus(log, id, before, state, status) {
    if (status === 'rate-limited' && before === 'monitoring') {
        const until = new Date(state.waitUntil).toISOString();
        log(`pane ${id} — RATE LIMITED, waiting until ${until}`);
    }
    else if (status === 'rate-limited') {
        log(`pane ${id} — still waiting for reset`);
    }
    else if (status === 'retried') {
        log(`pane ${id} — reset reached, injected 'continue'`);
    }
    else {
        log(`pane ${id} — ok`);
    }
}
export async function runMultiMonitor(deps, pollIntervalMs, marginSeconds, fallbackHours) {
    const states = new Map();
    for (;;) {
        await deps.sleep(pollIntervalMs ?? 60000);
        await multiTick(states, deps, marginSeconds, fallbackHours);
    }
}
//# sourceMappingURL=monitor.js.map