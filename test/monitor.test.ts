import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createState,
  tick,
  multiTick,
  runMonitor,
  runMultiMonitor,
  type MonitorDeps,
  type MultiMonitorDeps,
  type PaneStates,
} from '../src/monitor.ts';
import type { AccountSnapshot } from '../src/accounts.ts';

const FIXED_NOW = new Date('2024-01-15T10:00:00Z').getTime();

function makeDeps(overrides: Partial<MonitorDeps> & { captureText?: string }): MonitorDeps & { injected: Array<[string, string]> } {
  const injected: Array<[string, string]> = [];
  return {
    capture: async (_paneId: string) => overrides.captureText ?? '',
    inject: async (paneId: string, text: string) => { injected.push([paneId, text]); },
    now: overrides.now ?? (() => FIXED_NOW),
    sleep: overrides.sleep ?? (async () => {}),
    injected,
    ...( overrides.capture ? { capture: overrides.capture } : {} ),
  };
}

describe('tick', () => {
  it('returns monitoring when screen is not rate-limited', async () => {
    const state = createState();
    const deps = makeDeps({ captureText: 'Claude is ready to help.' });
    const status = await tick('pane-1', state, deps);
    assert.equal(status, 'monitoring');
    assert.equal(state.status, 'monitoring');
    assert.equal(state.waitUntil, 0);
  });

  it('returns rate-limited and sets waiting state when limit detected', async () => {
    const state = createState();
    const deps = makeDeps({
      captureText: '5-hour limit reached\nresets 3pm (UTC)',
      now: () => FIXED_NOW,
    });
    const status = await tick('pane-1', state, deps);
    assert.equal(status, 'rate-limited');
    assert.equal(state.status, 'waiting');
    // waitUntil should be > now (5h + 60s margin = 18060000ms)
    assert.ok(state.waitUntil > FIXED_NOW, 'waitUntil should be in the future');
    assert.ok(state.waitUntil >= FIXED_NOW + 5 * 3600000, 'waitUntil should be at least 5h out');
  });

  it('returns rate-limited without inject when still waiting (now < waitUntil)', async () => {
    const state = createState();
    state.status = 'waiting';
    state.waitUntil = FIXED_NOW + 3600000; // 1h from now
    // Banner still present so rule 1 (banner gone) does not fire; timer not elapsed → rate-limited
    const deps = makeDeps({ captureText: '5-hour limit reached\nresets 3pm (UTC)', now: () => FIXED_NOW });
    const status = await tick('pane-1', state, deps);
    assert.equal(status, 'rate-limited');
    assert.equal(deps.injected.length, 0);
    assert.equal(state.status, 'waiting');
  });

  it('injects continue and resets state when wait period elapsed (now >= waitUntil)', async () => {
    const state = createState();
    state.status = 'waiting';
    state.waitUntil = FIXED_NOW - 1; // already in the past
    // Banner still present — inject should fire
    const deps = makeDeps({ captureText: '5-hour limit reached\nresets 3pm (UTC)', now: () => FIXED_NOW });
    const status = await tick('pane-1', state, deps);
    assert.equal(status, 'retried');
    assert.equal(deps.injected.length, 1);
    assert.deepEqual(deps.injected[0], ['pane-1', 'continue']);
    assert.equal(state.status, 'monitoring');
    assert.equal(state.waitUntil, 0);
  });

  it('completes full retry cycle: detect → wait → inject → monitor', async () => {
    const state = createState();
    let currentTime = FIXED_NOW;

    const deps = makeDeps({
      captureText: '5-hour limit reached\nresets 3pm (UTC)',
      now: () => currentTime,
    });

    // Step 1: detect limit → rate-limited, state = waiting
    const s1 = await tick('pane-1', state, deps);
    assert.equal(s1, 'rate-limited');
    assert.equal(state.status, 'waiting');
    const savedWaitUntil = state.waitUntil;

    // Step 2: tick before wait expires → still rate-limited, no inject
    currentTime = savedWaitUntil - 1000;
    const s2 = await tick('pane-1', state, deps);
    assert.equal(s2, 'rate-limited');
    assert.equal(deps.injected.length, 0);

    // Step 3: tick after wait expires → inject, state reset
    currentTime = savedWaitUntil + 1;
    const s3 = await tick('pane-1', state, deps);
    assert.equal(s3, 'retried');
    assert.equal(deps.injected.length, 1);
    assert.deepEqual(deps.injected[0], ['pane-1', 'continue']);
    assert.equal(state.status, 'monitoring');

    // Step 4: normal screen → monitoring (swap captureText to non-limited)
    deps.captureText = 'Claude is ready to help.';
    const deps2 = { ...deps, capture: async (_: string) => 'Claude is ready to help.' };
    const s4 = await tick('pane-1', state, deps2 as MonitorDeps);
    assert.equal(s4, 'monitoring');
  });

  it('waiting + elapsed + banner STILL present → injectContinue called, status→monitoring', async () => {
    const state = createState();
    state.status = 'waiting';
    state.waitUntil = FIXED_NOW - 1; // elapsed
    const deps = makeDeps({
      captureText: '5-hour limit reached\nresets 3pm (UTC)',
      now: () => FIXED_NOW,
    });
    const status = await tick('pane-1', state, deps);
    assert.equal(status, 'retried');
    assert.equal(deps.injected.length, 1, 'should inject continue when banner still visible');
    assert.deepEqual(deps.injected[0], ['pane-1', 'continue']);
    assert.equal(state.status, 'monitoring');
    assert.equal(state.waitUntil, 0);
  });

  it('waiting + elapsed + banner GONE (shell prompt) → injectContinue NOT called, status→monitoring', async () => {
    const state = createState();
    state.status = 'waiting';
    state.waitUntil = FIXED_NOW - 1; // elapsed
    // Pane now shows a shell prompt — banner gone (claude exited, pane reused, user continued, etc.)
    // New behavior: rule 1 (banner gone) fires first → returns 'monitoring' (not 'retried')
    const deps = makeDeps({
      captureText: 'user@host:~$ ',
      now: () => FIXED_NOW,
    });
    const status = await tick('pane-1', state, deps);
    assert.equal(status, 'monitoring');
    assert.equal(deps.injected.length, 0, 'should NOT inject when banner is gone');
    assert.equal(state.status, 'monitoring');
    assert.equal(state.waitUntil, 0);
  });
});

