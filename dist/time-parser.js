const RESET_TIME_REGEX = /resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:\(([^)]+)\))?/i;
const RELATIVE_TIME_REGEX = /(?:try again|wait|resets?\s+in)[:\s]\s*(?:for\s+)?(?:in\s+)?(\d+)\s*(hours?|minutes?|mins?|h|m)\b/i;
export function parseResetTime(text) {
    const relMatch = RELATIVE_TIME_REGEX.exec(text);
    if (relMatch) {
        const amount = parseInt(relMatch[1], 10);
        const unit = relMatch[2].toLowerCase();
        const isHours = unit.startsWith('h');
        const waitMs = isHours ? amount * 3600000 : amount * 60000;
        return { relative: true, waitMs };
    }
    const absMatch = RESET_TIME_REGEX.exec(text);
    if (absMatch) {
        let hour = parseInt(absMatch[1], 10);
        const minute = absMatch[2] ? parseInt(absMatch[2], 10) : 0;
        const meridiem = absMatch[3] ? absMatch[3].toLowerCase() : null;
        const timezone = absMatch[4] ? absMatch[4].trim() : null;
        const ambiguous = meridiem === null;
        if (!ambiguous) {
            if (meridiem === 'pm' && hour !== 12) {
                hour += 12;
            }
            else if (meridiem === 'am' && hour === 12) {
                hour = 0;
            }
        }
        return { hour, minute, timezone, ambiguous };
    }
    return null;
}
function getOffsetMs(timezone, date) {
    try {
        // Format the date in the target timezone to get local time
        const formatter = new Intl.DateTimeFormat('en-US', {
            timeZone: timezone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false,
        });
        const parts = formatter.formatToParts(date);
        const get = (type) => parseInt(parts.find((p) => p.type === type)?.value ?? '0', 10);
        const year = get('year');
        const month = get('month') - 1;
        const day = get('day');
        const hour = get('hour') % 24; // hour12:false can give 24 for midnight
        const minute = get('minute');
        const second = get('second');
        const localMs = Date.UTC(year, month, day, hour, minute, second);
        return date.getTime() - localMs;
    }
    catch {
        return 0; // invalid timezone — offset unknown
    }
}
function isValidTimezone(tz) {
    try {
        Intl.DateTimeFormat(undefined, { timeZone: tz });
        return true;
    }
    catch {
        return false;
    }
}
export function calculateWaitMs(parsed, marginSeconds = 60, fallbackHours = 5, now = new Date()) {
    const fallbackMs = fallbackHours * 3600000 + marginSeconds * 1000;
    if (parsed === null) {
        return fallbackMs;
    }
    if ('relative' in parsed) {
        return parsed.waitMs + marginSeconds * 1000;
    }
    // Absolute time
    const { hour, minute, timezone, ambiguous } = parsed;
    const tryCalculate = (h) => {
        if (timezone && isValidTimezone(timezone)) {
            // DST-safe: build a candidate time in the target timezone
            // Start from "today" in that timezone and find next occurrence of h:minute
            const nowMs = now.getTime();
            const tzOffset = getOffsetMs(timezone, now);
            // Local time in target tz
            const localMs = nowMs - tzOffset;
            const localDate = new Date(localMs);
            const localMidnight = Date.UTC(localDate.getUTCFullYear(), localDate.getUTCMonth(), localDate.getUTCDate());
            // Candidate: today at h:minute in that tz
            let candidateLocalMs = localMidnight + h * 3600000 + minute * 60000;
            let candidateUtcMs = candidateLocalMs + tzOffset;
            // DST correction: the offset may differ at the candidate time
            // Iteratively correct until stable
            for (let i = 0; i < 3; i++) {
                const candidateDate = new Date(candidateUtcMs);
                const candidateTzOffset = getOffsetMs(timezone, candidateDate);
                const corrected = candidateLocalMs + candidateTzOffset;
                if (corrected === candidateUtcMs)
                    break;
                candidateUtcMs = corrected;
            }
            if (candidateUtcMs <= nowMs) {
                // Tomorrow rollover — advance local midnight by one day
                candidateLocalMs += 86400000;
                candidateUtcMs = candidateLocalMs + tzOffset;
                for (let i = 0; i < 3; i++) {
                    const candidateDate = new Date(candidateUtcMs);
                    const candidateTzOffset = getOffsetMs(timezone, candidateDate);
                    const corrected = candidateLocalMs + candidateTzOffset;
                    if (corrected === candidateUtcMs)
                        break;
                    candidateUtcMs = corrected;
                }
            }
            return candidateUtcMs - nowMs + marginSeconds * 1000;
        }
        else {
            // No timezone or invalid — assume UTC
            const nowMs = now.getTime();
            const nowDate = now;
            const midnight = Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth(), nowDate.getUTCDate());
            let candidateMs = midnight + h * 3600000 + minute * 60000;
            if (candidateMs <= nowMs) {
                candidateMs += 86400000;
            }
            return candidateMs - nowMs + marginSeconds * 1000;
        }
    };
    if (ambiguous) {
        // No am/pm: check both interpretations, pick the sooner future one
        const pmHour = hour === 12 ? 12 : hour + 12;
        const amHour = hour === 12 ? 0 : hour;
        const waitAm = tryCalculate(amHour);
        const waitPm = tryCalculate(pmHour);
        // Return the sooner positive wait
        if (waitAm > 0 && waitPm > 0)
            return Math.min(waitAm, waitPm);
        if (waitAm > 0)
            return waitAm;
        if (waitPm > 0)
            return waitPm;
        return fallbackMs;
    }
    const wait = tryCalculate(hour);
    if (wait <= 0)
        return fallbackMs;
    return wait;
}
//# sourceMappingURL=time-parser.js.map