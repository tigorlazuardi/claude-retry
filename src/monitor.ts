import { match } from './patterns.ts';
import { parseResetTime, calculateWaitMs } from './time-parser.ts';
import type { PaneTarget } from './zellij.ts';
import type { AccountSnapshot } from './accounts.ts';

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
  /** If provided, called ONCE per multiTick pass to get current account usage snapshot. */
  getAccountSnapshot?: () => Promise<AccountSnapshot>;
  /** If provided, used to resolve which account a pane belongs to when ambiguous. */
  resolvePaneAccount?: (t: PaneTarget, s: AccountSnapshot) => Promise<string | null>;
}

export type PaneStates = Map<string, MonitorState>;

export type MonitorStatus = 'monitoring' | 'rate-limited' | 'retried' | 'exited';

export interface MonitorState {
  status: 'monitoring' | 'waiting';
  waitUntil: number;
}

export function createState(): MonitorState {
  return { status: 'monitoring', waitUntil: 0 };
}

/**
 * Core state transition for one pane, given its current screen text.
 * `injectContinue` is called only when a wait period has elapsed. Shared by
 * single-pane (tick) and multi-session (tickTarget) monitoring.
 *
 * When snapshot/resolver/target/log are provided, applies the three-tier
 * account-aware limit resolution. Single-pane callers omit these — text path only.
 */
async function stepState(
  state: MonitorState,
  screenText: string,
  now: number,
  injectContinue: () => Promise<void>,
  marginSeconds?: number,
  fallbackHours?: number,
  snapshot?: AccountSnapshot,
  resolvePaneAccount?: (t: PaneTarget, s: AccountSnapshot) => Promise<string | null>,
  target?: PaneTarget,
  log?: (msg: string) => void,
): Promise<MonitorStatus> {
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
    const label = target?.label ?? 'pane';
    const logger = log ?? (() => {});

    // Tier 1: account-aware resolution when snapshot is available
    if (snapshot !== undefined) {
      let accountDir: string | null = null;

      if (snapshot.byDir.size === 1) {
        // Single account — always attributable, regardless of limited state
        // (covers both fresh-limit and stale-banner cases without resolver)
        accountDir = [...snapshot.byDir.keys()][0]!;
      } else {
        // Find dirs that are limited in snapshot
        const limitedDirs: string[] = [];
        for (const [dir, usage] of snapshot.byDir) {
          if (usage.limited) limitedDirs.push(dir);
        }

        if (limitedDirs.length === 1) {
          // Exactly one limited account — attribute banner to it
          accountDir = limitedDirs[0]!;
        } else if (target !== undefined && resolvePaneAccount !== undefined) {
          // Ambiguous (0 or 2+) — try proc bridge (phase 2 stub, returns null)
          accountDir = await resolvePaneAccount(target, snapshot);
        }
      }

      if (accountDir !== null) {
        const usage = snapshot.byDir.get(accountDir);
        if (usage !== undefined) {
          if (!usage.limited) {
            // Staleness gate: account is not limited → banner is stale → ignore
            logger(`${label} stale banner ignored (account not limited)`);
            return 'monitoring';
          }
          // Account confirmed limited — use resetsAtMs if available
          const marginMs = (marginSeconds ?? 60) * 1000;
          if (usage.resetsAtMs !== null) {
            state.waitUntil = usage.resetsAtMs + marginMs;
            state.status = 'waiting';
            logger(`${label} account ${accountDir} limited, reset ${new Date(usage.resetsAtMs).toISOString()}`);
            return 'rate-limited';
          }
          // resetsAtMs null — fall through to text parse for the time, but
          // we know account is limited so we don't need to gate on text
          // (fall through to tier 3 below)
        }
        // usage missing for this dir — fall through to tier 3
      }
      // accountDir null or usage missing — fall through to tier 3
    }

    // Tier 3: text fallback (current behavior, unchanged)
    const resetLine = result.resetLine ?? '';
    const parsed = parseResetTime(resetLine);
    const waitMs = calculateWaitMs(parsed, marginSeconds, fallbackHours, new Date(now));
    state.waitUntil = now + waitMs;
    state.status = 'waiting';
    return 'rate-limited';
  }

  return 'monitoring';
}

