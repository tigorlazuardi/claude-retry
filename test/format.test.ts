import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

// Fix TZ before any imports that read Date so local components are deterministic.
process.env.TZ = 'Asia/Jakarta'; // UTC+7

// Dynamic import AFTER setting TZ so the module picks up the env.
const { formatClock, formatLocalDateTime } = await import('../src/format.ts');

// A fixed moment: 2026-06-07 14:05:09 local (Asia/Jakarta = UTC+7)
// UTC equivalent: 2026-06-07T07:05:09Z
const FIXED_MS = new Date('2026-06-07T07:05:09Z').getTime();

// A moment that exercises zero-padding: 2026-06-07 09:05:03 local
// UTC equivalent: 2026-06-07T02:05:03Z
const PADDED_MS = new Date('2026-06-07T02:05:03Z').getTime();

describe('formatClock', () => {
  it('returns HH:MM:SS in local time', () => {
    const result = formatClock(FIXED_MS);
    assert.equal(result, '14:05:09');
  });

  it('zero-pads hours, minutes, seconds', () => {
    const result = formatClock(PADDED_MS);
    assert.equal(result, '09:05:03');
  });

  it('uses Date.now() when ms is undefined (returns non-empty string)', () => {
    const result = formatClock();
    assert.match(result, /^\d{2}:\d{2}:\d{2}$/, 'should be HH:MM:SS');
  });
});

describe('formatLocalDateTime', () => {
  it('returns correct date and time portion in local zone', () => {
    const result = formatLocalDateTime(FIXED_MS);
    // Date/time prefix must be exact
    assert.ok(
      result.startsWith('2026-06-07 14:05:09'),
      `expected "2026-06-07 14:05:09..." got "${result}"`,
    );
  });

  it('zero-pads all components', () => {
    const result = formatLocalDateTime(PADDED_MS);
    assert.ok(
      result.startsWith('2026-06-07 09:05:03'),
      `expected "2026-06-07 09:05:03..." got "${result}"`,
    );
  });

  it('appends a non-empty TZ suffix', () => {
    const result = formatLocalDateTime(FIXED_MS);
    // Should have something after the datetime, e.g. " GMT+7" or " WIB"
    const suffix = result.slice('2026-06-07 14:05:09'.length);
    assert.ok(suffix.trim().length > 0, `expected a TZ suffix, got "${result}"`);
  });
});
