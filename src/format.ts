/**
 * Local-time formatting helpers.
 * All output uses the machine's local timezone (not UTC).
 */

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * Local wall-clock "HH:MM:SS" (24h).
 * @param ms - epoch ms; defaults to Date.now() when omitted.
 */
export function formatClock(ms?: number): string {
  const d = new Date(ms ?? Date.now());
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/**
 * Local "YYYY-MM-DD HH:MM:SS TZ" (e.g. "2026-06-07 14:05:09 GMT+7").
 * The TZ suffix is derived from Intl.DateTimeFormat; omitted gracefully if unavailable.
 */
export function formatLocalDateTime(ms: number): string {
  const d = new Date(ms);
  const date = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;

  let tz = '';
  try {
    const parts = Intl.DateTimeFormat(undefined, { timeZoneName: 'short' }).formatToParts(d);
    const tzPart = parts.find((p) => p.type === 'timeZoneName');
    if (tzPart?.value) tz = ` ${tzPart.value}`;
  } catch {
    // Intl unavailable or failed — omit TZ suffix
  }

  return `${date} ${time}${tz}`;
}
