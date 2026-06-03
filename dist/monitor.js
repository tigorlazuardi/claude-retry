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
//# sourceMappingURL=monitor.js.map