type Target = { session: string; paneId: string; label: string };
function tgt(label: string): Target {
  const [session, paneId] = label.split(':');
  return { session: session!, paneId: paneId!, label };
}

function makeMultiDeps(opts: {
  targets: Target[] | (() => Target[]);
  screens?: Record<string, string>; // keyed by label
  now?: () => number;
}): MultiMonitorDeps & { injected: Array<[string, string]> } {
  const injected: Array<[string, string]> = [];
  return {
    listTargets: async () =>
      typeof opts.targets === 'function' ? opts.targets() : opts.targets,
    capture: async (t: Target) => opts.screens?.[t.label] ?? '',
    inject: async (t: Target, text: string) => {
      injected.push([t.label, text]);
    },
    now: opts.now ?? (() => FIXED_NOW),
    sleep: async () => {},
    injected,
  };
}

describe('multiTick', () => {
  it('creates state per target and detects limits independently across sessions', async () => {
    const states: PaneStates = new Map();
    const deps = makeMultiDeps({
      targets: [tgt('projA:1'), tgt('projB:0')],
      screens: {
        'projA:1': 'Claude is ready.',
        'projB:0': '5-hour limit reached\nresets 3pm (UTC)',
      },
    });
    await multiTick(states, deps);
    assert.equal(states.get('projA:1')!.status, 'monitoring');
    assert.equal(states.get('projB:0')!.status, 'waiting');
    assert.ok(states.get('projB:0')!.waitUntil > FIXED_NOW);
    assert.equal(deps.injected.length, 0);
  });

  it('prunes state when a target disappears (after MAX_MISSES=3 passes)', async () => {
    const states: PaneStates = new Map();
    states.set('gone:9', createState());
    states.get('gone:9')!.status = 'waiting';
    const deps = makeMultiDeps({ targets: [tgt('projA:1')], screens: { 'projA:1': 'ready' } });
    // Miss counter: need 3 consecutive misses before pruned
    await multiTick(states, deps); // miss 1
    assert.ok(states.has('gone:9'), 'still present after miss 1');
    await multiTick(states, deps); // miss 2
    assert.ok(states.has('gone:9'), 'still present after miss 2');
    await multiTick(states, deps); // miss 3 → pruned
    assert.equal(states.has('gone:9'), false);
    assert.equal(states.has('projA:1'), true);
  });

  it('picks up a newly appeared pane on a later pass', async () => {
    const states: PaneStates = new Map();
    let targets = [tgt('projA:1')];
    const deps = makeMultiDeps({
      targets: () => targets,
      screens: { 'projA:1': 'ready', 'projB:0': 'ready' },
    });
    await multiTick(states, deps);
    assert.deepEqual([...states.keys()], ['projA:1']);
    targets = [tgt('projA:1'), tgt('projB:0')];
    await multiTick(states, deps);
    assert.deepEqual([...states.keys()].sort(), ['projA:1', 'projB:0']);
  });

  it('preserves per-target waiting state across passes and injects when reset elapses', async () => {
    const states: PaneStates = new Map();
    let now = FIXED_NOW;
    const deps = makeMultiDeps({
      targets: [tgt('projA:7')],
      screens: { 'projA:7': '5-hour limit reached\nresets 3pm (UTC)' },
      now: () => now,
    });
    await multiTick(states, deps);
    assert.equal(states.get('projA:7')!.status, 'waiting');
    const waitUntil = states.get('projA:7')!.waitUntil;
    assert.equal(deps.injected.length, 0);
    now = waitUntil - 1000;
    await multiTick(states, deps);
    assert.equal(deps.injected.length, 0);
    now = waitUntil + 1;
    await multiTick(states, deps);
    assert.deepEqual(deps.injected, [['projA:7', 'continue']]);
    assert.equal(states.get('projA:7')!.status, 'monitoring');
  });

  it('swallows listTargets failure and keeps existing state', async () => {
    const states: PaneStates = new Map();
    states.set('projA:1', createState());
    states.get('projA:1')!.status = 'waiting';
    const deps: MultiMonitorDeps = {
      listTargets: async () => {
        throw new Error('zellij gone');
      },
      capture: async () => '',
      inject: async () => {},
      now: () => FIXED_NOW,
      sleep: async () => {},
    };
    await multiTick(states, deps);
    assert.equal(states.get('projA:1')!.status, 'waiting');
  });

  it('continues to other targets when one capture throws', async () => {
    const states: PaneStates = new Map();
    const deps: MultiMonitorDeps & { injected: Array<[string, string]> } = {
      ...makeMultiDeps({ targets: [tgt('projA:1'), tgt('projB:2')] }),
      capture: async (t: Target) => {
        if (t.label === 'projA:1') throw new Error('capture fail');
        return '5-hour limit reached\nresets 3pm (UTC)';
      },
    } as MultiMonitorDeps & { injected: Array<[string, string]> };
    await multiTick(states, deps);
    assert.equal(states.get('projB:2')!.status, 'waiting');
  });
});

