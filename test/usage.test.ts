import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  defaultConfigDir,
  readAccessToken,
  fetchUsage,
  LIMIT_THRESHOLD,
} from '../src/usage.ts';

// --- defaultConfigDir ---

test('defaultConfigDir: returns CLAUDE_CONFIG_DIR when set', () => {
  const result = defaultConfigDir({ CLAUDE_CONFIG_DIR: '/custom/dir' });
  assert.equal(result, '/custom/dir');
});

test('defaultConfigDir: falls back to ~/.claude when env not set', () => {
  const result = defaultConfigDir({});
  assert.equal(result, path.join(os.homedir(), '.claude'));
});

test('defaultConfigDir: falls back when env is undefined', () => {
  const result = defaultConfigDir(undefined);
  assert.equal(result, path.join(os.homedir(), '.claude'));
});

// --- readAccessToken ---

test('readAccessToken: parses token and expiresAt from valid credentials', async () => {
  const creds = JSON.stringify({
    claudeAiOauth: {
      accessToken: 'tok_abc123',
      expiresAt: 1700000000000,
    },
  });
  const readFile = async (_p: string) => creds;
  const result = await readAccessToken('/some/dir', readFile);
  assert.deepEqual(result, { token: 'tok_abc123', expiresAtMs: 1700000000000 });
});

test('readAccessToken: null expiresAtMs when expiresAt missing', async () => {
  const creds = JSON.stringify({
    claudeAiOauth: { accessToken: 'tok_abc123' },
  });
  const readFile = async (_p: string) => creds;
  const result = await readAccessToken('/some/dir', readFile);
  assert.deepEqual(result, { token: 'tok_abc123', expiresAtMs: null });
});

test('readAccessToken: returns null when file missing', async () => {
  const readFile = async (_p: string): Promise<string> => {
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  };
  const result = await readAccessToken('/some/dir', readFile);
  assert.equal(result, null);
});

test('readAccessToken: returns null on garbage json', async () => {
  const readFile = async (_p: string) => 'not { valid json!!!';
  const result = await readAccessToken('/some/dir', readFile);
  assert.equal(result, null);
});

test('readAccessToken: returns null when accessToken missing', async () => {
  const creds = JSON.stringify({ claudeAiOauth: {} });
  const readFile = async (_p: string) => creds;
  const result = await readAccessToken('/some/dir', readFile);
  assert.equal(result, null);
});

test('readAccessToken: returns null when claudeAiOauth key missing', async () => {
  const creds = JSON.stringify({ other: 'data' });
  const readFile = async (_p: string) => creds;
  const result = await readAccessToken('/some/dir', readFile);
  assert.equal(result, null);
});

// --- LIMIT_THRESHOLD ---

test('LIMIT_THRESHOLD is 90', () => {
  assert.equal(LIMIT_THRESHOLD, 90);
});

// --- fetchUsage ---

function makeFetch(status: number, body: unknown) {
  return async (_url: string, _init: { headers: Record<string, string> }) => ({
    status,
    json: async () => body,
  });
}

const RESET_A = '2026-06-04T08:50:00+00:00';
const RESET_B = '2026-06-05T07:00:00+00:00';
const RESET_A_MS = Date.parse(RESET_A);
const RESET_B_MS = Date.parse(RESET_B);

test('fetchUsage: not limited when all windows below threshold', async () => {
  const body = {
    five_hour: { utilization: 5, resets_at: RESET_A },
    seven_day: { utilization: 44, resets_at: RESET_B },
    seven_day_opus: null,
    seven_day_sonnet: null,
  };
  const result = await fetchUsage('tok', makeFetch(200, body));
  assert.deepEqual(result, { limited: false, resetsAtMs: null });
});

test('fetchUsage: limited when one window >= threshold', async () => {
  const body = {
    five_hour: { utilization: 95, resets_at: RESET_A },
    seven_day: { utilization: 44, resets_at: RESET_B },
    seven_day_opus: null,
    seven_day_sonnet: null,
  };
  const result = await fetchUsage('tok', makeFetch(200, body));
  assert.deepEqual(result, { limited: true, resetsAtMs: RESET_A_MS });
});

