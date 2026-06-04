import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createState,
  tick,
  multiTick,
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
    const deps = makeDeps({ now: () => FIXED_NOW });
    const status = await tick('pane-1', state, deps);
    assert.equal(status, 'rate-limited');
    assert.equal(deps.injected.length, 0);
    assert.equal(state.status, 'waiting');
  });

  it('injects continue and resets state when wait period elapsed (now >= waitUntil)', async () => {
    const state = createState();
    state.status = 'waiting';
    state.waitUntil = FIXED_NOW - 1; // already in the past
    const deps = makeDeps({ now: () => FIXED_NOW });
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

  it('prunes state when a target disappears', async () => {
    const states: PaneStates = new Map();
    states.set('gone:9', createState());
    states.get('gone:9')!.status = 'waiting';
    const deps = makeMultiDeps({ targets: [tgt('projA:1')], screens: { 'projA:1': 'ready' } });
    await multiTick(states, deps);
    assert.equal(states.has('gone:9'), false);
    assert.equal(states.has('projA:1'), true);
  });

  it('picks up a newly appeared Claude pane on a later pass', async () => {
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