// Helper: build a fake AccountSnapshot
function makeSnapshot(entries: Array<[string, { limited: boolean; resetsAtMs: number | null }]>): AccountSnapshot {
  return { byDir: new Map(entries) };
}

const ACCOUNT_DIR = '/home/user/.claude';
const RESET_MS = new Date('2024-01-15T15:00:00Z').getTime(); // epoch ms for reset

describe('multiTick — account-aware limit resolution', () => {
  const LIMITED_SCREEN = '5-hour limit reached\nresets 3pm (UTC)';

  it('staleness gate: banner present but account NOT limited → stays monitoring', async () => {
    const states: PaneStates = new Map();
    const snapshot = makeSnapshot([[ACCOUNT_DIR, { limited: false, resetsAtMs: null }]]);
    const deps: MultiMonitorDeps = {
      ...makeMultiDeps({
        targets: [tgt('projA:1')],
        screens: { 'projA:1': LIMITED_SCREEN },
        now: () => FIXED_NOW,
      }),
      getAccountSnapshot: async () => snapshot,
      resolvePaneAccount: async (_t, _s) => ACCOUNT_DIR,
    };
    await multiTick(states, deps);
    assert.equal(states.get('projA:1')!.status, 'monitoring', 'stale banner should not trigger wait');
    assert.equal(states.get('projA:1')!.waitUntil, 0);
  });

  it('staleness gate: single account in byDir, limited:false, NO resolver → stale banner ignored', async () => {
    // Real-world wiring: resolvePaneAccount is a stub returning null.
    // Single-account user with a stale banner (account already reset, util low → 0 limited dirs).
    // Before fix: accountDir would be null → tier 3 → re-waits on stale banner.
    // After fix: byDir.size === 1 → sole key → staleness gate fires → stays monitoring.
    const states: PaneStates = new Map();
    const snapshot = makeSnapshot([[ACCOUNT_DIR, { limited: false, resetsAtMs: null }]]);
    const deps: MultiMonitorDeps = {
      ...makeMultiDeps({
        targets: [tgt('projA:1')],
        screens: { 'projA:1': LIMITED_SCREEN },
        now: () => FIXED_NOW,
      }),
      getAccountSnapshot: async () => snapshot,
      // resolvePaneAccount intentionally absent (undefined) — real CLI wires a stub returning null
    };
    await multiTick(states, deps);
    assert.equal(states.get('projA:1')!.status, 'monitoring', 'stale banner (no resolver) must not trigger wait');
    assert.equal(states.get('projA:1')!.waitUntil, 0);
  });

  it('single account in byDir, limited:true, resetsAtMs set, no resolver → waits to resetsAtMs+margin', async () => {
    const states: PaneStates = new Map();
    const snapshot = makeSnapshot([[ACCOUNT_DIR, { limited: true, resetsAtMs: RESET_MS }]]);
    const marginSeconds = 60;
    const deps: MultiMonitorDeps = {
      ...makeMultiDeps({
        targets: [tgt('projA:1')],
        screens: { 'projA:1': LIMITED_SCREEN },
        now: () => FIXED_NOW,
      }),
      getAccountSnapshot: async () => snapshot,
      // resolvePaneAccount intentionally absent
    };
    await multiTick(states, deps, marginSeconds);
    assert.equal(states.get('projA:1')!.status, 'waiting');
    assert.equal(states.get('projA:1')!.waitUntil, RESET_MS + marginSeconds * 1000);
  });

  it('account limited with resetsAtMs: waitUntil === resetsAtMs + margin', async () => {
    const states: PaneStates = new Map();
    const snapshot = makeSnapshot([[ACCOUNT_DIR, { limited: true, resetsAtMs: RESET_MS }]]);
    const marginSeconds = 60;
    const deps: MultiMonitorDeps = {
      ...makeMultiDeps({
        targets: [tgt('projA:1')],
        screens: { 'projA:1': LIMITED_SCREEN },
        now: () => FIXED_NOW,
      }),
      getAccountSnapshot: async () => snapshot,
      resolvePaneAccount: async (_t, _s) => ACCOUNT_DIR,
    };
    await multiTick(states, deps, marginSeconds);
    assert.equal(states.get('projA:1')!.status, 'waiting');
    assert.equal(states.get('projA:1')!.waitUntil, RESET_MS + marginSeconds * 1000);
  });

  it('snapshot absent → text fallback path still works', async () => {
    // No getAccountSnapshot — existing text-based behavior
    const states: PaneStates = new Map();
    const deps: MultiMonitorDeps = makeMultiDeps({
      targets: [tgt('projA:1')],
      screens: { 'projA:1': LIMITED_SCREEN },
      now: () => FIXED_NOW,
    });
    await multiTick(states, deps);
    assert.equal(states.get('projA:1')!.status, 'waiting');
    assert.ok(states.get('projA:1')!.waitUntil > FIXED_NOW, 'text fallback should set future waitUntil');
  });

  it('account unknown (resolvePaneAccount returns null) → text fallback, banner NOT ignored', async () => {
    const states: PaneStates = new Map();
    // snapshot has one limited account but resolver returns null (ambiguous)
    const snapshot = makeSnapshot([[ACCOUNT_DIR, { limited: true, resetsAtMs: RESET_MS }]]);
    // Make snapshot have 2 limited dirs so single-limited shortcut doesn't fire
    snapshot.byDir.set('/home/other/.claude', { limited: true, resetsAtMs: RESET_MS });
    const deps: MultiMonitorDeps = {
      ...makeMultiDeps({
        targets: [tgt('projA:1')],
        screens: { 'projA:1': LIMITED_SCREEN },
        now: () => FIXED_NOW,
      }),
      getAccountSnapshot: async () => snapshot,
      resolvePaneAccount: async (_t, _s) => null,
    };
    await multiTick(states, deps);
    // Should still go to waiting via text fallback — NOT ignored
    assert.equal(states.get('projA:1')!.status, 'waiting');
    assert.ok(states.get('projA:1')!.waitUntil > FIXED_NOW);
  });

  it('single limited account resolved automatically (no resolvePaneAccount needed)', async () => {
    const states: PaneStates = new Map();
    // snapshot has exactly ONE limited dir → attributed automatically
    const snapshot = makeSnapshot([
      [ACCOUNT_DIR, { limited: true, resetsAtMs: RESET_MS }],
      ['/home/other/.claude', { limited: false, resetsAtMs: null }],
    ]);
    const marginSeconds = 60;
    const deps: MultiMonitorDeps = {
      ...makeMultiDeps({
        targets: [tgt('projA:1')],
        screens: { 'projA:1': LIMITED_SCREEN },
        now: () => FIXED_NOW,
      }),
      getAccountSnapshot: async () => snapshot,
      // resolvePaneAccount intentionally omitted
    };
    await multiTick(states, deps, marginSeconds);
    assert.equal(states.get('projA:1')!.status, 'waiting');
    assert.equal(states.get('projA:1')!.waitUntil, RESET_MS + marginSeconds * 1000);
  });

  it('getAccountSnapshot error swallowed → text fallback, no throw from multiTick', async () => {
    const states: PaneStates = new Map();
    const deps: MultiMonitorDeps = {
      ...makeMultiDeps({
        targets: [tgt('projA:1')],
        screens: { 'projA:1': LIMITED_SCREEN },
        now: () => FIXED_NOW,
      }),
      getAccountSnapshot: async () => { throw new Error('network error'); },
    };
    // Must not throw
    await assert.doesNotReject(() => multiTick(states, deps));
    // Text fallback → still goes waiting
    assert.equal(states.get('projA:1')!.status, 'waiting');
  });
});