test('fetchUsage: limited when multiple windows over threshold, picks latest reset', async () => {
  const body = {
    five_hour: { utilization: 95, resets_at: RESET_A },
    seven_day: { utilization: 91, resets_at: RESET_B },
    seven_day_opus: null,
    seven_day_sonnet: null,
  };
  const result = await fetchUsage('tok', makeFetch(200, body));
  assert.deepEqual(result, { limited: true, resetsAtMs: RESET_B_MS });
});

test('fetchUsage: null window entries are skipped', async () => {
  const body = {
    five_hour: { utilization: 95, resets_at: RESET_A },
    seven_day: null,
    seven_day_opus: null,
    seven_day_sonnet: null,
  };
  const result = await fetchUsage('tok', makeFetch(200, body));
  assert.deepEqual(result, { limited: true, resetsAtMs: RESET_A_MS });
});

test('fetchUsage: returns null on non-200 status', async () => {
  const body = { error: 'unauthorized' };
  const result = await fetchUsage('tok', makeFetch(401, body));
  assert.equal(result, null);
});

test('fetchUsage: returns null on 500', async () => {
  const result = await fetchUsage('tok', makeFetch(500, {}));
  assert.equal(result, null);
});

test('fetchUsage: returns null on network error', async () => {
  const fetchFn = async (_url: string, _init: { headers: Record<string, string> }) => {
    throw new Error('network failure');
  };
  const result = await fetchUsage('tok', fetchFn);
  assert.equal(result, null);
});

test('fetchUsage: returns null on bad json (json() throws)', async () => {
  const fetchFn = async (_url: string, _init: { headers: Record<string, string> }) => ({
    status: 200,
    json: async (): Promise<unknown> => { throw new Error('bad json'); },
  });
  const result = await fetchUsage('tok', fetchFn);
  assert.equal(result, null);
});

test('fetchUsage: threshold boundary — exactly at threshold is limited', async () => {
  const body = {
    five_hour: { utilization: 90, resets_at: RESET_A },
    seven_day: { utilization: 44, resets_at: RESET_B },
    seven_day_opus: null,
    seven_day_sonnet: null,
  };
  const result = await fetchUsage('tok', makeFetch(200, body), 90);
  assert.deepEqual(result, { limited: true, resetsAtMs: RESET_A_MS });
});

test('fetchUsage: threshold boundary — just below threshold is not limited', async () => {
  const body = {
    five_hour: { utilization: 89.9, resets_at: RESET_A },
    seven_day: { utilization: 44, resets_at: RESET_B },
    seven_day_opus: null,
    seven_day_sonnet: null,
  };
  const result = await fetchUsage('tok', makeFetch(200, body), 90);
  assert.deepEqual(result, { limited: false, resetsAtMs: null });
});

test('fetchUsage: custom threshold overrides default', async () => {
  const body = {
    five_hour: { utilization: 50, resets_at: RESET_A },
    seven_day: { utilization: 44, resets_at: RESET_B },
    seven_day_opus: null,
    seven_day_sonnet: null,
  };
  // threshold=40 → both 50 and 44 >= 40 → limited, max reset = RESET_B (seven_day)
  const result = await fetchUsage('tok', makeFetch(200, body), 40);
  assert.deepEqual(result, { limited: true, resetsAtMs: RESET_B_MS });
});

test('fetchUsage: sends correct Authorization header', async () => {
  let capturedInit: { headers: Record<string, string> } | undefined;
  const body = {
    five_hour: { utilization: 5, resets_at: RESET_A },
    seven_day: { utilization: 5, resets_at: RESET_B },
    seven_day_opus: null,
    seven_day_sonnet: null,
  };
  const fetchFn = async (_url: string, init: { headers: Record<string, string> }) => {
    capturedInit = init;
    return { status: 200, json: async () => body };
  };
  await fetchUsage('my_token', fetchFn);
  assert.equal(capturedInit?.headers['Authorization'], 'Bearer my_token');
  assert.equal(capturedInit?.headers['anthropic-beta'], 'oauth-2025-04-20');
  assert.equal(capturedInit?.headers['anthropic-version'], '2023-06-01');
});
