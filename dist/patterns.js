const CSI_REGEX = /\x1b\[[\x20-\x3f]*[\x40-\x7e]/g;
const OSC_REGEX = /\x1b\][\s\S]*?(?:\x07|\x1b\\)/g;
const DCS_REGEX = /\x1bP[\s\S]*?(?:\x07|\x1b\\)/g;
const OTHER_ESC_REGEX = /\x1b[_X^][\s\S]*?(?:\x07|\x1b\\)/g;
export function stripAnsi(text) {
    return text
        .replace(CSI_REGEX, '')
        .replace(OSC_REGEX, '')
        .replace(DCS_REGEX, '')
        .replace(OTHER_ESC_REGEX, '');
}
const LIMIT_PATTERNS = [
    /claude\.ai\/settings/i,
    /usage limit/i,
    /rate.?limit/i,
    /\blimit\b.*\breached\b/i,
    /\breached\b.*\blimit\b/i,
    /\bhit\b.*\blimit\b/i,
    /\blimit\b.*\bexceeded\b/i,
];
const RESET_PATTERNS = [
    /reset/i,
    /try again/i,
    /available/i,
];
const WINDOW = 6;
export function match(text) {
    const stripped = stripAnsi(text);
    const lines = stripped.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const isLimitLine = LIMIT_PATTERNS.some((p) => p.test(line));
        if (!isLimitLine)
            continue;
        // Search nearby lines (within WINDOW) for a reset line
        const start = Math.max(0, i - WINDOW);
        const end = Math.min(lines.length - 1, i + WINDOW);
        for (let j = start; j <= end; j++) {
            const nearby = lines[j];
            if (RESET_PATTERNS.some((p) => p.test(nearby))) {
                return { limited: true, resetLine: nearby.trim() };
            }
        }
        // No reset line found nearby — return the limit line itself
        return { limited: true, resetLine: line.trim() };
    }
    return { limited: false, resetLine: null };
}
//# sourceMappingURL=patterns.js.map