// ---------------------------------------------------------------------------
// Change 1: self-correcting waiting branch
// ---------------------------------------------------------------------------

const LIMITED_SCREEN_W = '5-hour limit reached\nresets 3pm (UTC)';
const RESET_MS_W = new Date('2024-01-15T15:00:00Z').getTime();
const ACCOUNT_DIR_W = '/home/user/.claude';

function makeWaitingTarget() {
  const state = createState();
  state.status = 'waiting';
  state.waitUntil = FIXED_NOW + 3_600_000; // 1h in the future
  return state;
}

describe('stepState waiting branch — self-correcting', () => {
  it('banner GONE (pre-reset) → status monitoring, injectContinue NOT called', async () => {
    const states: PaneStates = new Map();
    const state = makeWaitingTarget();
    states.set('projA:1', state);

    const deps = makeMultiDeps({
      targets: [tgt('projA:1')],
      screens: { 'projA:1': 'Claude is ready.' }, // banner gone
      now: () => FIXED_NOW,
    });

    await multiTick(states, deps);
    assert.equal(states.get('projA:1')!.status, 'monitoring');
    assert.equal(states.get('projA:1')!.waitUntil, 0);
    assert.equal(deps.injected.length, 0, 'must NOT inject when banner gone');
  });

  it('account cleared at reset (banner present, account NOT limited) → injectContinue called, status→monitoring, returns retried', async () => {
    const states: PaneStates = new Map();
    const state = makeWaitingTarget();
    states.set('projA:1', state);

    const snapshot = makeSnapshot([[ACCOUNT_DIR_W, { limited: false, resetsAtMs: null }]]);
    const base = makeMultiDeps({ targets: [tgt('projA:1')], screens: { 'projA:1': LIMITED_SCREEN_W }, now: () => FIXED_NOW });
    const fullDeps = { ...base, getAccountSnapshot: async () => snapshot, resolvePaneAccount: async (_t: unknown, _s: unknown) => ACCOUNT_DIR_W };

    await multiTick(states, fullDeps);
    assert.equal(states.get('projA:1')!.status, 'monitoring', 'should transition to monitoring after inject');
    assert.equal(states.get('projA:1')!.waitUntil, 0);
    assert.equal(base.injected.length, 1, 'must inject continue when account cleared but banner still present');
    assert.deepEqual(base.injected[0], ['projA:1', 'continue']);
  });

  it('banner present, no snapshot, pre-reset → stays waiting (rate-limited), no inject', async () => {
    const states: PaneStates = new Map();
    const state = makeWaitingTarget();
    states.set('projA:1', state);

    const deps = makeMultiDeps({
      targets: [tgt('projA:1')],
      screens: { 'projA:1': LIMITED_SCREEN_W },
      now: () => FIXED_NOW,
    });

    await multiTick(states, deps);
    assert.equal(states.get('projA:1')!.status, 'waiting');
    assert.equal(deps.injected.length, 0, 'must NOT inject before timer elapses');
  });

  it('banner present, elapsed, no snapshot → inject once → monitoring (retried)', async () => {
    const states: PaneStates = new Map();
    const state = createState();
    state.status = 'waiting';
    state.waitUntil = FIXED_NOW - 1; // already elapsed
    states.set('projA:1', state);

    const deps = makeMultiDeps({
      targets: [tgt('projA:1')],
      screens: { 'projA:1': LIMITED_SCREEN_W },
      now: () => FIXED_NOW,
    });

    await multiTick(states, deps);
    assert.equal(states.get('projA:1')!.status, 'monitoring');
    assert.deepEqual(deps.injected, [['projA:1', 'continue']]);
  });

  it('banner present, still limited with future resetsAtMs → waitUntil refreshed, stays waiting, no inject', async () => {
    const states: PaneStates = new Map();
    const marginSeconds = 60;
    // waitUntil is in past (would normally trigger inject) but resetsAtMs is far future
    const futureReset = FIXED_NOW + 2 * 3_600_000; // 2h from now
    const state = createState();
    state.status = 'waiting';
    state.waitUntil = FIXED_NOW - 1; // elapsed
    states.set('projA:1', state);

    const snapshot = makeSnapshot([[ACCOUNT_DIR_W, { limited: true, resetsAtMs: futureReset }]]);
    const base = makeMultiDeps({
      targets: [tgt('projA:1')],
      screens: { 'projA:1': LIMITED_SCREEN_W },
      now: () => FIXED_NOW,
    });
    const fullDeps = { ...base, getAccountSnapshot: async () => snapshot, resolvePaneAccount: async (_t: unknown, _s: unknown) => ACCOUNT_DIR_W };

    await multiTick(states, fullDeps, marginSeconds);
    const updated = states.get('projA:1')!;
    assert.equal(updated.status, 'waiting', 'should stay waiting after waitUntil refresh');
    assert.equal(updated.waitUntil, futureReset + marginSeconds * 1000, 'waitUntil should be refreshed to resetsAtMs+margin');
    assert.equal(base.injected.length, 0, 'must NOT inject when refreshed waitUntil is still in future');
  });

  // Regression test: the banner-still-present + account-cleared state is the NORMAL successful
  // reset. Old code incorrectly abandoned without injecting ("account not limited" → monitoring).
  // New behavior: account cleared while banner still present → inject continue (early-reset path).
  it('REGRESSION: pane waiting, banner shows session limit, snapshot account cleared (early reset), now before original waitUntil → injectContinue called (NOT abandoned)', async () => {
    const states: PaneStates = new Map();
    const originalWaitUntil = FIXED_NOW + 3_600_000; // 1h in future
    const pastResetMs = FIXED_NOW - 60_000; // reset was 1 min ago
    const state = createState();
    state.status = 'waiting';
    state.waitUntil = originalWaitUntil;
    states.set('projA:1', state);

    // Real banner text from Claude — limit banner still on screen
    const realBannerText = "You've hit your session limit · resets 12:50am (Asia/Jakarta)";
    // Account snapshot shows cleared (early reset already happened)
    const snapshot = makeSnapshot([[ACCOUNT_DIR_W, { limited: false, resetsAtMs: pastResetMs }]]);
    const base = makeMultiDeps({
      targets: [tgt('projA:1')],
      screens: { 'projA:1': realBannerText },
      now: () => FIXED_NOW, // before original waitUntil
    });
    const fullDeps = { ...base, getAccountSnapshot: async () => snapshot, resolvePaneAccount: async (_t: unknown, _s: unknown) => ACCOUNT_DIR_W };

    await multiTick(states, fullDeps);
    assert.equal(base.injected.length, 1, 'MUST inject continue on early reset — not abandon');
    assert.deepEqual(base.injected[0], ['projA:1', 'continue']);
    assert.equal(states.get('projA:1')!.status, 'monitoring');
    assert.equal(states.get('projA:1')!.waitUntil, 0);
  });
});

