import { match } from "./patterns.js";
import { parseResetTime, calculateWaitMs } from "./time-parser.js";
export function createState() {
    return { status: 'monitoring', waitUntil: 0 };
}
/**
 * Core state transition for one pane, given its current screen text.
 * `injectContinue` is called only when a wait period has elapsed. Shared by
 * single-pane (tick) and multi-session (tickTarget) monitoring.
 */
async function stepState(state, screenText, now, injectContinue, marginSeconds, fallbackHours) {
    if (state.status === 'waiting') {
        if (now < state.waitUntil) {
            return 'rate-limited';
        }
        // Wait period elapsed — inject continue
        await injectContinue();
        state.status = 'monitoring';
        state.waitUntil = 0;
        return 'retried';
    }
    // state.status === 'monitoring'
    const result = match(screenText);
    if (result.limited) {
        const resetLine = result.resetLine ?? '';
        const parsed = parseResetTime(resetLine);
        const waitMs = calculateWaitMs(parsed, marginSeconds, fallbackHours, new Date(now));
        state.waitUntil = now + waitMs;
        state.status = 'waiting';
        return 'rate-limited';
    }
    return 'monitoring';
}
export async function tick(paneId, state, deps, marginSeconds, fallbackHours) {
    const screenText = await deps.capture(paneId);
    return stepState(state, screenText, deps.now(), () => deps.inject(paneId, 'continue'), marginSeconds, fallbackHours);
}
async function tickTarget(target, state, deps, marginSeconds, fallbackHours) {
    const screenText = await deps.capture(target);
    return stepState(state, screenText, deps.now(), () => deps.inject(target, 'continue'), marginSeconds, fallbackHours);
}
export async function runMonitor(paneId, deps, pollIntervalMs, marginSeconds, fallbackHours) {
    const state = createState();
    for (;;) {
        await deps.sleep(pollIntervalMs ?? 5000);
        await tick(paneId, state, deps, marginSeconds, fallbackHours);
    }
}
/**
 * One discovery+monitor pass over every Claude pane in every live session.
 *
 * Re-discovers targets each call so new Claude sessions/panes are picked up and
 * closed ones are pruned. Per-pane state lives in `states`, keyed by the
 * target's label (session:paneId), and persists across calls. A failed
 * discovery or a single pane's capture/inject error is swallowed so one bad
 * pane never stops the others.
 */
export async function multiTick(states, deps, marginSeconds, fallbackHours) {
    const log = deps.log ?? (() => { });
    let targets;
    try {
        targets = await deps.listTargets();
    }
    catch {
        // Discovery failed this round — keep existing states, retry next tick.
        log('scan failed: could not list sessions/panes (will retry)');
        return;
    }
    // Prune state for panes that no longer exist.
    const live = new Set(targets.map((t) => t.label));
    for (const key of [...states.keys()]) {
        if (!live.has(key)) {
            states.delete(key);
            log(`${key} gone — dropped from watch`);
        }
    }
    log(targets.length === 0
        ? 'scan: no Claude panes found'
        : `scan: watching ${targets.length} Claude pane(s) [${targets.map((t) => t.label).join(', ')}]`);
    for (const target of targets) {
        let state = states.get(target.label);
        if (!state) {
            state = createState();
            states.set(target.label, state);
            log(`${target.label} — new Claude pane, now watching`);
        }
        const before = state.status;
        try {
            const status = await tickTarget(target, state, deps, marginSeconds, fallbackHours);
            logPaneStatus(log, target.label, before, state, status);
        }
        catch {
            // This pane's capture/inject failed — leave its state, keep going.
            log(`${target.label} — capture/inject error (skipped this round)`);
        }
    }
}
function logPaneStatus(log, label, before, state, status) {
    if (status === 'rate-limited' && before === 'monitoring') {
        const until = new Date(state.waitUntil).toISOString();
        log(`${label} — RATE LIMITED, waiting until ${until}`);
    }
    else if (status === 'rate-limited') {
        log(`${label} — still waiting for reset`);
    }
    else if (status === 'retried') {
        log(`${label} — reset reached, cleared input + injected 'continue'`);
    }
    else {
        log(`${label} — ok`);
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