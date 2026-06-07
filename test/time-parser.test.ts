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

  it('invalid timezone → falls back to UTC calc (future time still positive)', () => {
    const parsed = {
      hour: 15,
      minute: 0,
      timezone: 'Not/AReal_Zone',
      ambiguous: false,
    };
    const result = calculateWaitMs(parsed, 60, 5, fixedNow);
    // Invalid tz falls back to UTC; 15:00 UTC is future from 10:00 UTC → positive
    assert.ok(result > 0, `expected positive ms, got ${result}`);
  });

  // --- past absolute time: already reset ---

  it('past absolute UTC: resets 12:30, now=13:43 → non-positive (already reset)', () => {
    // now = 2024-01-15T13:43:00Z, reset was at 12:30 UTC (73 min ago)
    const pastNow = new Date('2024-01-15T13:43:00Z');
    const parsed = {
      hour: 12,
      minute: 30,
      timezone: 'UTC',
      ambiguous: false,
    };
    const result = calculateWaitMs(parsed, 60, 5, pastNow);
    assert.ok(result <= 0, `expected <= 0 (already reset), got ${result}`);
    // Should be approximately -(73 min in ms) = -4380000
    const expectedDelta = new Date('2024-01-15T12:30:00Z').getTime() - pastNow.getTime();
    assert.equal(result, expectedDelta);
  });

  it('future absolute UTC: resets 15:00, now=14:00 → ~1h + margin positive', () => {
    const futureNow = new Date('2024-01-15T14:00:00Z');
    const parsed = {
      hour: 15,
      minute: 0,
      timezone: 'UTC',
      ambiguous: false,
    };
    const result = calculateWaitMs(parsed, 60, 5, futureNow);
    const expected = 3600000 + 60000; // 1h + 60s margin
    assert.equal(result, expected);
  });

  it('ambiguous: both interpretations past → non-positive (most recent reset)', () => {
    // now = 2024-01-15T23:00:00Z
    // "resets 10" → am=10:00 (13h ago), pm=22:00 (1h ago)
    // both past; pm (22:00) is more recent → least-negative wins
    const lateNow = new Date('2024-01-15T23:00:00Z');
    const parsed = {
      hour: 10,
      minute: 0,
      timezone: 'UTC',
      ambiguous: true,
    };
    const result = calculateWaitMs(parsed, 60, 5, lateNow);
    assert.ok(result <= 0, `expected <= 0, got ${result}`);
    // pm interpretation: 22:00, delta = 22:00 - 23:00 = -3600000
    assert.equal(result, -3600000);
  });

  it('relative 2h wait → positive ~2h + margin', () => {
    const parsed = { relative: true as const, waitMs: 7200000 };
    const result = calculateWaitMs(parsed, 60, 5, fixedNow);
    assert.equal(result, 7200000 + 60000);
  });

  it('null parsed → fallbackMs positive', () => {
    const result = calculateWaitMs(null, 60, 5, fixedNow);
    assert.ok(result > 0, `expected positive fallback, got ${result}`);
    assert.equal(result, 5 * 3600000 + 60000);
  });

  it('past absolute with tz: Eastern reset at 08:00, now=14:00 UTC (9am Eastern) → non-positive', () => {
    // fixedNow = 2024-01-15T14:00:00Z = 9:00am Eastern (UTC-5 in Jan)
    // reset was at 8:00 Eastern = 13:00 UTC (1h ago)
    const tzNow = new Date('2024-01-15T14:00:00Z');
    const parsed = {
      hour: 8,
      minute: 0,
      timezone: 'America/New_York',
      ambiguous: false,
    };
    const result = calculateWaitMs(parsed, 60, 5, tzNow);
    assert.ok(result <= 0, `expected <= 0 (already reset), got ${result}`);
  });
});
