import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { stripAnsi, match, strictMatch, isBlockedAtBanner } from '../src/patterns.ts';

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

// --- strictMatch + isBlockedAtBanner ---

describe('strictMatch', () => {
  // True cases — canonical phrases
  test('you\'ve hit your session limit', () => {
    assert.equal(strictMatch("You've hit your session limit · resets 12:50am (Asia/Jakarta)"), true);
  });

  test('you’ve hit your session limit (curly apostrophe)', () => {
    assert.equal(strictMatch('You’ve hit your session limit · resets 1:00am'), true);
  });

  test('you have hit your usage limit', () => {
    assert.equal(strictMatch('you have hit your usage limit'), true);
  });

  test('5-hour limit reached', () => {
    assert.equal(strictMatch('5-hour limit reached'), true);
  });

  test('12-hour limit reached', () => {
    assert.equal(strictMatch('12-hour limit reached'), true);
  });

  test('usage limit reached', () => {
    assert.equal(strictMatch('usage limit reached'), true);
  });

  test('session limit ... resets on same line', () => {
    assert.equal(strictMatch('session limit · resets at 3:00pm'), true);
  });

  test('upgrade to increase your usage limit', () => {
    assert.equal(strictMatch('upgrade to increase your usage limit'), true);
  });

  test('strips ANSI before matching', () => {
    assert.equal(strictMatch('\x1b[31mYou’ve hit your session limit\x1b[0m · resets 2am'), true);
  });

  // False cases — incidental text
  test('false: discussed rate limit and reset logic', () => {
    assert.equal(strictMatch('we discussed the rate limit and reset logic'), false);
  });

  test('false: markdown table with rate limit column', () => {
    assert.equal(strictMatch('| Rate limit | API gate |'), false);
  });

  test('false: stale banner ignored', () => {
    assert.equal(strictMatch('stale banner ignored'), false);
  });

  test('false: plain normal text', () => {
    assert.equal(strictMatch('everything looks fine'), false);
  });
});

describe('isBlockedAtBanner', () => {
  const BANNER = "You've hit your session limit · resets 12:50am (Asia/Jakarta)";
  const INPUT_PROMPT = '> ';
  const NORMAL_LINES = Array.from({ length: 20 }, (_, i) => `normal log line ${i + 1}`);

  test('true: banner near bottom + input prompt at very bottom', () => {
    const text = [...NORMAL_LINES, BANNER, INPUT_PROMPT].join('\n');
    assert.equal(isBlockedAtBanner(text), true);
  });

  test('true: banner is last non-empty line', () => {
    const text = [...NORMAL_LINES, BANNER, '', ''].join('\n');
    assert.equal(isBlockedAtBanner(text), true);
  });

  test('false: banner at top, bottom filled with normal output (bottom-anchor test)', () => {
    // Banner on line 1, then 20 lines of normal text — banner NOT in bottom window
    const text = [BANNER, ...NORMAL_LINES].join('\n');
    assert.equal(isBlockedAtBanner(text), false);
  });

  test('false: purely incidental text anywhere', () => {
    const text = [
      'we discussed the rate limit and reset logic',
      ...NORMAL_LINES,
      '| Rate limit | API gate |',
    ].join('\n');
    assert.equal(isBlockedAtBanner(text), false);
  });

  test('false: empty string', () => {
    assert.equal(isBlockedAtBanner(''), false);
  });

  test('custom bottomLines: banner just outside window -> false', () => {
    // 3-line window; banner is 5 non-empty lines from bottom
    const lines = [BANNER, 'a', 'b', 'c', 'd', 'e'];
    assert.equal(isBlockedAtBanner(lines.join('\n'), 3), false);
  });

  test('custom bottomLines: banner just inside window -> true', () => {
    const lines = [BANNER, 'a', 'b'];
    assert.equal(isBlockedAtBanner(lines.join('\n'), 3), true);
  });
});