// ---------------------------------------------------------------------------
// Conditional usage API fetch
// ---------------------------------------------------------------------------

describe('multiTick — conditional getAccountSnapshot', () => {
  it('no banner + no waiting pane → getAccountSnapshot NOT called', async () => {
    const states: PaneStates = new Map();
    let snapCalls = 0;
    const deps: MultiMonitorDeps = {
      ...makeMultiDeps({
        targets: [tgt('projA:1'), tgt('projB:0')],
        screens: {
          'projA:1': 'Claude is ready.',
          'projB:0': 'Claude is ready.',
        },
        now: () => FIXED_NOW,
      }),
      getAccountSnapshot: async () => {
        snapCalls++;
        return makeSnapshot([[ACCOUNT_DIR, { limited: false, resetsAtMs: null }]]);
      },
    };
    await multiTick(states, deps);
    assert.equal(snapCalls, 0, 'getAccountSnapshot must NOT be called when no banner and no waiting pane');
    assert.equal(states.get('projA:1')!.status, 'monitoring');
    assert.equal(states.get('projB:0')!.status, 'monitoring');
  });

  it('banner present → getAccountSnapshot called once, staleness/limit path works', async () => {
    const states: PaneStates = new Map();
    let snapCalls = 0;
    const snapshot = makeSnapshot([[ACCOUNT_DIR, { limited: true, resetsAtMs: RESET_MS }]]);
    const marginSeconds = 60;
    const deps: MultiMonitorDeps = {
      ...makeMultiDeps({
        targets: [tgt('projA:1')],
        screens: { 'projA:1': '5-hour limit reached\nresets 3pm (UTC)' },
        now: () => FIXED_NOW,
      }),
      getAccountSnapshot: async () => {
        snapCalls++;
        return snapshot;
      },
    };
    await multiTick(states, deps, marginSeconds);
    assert.equal(snapCalls, 1, 'getAccountSnapshot must be called exactly once when banner present');
    assert.equal(states.get('projA:1')!.status, 'waiting');
    assert.equal(states.get('projA:1')!.waitUntil, RESET_MS + marginSeconds * 1000);
  });

  it('pane already waiting (no new banner elsewhere) → getAccountSnapshot called once', async () => {
    const states: PaneStates = new Map();
    // Pre-set a waiting pane
    const waitState = createState();
    waitState.status = 'waiting';
    waitState.waitUntil = FIXED_NOW + 3_600_000; // 1h ahead, not elapsed
    states.set('projA:1', waitState);

    let snapCalls = 0;
    const snapshot = makeSnapshot([[ACCOUNT_DIR, { limited: true, resetsAtMs: FIXED_NOW + 3_600_000 }]]);
    const deps: MultiMonitorDeps = {
      ...makeMultiDeps({
        targets: [tgt('projA:1')],
        screens: { 'projA:1': '5-hour limit reached\nresets 3pm (UTC)' },
        now: () => FIXED_NOW,
      }),
      getAccountSnapshot: async () => {
        snapCalls++;
        return snapshot;
      },
    };
    await multiTick(states, deps);
    assert.equal(snapCalls, 1, 'getAccountSnapshot must be called when a pane is already waiting');
    assert.equal(states.get('projA:1')!.status, 'waiting');
  });
});

