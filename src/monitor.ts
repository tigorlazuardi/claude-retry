import { match, isBlockedAtBanner } from './patterns.ts';
import { parseResetTime, calculateWaitMs } from './time-parser.ts';
import type { PaneTarget } from './zellij.ts';
import type { AccountSnapshot } from './accounts.ts';
import type { AccountUsage } from './usage.ts';

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
  missCount: number;
}

const MAX_MISSES = 3;

export function createState(): MonitorState {
  return { status: 'monitoring', waitUntil: 0, missCount: 0 };
}

/**
 * Resolve which account dir (if any) applies to this pane, and return its usage.
 * Mirrors the account-resolution logic previously inline in the monitoring branch.
 */
async function resolveAccountUsage(
  snapshot: AccountSnapshot | undefined,
  resolvePaneAccount: ((t: PaneTarget, s: AccountSnapshot) => Promise<string | null>) | undefined,
  target: PaneTarget | undefined,
): Promise<{ dir: string | null; usage: AccountUsage | undefined }> {
  if (snapshot === undefined) {
    return { dir: null, usage: undefined };
  }

  let dir: string | null = null;

  if (snapshot.byDir.size === 1) {
    dir = [...snapshot.byDir.keys()][0]!;
  } else {
    const limitedDirs: string[] = [];
    for (const [d, usage] of snapshot.byDir) {
      if (usage.limited) limitedDirs.push(d);
    }
    if (limitedDirs.length === 1) {
      dir = limitedDirs[0]!;
    } else if (target !== undefined && resolvePaneAccount !== undefined) {
      dir = await resolvePaneAccount(target, snapshot);
    }
  }

  const usage = dir !== null ? snapshot.byDir.get(dir) : undefined;
  return { dir, usage };
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
  const logger = log ?? (() => {});
  const label = target?.label ?? 'pane';

  if (state.status === 'waiting') {
    const limited = match(screenText).limited;
    const { usage } = await resolveAccountUsage(snapshot, resolvePaneAccount, target);
    const marginMs = (marginSeconds ?? 60) * 1000;

    // Banner absent → claude exited / user already continued / pane id reused → nothing to continue.
    if (!limited) {
      state.status = 'monitoring';
      state.waitUntil = 0;
      logger(`${label} wait abandoned (banner gone)`);
      return 'monitoring';
    }

    // Account still limited with a known reset → keep waitUntil aligned to the live reset time.
    if (usage !== undefined && usage.limited && usage.resetsAtMs !== null) {
      state.waitUntil = usage.resetsAtMs + marginMs;
    }

    // The limit is over when the account quota has cleared (early/real reset) OR the timer elapsed.
    const accountCleared = usage !== undefined && !usage.limited;
    const timerElapsed = now >= state.waitUntil;

    if (accountCleared || timerElapsed) {
      await injectContinue();
      state.status = 'monitoring';
      state.waitUntil = 0;
      logger(`${label} reset reached — injected continue`);
      return 'retried';
    }

    // Still limited, before reset → keep waiting.
    return 'rate-limited';
  }

  // state.status === 'monitoring'
  const result = match(screenText);
  if (result.limited) {
    // Tier 1: account-aware resolution when snapshot is available
    if (snapshot !== undefined) {
      const { dir: accountDir, usage } = await resolveAccountUsage(snapshot, resolvePaneAccount, target);

      if (accountDir !== null && usage !== undefined) {
        if (!usage.limited) {
          // Account cleared. Either truly stale/incidental, OR a pane parked at a
          // limit banner whose quota just reset (restart-after-reset / reopened-idle).
          if (isBlockedAtBanner(screenText)) {
            await injectContinue();
            logger(`${label} cleared-limit banner at bottom — injected continue`);
            return 'retried';
          }
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
      // accountDir null or usage missing — fall through to tier 3
    }

    // Tier 3: text fallback (current behavior, unchanged)
    const resetLine = result.resetLine ?? '';
    const parsed = parseResetTime(resetLine);
    const waitMs = calculateWaitMs(parsed, marginSeconds, fallbackHours, new Date(now));
    if (waitMs <= 0) {
      // Reset time already passed → limit is over (no roll-to-tomorrow).
      if (isBlockedAtBanner(screenText)) {
        await injectContinue();
        logger(`${label} reset already passed — injected continue`);
        return 'retried';
      }
      logger(`${label} stale banner ignored (reset already passed)`);
      return 'monitoring';
    }
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
  screenText: string,
  deps: MultiMonitorDeps,
  marginSeconds?: number,
  fallbackHours?: number,
  snapshot?: AccountSnapshot,
): Promise<MonitorStatus> {
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
    await tick(paneId, state, deps, marginSeconds, fallbackHours);
    await deps.sleep(pollIntervalMs ?? 5000);
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
 *
 * Uses a miss counter (MAX_MISSES) so transient list-panes failures don't
 * prune waiting state immediately — a pane must be absent for MAX_MISSES
 * consecutive passes before its state is dropped.
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

  // Prune state for panes that no longer exist, using miss counter to tolerate
  // transient list-panes failures.
  const live = new Set(targets.map((t) => t.label));
  for (const key of [...states.keys()]) {
    if (!live.has(key)) {
      const s = states.get(key)!;
      s.missCount++;
      if (s.missCount >= MAX_MISSES) {
        states.delete(key);
        log(`${key} gone — dropped after ${MAX_MISSES} misses`);
      } else {
        log(`${key} missing (${s.missCount}/${MAX_MISSES}) — keeping state`);
      }
    }
  }

  log(
    targets.length === 0
      ? 'scan: no Claude panes found'
      : `scan: watching ${targets.length} Claude pane(s) [${targets.map((t) => t.label).join(', ')}]`,
  );

  // Capture each target's screen once, collecting successes into a map.
  // Capture failures are logged and that pane is skipped this round.
  const screens = new Map<string, string>();
  for (const target of targets) {
    try {
      screens.set(target.label, await deps.capture(target));
    } catch {
      log(`${target.label} — capture error (skipped this round)`);
    }
  }

  // Decide whether usage API is needed this pass:
  // - any pane already in 'waiting' state (among current targets), OR
  // - any captured screen has a limit banner.
  const anyWaiting = targets.some((t) => states.get(t.label)?.status === 'waiting');
  const anyBanner = [...screens.values()].some((s) => match(s).limited);
  const needUsage = anyWaiting || anyBanner;

  // Fetch account snapshot only when needed (swallow errors → undefined).
  let snapshot: AccountSnapshot | undefined;
  if (needUsage && deps.getAccountSnapshot !== undefined) {
    try {
      snapshot = await deps.getAccountSnapshot();
    } catch {
      snapshot = undefined;
    }
  }

  for (const target of targets) {
    const screenText = screens.get(target.label);
    // Skip panes whose capture failed this round.
    if (screenText === undefined) continue;

    let state = states.get(target.label);
    if (!state) {
      state = createState();
      states.set(target.label, state);
      log(`${target.label} — new Claude pane, now watching`);
    }
    // Reset miss counter for panes present this pass
    state.missCount = 0;
    const before = state.status;
    try {
      const status = await tickTarget(target, state, screenText, deps, marginSeconds, fallbackHours, snapshot);
      logPaneStatus(log, target.label, before, state, status);
    } catch {
      // This pane's inject failed — leave its state, keep going.
      log(`${target.label} — inject error (skipped this round)`);
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
    await multiTick(states, deps, marginSeconds, fallbackHours);
    await deps.sleep(pollIntervalMs ?? 60000);
  }
}
