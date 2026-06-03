import { match } from './patterns.ts';
import { parseResetTime, calculateWaitMs } from './time-parser.ts';

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

export function createState(): MonitorState {
  return { status: 'monitoring', waitUntil: 0 };
}

export async function tick(
  paneId: string,
  state: MonitorState,
  deps: MonitorDeps,
  marginSeconds?: number,
  fallbackHours?: number,
): Promise<MonitorStatus> {
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
    const waitMs = calculateWaitMs(
      parsed,
      marginSeconds,
      fallbackHours,
      new Date(deps.now()),
    );
    state.waitUntil = deps.now() + waitMs;
    state.status = 'waiting';
    return 'rate-limited';
  }

  return 'monitoring';
}

export async function runMonitor(
  paneId: string,
  deps: MonitorDeps,
  pollIntervalMs?: number,
  marginSeconds?: number,
  fallbackHours?: number,
): Promise<void> {
  const state = createState();
  for (;;) {
    await deps.sleep(pollIntervalMs ?? 5000);
    await tick(paneId, state, deps, marginSeconds, fallbackHours);
  }
}