export async function tick(
  paneId: string,
  state: MonitorState,
  deps: MonitorDeps,
  marginSeconds?: number,
  fallbackHours?: number,
): Promise<MonitorStatus> {
  const screenText = await deps.capture(paneId);
  return stepState(
    state,
    screenText,
    deps.now(),
    () => deps.inject(paneId, 'continue'),
    marginSeconds,
    fallbackHours,
  );
}

async function tickTarget(
  target: PaneTarget,
  state: MonitorState,
  deps: MultiMonitorDeps,
  marginSeconds?: number,
  fallbackHours?: number,
  snapshot?: AccountSnapshot,
): Promise<MonitorStatus> {
  const screenText = await deps.capture(target);
  return stepState(
    state,
    screenText,
    deps.now(),
    () => deps.inject(target, 'continue'),
    marginSeconds,
    fallbackHours,
    snapshot,
    deps.resolvePaneAccount,
    target,
    deps.log,
  );
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

/**
 * One discovery+monitor pass over every Claude pane in every live session.
 *
 * Re-discovers targets each call so new Claude sessions/panes are picked up and
 * closed ones are pruned. Per-pane state lives in `states`, keyed by the
 * target's label (session:paneId), and persists across calls. A failed
 * discovery or a single pane's capture/inject error is swallowed so one bad
 * pane never stops the others.
 */
export async function multiTick(
  states: PaneStates,
  deps: MultiMonitorDeps,
  marginSeconds?: number,
  fallbackHours?: number,
): Promise<void> {
  const log = deps.log ?? (() => {});

  let targets: PaneTarget[];
  try {
    targets = await deps.listTargets();
  } catch {
    // Discovery failed this round — keep existing states, retry next tick.
    log('scan failed: could not list sessions/panes (will retry)');
    return;
  }

  // Fetch account snapshot once per pass (swallow errors → undefined).
  let snapshot: AccountSnapshot | undefined;
  if (deps.getAccountSnapshot !== undefined) {
    try {
      snapshot = await deps.getAccountSnapshot();
    } catch {
      snapshot = undefined;
    }
  }

  // Prune state for panes that no longer exist.
  const live = new Set(targets.map((t) => t.label));
  for (const key of [...states.keys()]) {
    if (!live.has(key)) {
      states.delete(key);
      log(`${key} gone — dropped from watch`);
    }
  }

  log(
    targets.length === 0
      ? 'scan: no Claude panes found'
      : `scan: watching ${targets.length} Claude pane(s) [${targets.map((t) => t.label).join(', ')}]`,
  );

  for (const target of targets) {
    let state = states.get(target.label);
    if (!state) {
      state = createState();
      states.set(target.label, state);
      log(`${target.label} — new Claude pane, now watching`);
    }
    const before = state.status;
    try {
      const status = await tickTarget(target, state, deps, marginSeconds, fallbackHours, snapshot);
      logPaneStatus(log, target.label, before, state, status);
    } catch {
      // This pane's capture/inject failed — leave its state, keep going.
      log(`${target.label} — capture/inject error (skipped this round)`);
    }
  }
}

function logPaneStatus(
  log: (msg: string) => void,
  label: string,
  before: MonitorState['status'],
  state: MonitorState,
  status: MonitorStatus,
): void {
  if (status === 'rate-limited' && before === 'monitoring') {
    const until = new Date(state.waitUntil).toISOString();
    log(`${label} — RATE LIMITED, waiting until ${until}`);
  } else if (status === 'rate-limited') {
    log(`${label} — still waiting for reset`);
  } else if (status === 'retried') {
    log(`${label} — reset reached, cleared input + injected 'continue'`);
  } else {
    log(`${label} — ok`);
  }
}

export async function runMultiMonitor(
  deps: MultiMonitorDeps,
  pollIntervalMs?: number,
  marginSeconds?: number,
  fallbackHours?: number,
): Promise<void> {
  const states: PaneStates = new Map();
  for (;;) {
    await deps.sleep(pollIntervalMs ?? 60000);
    await multiTick(states, deps, marginSeconds, fallbackHours);
  }
}