// ---------------------------------------------------------------------------
// Change 2: miss-counter prune
// ---------------------------------------------------------------------------

describe('multiTick — miss-counter prune', () => {
  it('pane absent 1 then 2 passes (< MAX_MISSES) then returns → state preserved, not recreated', async () => {
    const states: PaneStates = new Map();
    let targets = [tgt('projA:1'), tgt('projB:0')];

    const deps = makeMultiDeps({
      targets: () => targets,
      screens: {
        'projA:1': '5-hour limit reached\nresets 3pm (UTC)',
        'projB:0': 'ready',
      },
      now: () => FIXED_NOW,
    });

    // Pass 1: both present, projA:1 goes waiting
    await multiTick(states, deps);
    assert.equal(states.get('projA:1')!.status, 'waiting');
    const savedWaitUntil = states.get('projA:1')!.waitUntil;

    // Pass 2: projA:1 absent (miss 1)
    targets = [tgt('projB:0')];
    await multiTick(states, deps);
    assert.ok(states.has('projA:1'), 'state must survive 1 miss');
    assert.equal(states.get('projA:1')!.status, 'waiting', 'status preserved');
    assert.equal(states.get('projA:1')!.waitUntil, savedWaitUntil, 'waitUntil preserved');
    assert.equal(states.get('projA:1')!.missCount, 1);

    // Pass 3: projA:1 absent (miss 2)
    await multiTick(states, deps);
    assert.ok(states.has('projA:1'), 'state must survive 2 misses');
    assert.equal(states.get('projA:1')!.missCount, 2);

    // Pass 4: projA:1 returns → missCount reset, state intact
    targets = [tgt('projA:1'), tgt('projB:0')];
    await multiTick(states, deps);
    assert.ok(states.has('projA:1'), 'state still present after return');
    assert.equal(states.get('projA:1')!.missCount, 0, 'missCount reset on return');
    // waitUntil still set (banner still showing, pane still waiting)
    assert.equal(states.get('projA:1')!.status, 'waiting');
  });

  it('pane absent MAX_MISSES consecutive passes → state deleted', async () => {
    const states: PaneStates = new Map();
    states.set('projA:1', createState());
    states.get('projA:1')!.status = 'waiting';
    states.get('projA:1')!.waitUntil = FIXED_NOW + 3_600_000;

    const deps = makeMultiDeps({
      targets: [tgt('projB:0')],
      screens: { 'projB:0': 'ready' },
      now: () => FIXED_NOW,
    });

    // 3 consecutive misses = MAX_MISSES → dropped
    await multiTick(states, deps); // miss 1
    assert.ok(states.has('projA:1'), 'still present after miss 1');
    await multiTick(states, deps); // miss 2
    assert.ok(states.has('projA:1'), 'still present after miss 2');
    await multiTick(states, deps); // miss 3 → pruned
    assert.equal(states.has('projA:1'), false, 'state must be deleted after MAX_MISSES');
  });

  it('pane present every pass → missCount stays 0', async () => {
    const states: PaneStates = new Map();
    const deps = makeMultiDeps({
      targets: [tgt('projA:1')],
      screens: { 'projA:1': 'ready' },
      now: () => FIXED_NOW,
    });

    await multiTick(states, deps);
    await multiTick(states, deps);
    await multiTick(states, deps);
    assert.equal(states.get('projA:1')!.missCount, 0);
  });
});

