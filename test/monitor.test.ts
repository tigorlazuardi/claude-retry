import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createState, tick, type MonitorDeps } from '../src/monitor.ts';

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
