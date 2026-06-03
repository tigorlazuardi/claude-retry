import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripAnsi, match } from '../src/patterns.ts';

// --- stripAnsi ---

test('stripAnsi: leaves plain text untouched', () => {
  assert.equal(stripAnsi('hello world'), 'hello world');
});

test('stripAnsi: strips CSI sequence (color code)', () => {
  assert.equal(stripAnsi('\x1b[31mred\x1b[0m'), 'red');
});

test('stripAnsi: strips OSC sequence (title set)', () => {
  assert.equal(stripAnsi('\x1b]0;title\x07plain'), 'plain');
});

test('stripAnsi: strips mixed sequences', () => {
  const input = '\x1b[1m\x1b]2;win\x07bold\x1b[0m text';
  assert.equal(stripAnsi(input), 'bold text');
});

// --- match: non-limited ---

test('match: empty string -> not limited', () => {
  assert.deepEqual(match(''), { limited: false, resetLine: null });
});

test('match: normal text -> not limited', () => {
  assert.deepEqual(match('everything is fine'), { limited: false, resetLine: null });
});

// --- match: single-line limit + reset ---

test('match: single line containing limit and resets', () => {
  const result = match('5-hour limit reached - resets 3pm');
  assert.equal(result.limited, true);
  assert.ok(result.resetLine !== null);
});

// --- match: multi-line within WINDOW ---

test('match: limit line + reset line 3 lines later -> limited', () => {
  const lines = [
    'normal line',
    '⚠ You\'ve hit your limit',
    'some other line',
    'another line',
    '· resets 3pm (UTC)',
  ];
  const result = match(lines.join('\n'));
  assert.equal(result.limited, true);
  assert.ok(result.resetLine !== null);
  assert.match(result.resetLine, /resets/i);
});

// --- match: reset too far away ---

test('match: limit line with reset >6 lines away -> limited but resetLine is limit line', () => {
  const lines = [
    'You have exceeded the usage limit',
    'line1', 'line2', 'line3', 'line4', 'line5', 'line6', 'line7',
    'resets at midnight',
  ];
  const result = match(lines.join('\n'));
  assert.equal(result.limited, true);
  // reset is 8 lines away, outside WINDOW=6; resetLine should be limit line itself
  assert.match(result.resetLine ?? '', /usage limit/i);
});

// --- match: "usage limit" + "resets at 5:00 PM" ---

test('match: "usage limit" + nearby "resets at 5:00 PM"', () => {
  const text = 'You have hit your usage limit\nresets at 5:00 PM';
  const result = match(text);
  assert.equal(result.limited, true);
  assert.ok(result.resetLine !== null);
});

// --- match: real Claude Code "session limit" banner ---

test('match: "session limit" banner with same-line reset + IANA tz', () => {
  const text =
    "You've hit your session limit · resets 12:50am (Asia/Jakarta)\n" +
    '/upgrade to increase your usage limit.';
  const result = match(text);
  assert.equal(result.limited, true);
  assert.match(result.resetLine ?? '', /session limit/i);
  assert.match(result.resetLine ?? '', /resets 12:50am/i);
});

// --- match: "rate limit" + "try again in 2 hours" ---

test('match: "rate limit" + "try again in 2 hours"', () => {
  const text = 'rate limit exceeded\ntry again in 2 hours';
  const result = match(text);
  assert.equal(result.limited, true);
  assert.match(result.resetLine ?? '', /try again/i);
});