// ---------------------------------------------------------------------------
// Change 3: aggressive + bottom guard — monitoring branch inject on cleared-limit banner
// ---------------------------------------------------------------------------

// Canonical banner at the bottom of the screen (as claude parks it)
const CANONICAL_BOTTOM_SCREEN =
  'Some output line\nAnother line\n' +
  "You've hit your session limit · resets 12:50am (Asia/Jakarta)";

// Banner text well above bottom — 20 non-empty lines of output follow it, pushing
// it outside the bottom-15 window that isBlockedAtBanner inspects.
const BANNER_MID_SCREEN =
  "You've hit your session limit · resets 12:50am (Asia/Jakarta)\n" +
  Array.from({ length: 20 }, (_, i) => `output line ${i + 1}`).join('\n');

describe('multiTick — monitoring branch: fresh-pane aggressive inject', () => {
  it('monitoring: banner + account NOT limited + isBlockedAtBanner true → injectContinue called once, returns retried', async () => {
    const states: PaneStates = new Map();
    const snapshot = makeSnapshot([[ACCOUNT_DIR, { limited: false, resetsAtMs: null }]]);
    const base = makeMultiDeps({
      targets: [tgt('projA:1')],
      screens: { 'projA:1': CANONICAL_BOTTOM_SCREEN },
      now: () => FIXED_NOW,
    });
    const deps: MultiMonitorDeps = {
      ...base,
      getAccountSnapshot: async () => snapshot,
      resolvePaneAccount: async (_t, _s) => ACCOUNT_DIR,
    };
    await multiTick(states, deps);
    assert.equal(base.injected.length, 1, 'must inject continue when canonical banner at bottom and account cleared');
    assert.deepEqual(base.injected[0], ['projA:1', 'continue']);
    assert.equal(states.get('projA:1')!.status, 'monitoring');
  });

  it('monitoring: banner + account NOT limited + banner NOT at bottom → NO inject, returns monitoring (staleness gate)', async () => {
    const states: PaneStates = new Map();
    const snapshot = makeSnapshot([[ACCOUNT_DIR, { limited: false, resetsAtMs: null }]]);
    const base = makeMultiDeps({
      targets: [tgt('projA:1')],
      screens: { 'projA:1': BANNER_MID_SCREEN },
      now: () => FIXED_NOW,
    });
    const deps: MultiMonitorDeps = {
      ...base,
      getAccountSnapshot: async () => snapshot,
      resolvePaneAccount: async (_t, _s) => ACCOUNT_DIR,
    };
    await multiTick(states, deps);
    assert.equal(base.injected.length, 0, 'must NOT inject when banner is not at bottom');
    assert.equal(states.get('projA:1')!.status, 'monitoring');
  });

  // Tier-3 (no snapshot / text path): past-reset + isBlockedAtBanner
  // Use a banner with a past "resets HH:MM" and pass deps.now so calculateWaitMs <= 0.
  // FIXED_NOW = 2024-01-15T10:00:00Z. Banner says "resets 3am (UTC)" → 03:00 UTC already passed.
  const PAST_RESET_SCREEN =
    'Some prior output\n' +
    "You've hit your session limit · resets 3am (UTC)";

  it('monitoring: no snapshot, text reset already passed, isBlockedAtBanner true → inject, retried', async () => {
    const states: PaneStates = new Map();
    // FIXED_NOW = 10:00 UTC. "resets 3am (UTC)" → 03:00 already past → waitMs <= 0
    const deps = makeMultiDeps({
      targets: [tgt('projA:1')],
      screens: { 'projA:1': PAST_RESET_SCREEN },
      now: () => FIXED_NOW,
    });
    await multiTick(states, deps);
    assert.equal(deps.injected.length, 1, 'must inject when reset already passed and canonical banner at bottom');
    assert.deepEqual(deps.injected[0], ['projA:1', 'continue']);
    assert.equal(states.get('projA:1')!.status, 'monitoring');
  });

  it('monitoring: no snapshot, past reset, banner NOT at bottom → ignore, monitoring', async () => {
    const states: PaneStates = new Map();
    // Banner well above bottom — 20 non-empty lines follow, pushing it outside bottom-15 window
    const pastResetMidScreen =
      "You've hit your session limit · resets 3am (UTC)\n" +
      Array.from({ length: 20 }, (_, i) => `output line ${i + 1}`).join('\n');
    const deps = makeMultiDeps({
      targets: [tgt('projA:1')],
      screens: { 'projA:1': pastResetMidScreen },
      now: () => FIXED_NOW,
    });
    await multiTick(states, deps);
    assert.equal(deps.injected.length, 0, 'must NOT inject when banner not at bottom');
    assert.equal(states.get('projA:1')!.status, 'monitoring');
  });

  it('regression: monitoring banner + account limited (resetsAtMs future) → still enters waiting (unchanged)', async () => {
    const states: PaneStates = new Map();
    const futureReset = FIXED_NOW + 3_600_000; // 1h future
    const snapshot = makeSnapshot([[ACCOUNT_DIR, { limited: true, resetsAtMs: futureReset }]]);
    const marginSeconds = 60;
    const base = makeMultiDeps({
      targets: [tgt('projA:1')],
      screens: { 'projA:1': CANONICAL_BOTTOM_SCREEN },
      now: () => FIXED_NOW,
    });
    const deps: MultiMonitorDeps = {
      ...base,
      getAccountSnapshot: async () => snapshot,
      resolvePaneAccount: async (_t, _s) => ACCOUNT_DIR,
    };
    await multiTick(states, deps, marginSeconds);
    assert.equal(states.get('projA:1')!.status, 'waiting', 'limited account must still enter waiting');
    assert.equal(states.get('projA:1')!.waitUntil, futureReset + marginSeconds * 1000);
    assert.equal(base.injected.length, 0, 'must NOT inject when account still limited');
  });
});

