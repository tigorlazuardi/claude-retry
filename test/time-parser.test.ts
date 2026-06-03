import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseResetTime,
  calculateWaitMs,
  type AbsoluteTime,
} from '../src/time-parser.ts';

describe('parseResetTime', () => {
  it('parses absolute pm time with UTC timezone', () => {
    const result = parseResetTime('resets 3pm (UTC)');
    assert.deepEqual(result, {
      hour: 15,
      minute: 0,
      timezone: 'UTC',
      ambiguous: false,
    });
  });

  it('parses absolute PM time with minutes and named timezone', () => {
    const result = parseResetTime('resets at 3:30 PM (America/New_York)');
    assert.deepEqual(result, {
      hour: 15,
      minute: 30,
      timezone: 'America/New_York',
      ambiguous: false,
    });
  });

  it('parses relative hours', () => {
    const result = parseResetTime('try again in 5 hours');
    assert.deepEqual(result, { relative: true, waitMs: 18000000 });
  });

  it('parses relative minutes', () => {
    const result = parseResetTime('wait 30 minutes');
    assert.deepEqual(result, { relative: true, waitMs: 1800000 });
  });

  it('returns null for no match', () => {
    const result = parseResetTime('no match here');
    assert.equal(result, null);
  });

  it('returns ambiguous when no am/pm given', () => {
    const result = parseResetTime('resets 3') as AbsoluteTime;
    assert.equal(result.ambiguous, true);
    assert.equal(result.hour, 3);
    assert.equal(result.minute, 0);
  });
});

describe('calculateWaitMs', () => {
  // Fixed now: 2024-01-15T10:00:00Z (10am UTC, Monday)
  const fixedNow = new Date('2024-01-15T10:00:00Z');

  it('UTC reset at 15:00 → exactly 5h + 60s margin', () => {
    const parsed = {
      hour: 15,
      minute: 0,
      timezone: 'UTC',
      ambiguous: false,
    };
    const expected = 5 * 3600 * 1000 + 60 * 1000; // 18060000
    const result = calculateWaitMs(parsed, 60, 5, fixedNow);
    assert.equal(result, expected);
  });

  it('relative 30-min wait → 1800000 + 60000 = 1860000 ms', () => {
    const parsed = { relative: true as const, waitMs: 1800000 };
    const result = calculateWaitMs(parsed, 60, 5, fixedNow);
    assert.equal(result, 1860000);
  });

  it('null → fallback 5h + 60s = 18060000 ms', () => {
    const result = calculateWaitMs(null, 60, 5, fixedNow);
    assert.equal(result, 18060000);
  });

  it('DST: Eastern reset at 5pm → ~12h wait from 10am UTC', () => {
    // fixedNow = 2024-01-15T10:00:00Z
    // Eastern in January = UTC-5 → 10am UTC = 5am Eastern
    // 5pm Eastern = 22:00 UTC → wait ≈ 12h
    const parsed = {
      hour: 17,
      minute: 0,
      timezone: 'America/New_York',
      ambiguous: false,
    };
    const result = calculateWaitMs(parsed, 60, 5, fixedNow);
    assert.ok(
      result > 11 * 3600 * 1000,
      `expected > 11h, got ${result / 3600000}h`
    );
    assert.ok(
      result < 13 * 3600 * 1000,
      `expected < 13h, got ${result / 3600000}h`
    );
  });

  it('invalid timezone → fallback ms', () => {
    const parsed = {
      hour: 15,
      minute: 0,
      timezone: 'Not/AReal_Zone',
      ambiguous: false,
    };
    const result = calculateWaitMs(parsed, 60, 5, fixedNow);
    // Falls back to UTC calculation or fallback — either way should not throw
    // and should be a positive number
    assert.ok(result > 0, `expected positive ms, got ${result}`);
  });
});