// ---------------------------------------------------------------------------
// Fix: prose-mention guard — Hole B (false-park) and Hole A (false-inject)
// ---------------------------------------------------------------------------

describe('prose-mention guard — no canonical banner → no park and no inject', () => {
  // T1 (Hole B): monitoring state, captureText is prose mentioning rate limits
  // but NOT a canonical banner. Loose match() fires, but isBlockedAtBanner is
  // false → must NOT park to waiting.
  it('T1 Hole B: monitoring + loose-match prose (no canonical banner) → stays monitoring, not parked', async () => {
    const states: PaneStates = new Map();
    const proseText = 'discussing the rate-limit banner and when it resets';
    const deps = makeMultiDeps({
      targets: [tgt('projA:1')],
      screens: { 'projA:1': proseText },
      now: () => FIXED_NOW,
    });
    await multiTick(states, deps);
    assert.equal(states.get('projA:1')!.status, 'monitoring', 'prose must NOT park pane into waiting');
    assert.equal(states.get('projA:1')!.waitUntil, 0);
    assert.equal(deps.injected.length, 0, 'must NOT inject on prose mention');
  });

  // T2 (Hole A): pane already in waiting (timer elapsed), captureText is prose
  // that matches loose match() but NOT a canonical banner. Must abandon the
  // wait (set monitoring) and NOT inject continue.
  it('T2 Hole A: waiting + elapsed + loose-match prose (no canonical banner) → no inject, transitions to monitoring', async () => {
    const states: PaneStates = new Map();
    const state = createState();
    state.status = 'waiting';
    state.waitUntil = FIXED_NOW - 1; // already elapsed
    states.set('projA:1', state);

    const proseText = 'discussing the rate-limit banner and when it resets';
    const deps = makeMultiDeps({
      targets: [tgt('projA:1')],
      screens: { 'projA:1': proseText },
      now: () => FIXED_NOW,
    });
    await multiTick(states, deps);
    assert.equal(deps.injected.length, 0, 'must NOT inject when no canonical banner at bottom');
    assert.equal(states.get('projA:1')!.status, 'monitoring', 'must abandon wait when banner absent');
    assert.equal(states.get('projA:1')!.waitUntil, 0);
  });
});

// ---------------------------------------------------------------------------
// Loop order: tick-before-sleep
// ---------------------------------------------------------------------------

describe('runMonitor — tick fires before first sleep', () => {
  it('capture is called before sleep throws', async () => {
    const callOrder: string[] = [];
    const sentinel = new Error('sentinel-sleep');
    const deps: MonitorDeps = {
      capture: async (_paneId: string) => { callOrder.push('capture'); return ''; },
      inject: async () => {},
      now: () => FIXED_NOW,
      sleep: async () => { callOrder.push('sleep'); throw sentinel; },
    };
    try {
      await runMonitor('pane-1', deps);
    } catch (e) {
      if (e !== sentinel) throw e;
    }
    assert.ok(callOrder.indexOf('capture') < callOrder.indexOf('sleep'),
      'capture must be called before sleep');
    assert.ok(callOrder.filter(x => x === 'capture').length >= 1,
      'capture must have been called at least once');
  });
});

describe('runMultiMonitor — multiTick fires before first sleep', () => {
  it('listTargets is called before sleep throws', async () => {
    const callOrder: string[] = [];
    const sentinel = new Error('sentinel-sleep');
    const deps: MultiMonitorDeps = {
      listTargets: async () => { callOrder.push('listTargets'); return []; },
      capture: async () => '',
      inject: async () => {},
      now: () => FIXED_NOW,
      sleep: async () => { callOrder.push('sleep'); throw sentinel; },
    };
    try {
      await runMultiMonitor(deps);
    } catch (e) {
      if (e !== sentinel) throw e;
    }
    assert.ok(callOrder.indexOf('listTargets') < callOrder.indexOf('sleep'),
      'listTargets must be called before sleep');
    assert.ok(callOrder.filter(x => x === 'listTargets').length >= 1,
      'listTargets must have been called at least once');
  });
});
