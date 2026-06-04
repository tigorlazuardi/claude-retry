import * as os from 'node:os';
import * as path from 'node:path';
import { readFile as fsReadFile } from 'node:fs/promises';
export const LIMIT_THRESHOLD = (() => {
    const raw = process.env['CLAUDE_RETRY_LIMIT_THRESHOLD'];
    if (raw !== undefined) {
        const n = Number(raw);
        if (!Number.isNaN(n))
            return n;
    }
    return 90;
})();
export function defaultConfigDir(env) {
    const e = env ?? process.env;
    return e['CLAUDE_CONFIG_DIR'] || path.join(os.homedir(), '.claude');
}
export async function readAccessToken(configDir, readFile = (p) => fsReadFile(p, 'utf8')) {
    try {
        const credPath = path.join(configDir, '.credentials.json');
        const raw = await readFile(credPath);
        const parsed = JSON.parse(raw);
        const oauth = parsed['claudeAiOauth'];
        if (oauth === null || typeof oauth !== 'object')
            return null;
        const oauthObj = oauth;
        const token = oauthObj['accessToken'];
        if (typeof token !== 'string' || token === '')
            return null;
        const expiresAt = oauthObj['expiresAt'];
        const expiresAtMs = typeof expiresAt === 'number' ? expiresAt : null;
        return { token, expiresAtMs };
    }
    catch {
        return null;
    }
}
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const WINDOW_KEYS = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet'];
function defaultFetchFn(url, init) {
    return fetch(url, init).then((r) => ({
        status: r.status,
        json: () => r.json(),
    }));
}
export async function fetchUsage(token, fetchFn = defaultFetchFn, threshold = LIMIT_THRESHOLD) {
    try {
        const res = await fetchFn(USAGE_URL, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'anthropic-beta': 'oauth-2025-04-20',
                'anthropic-version': '2023-06-01',
            },
        });
        if (res.status !== 200)
            return null;
        const body = await res.json();
        if (body === null || typeof body !== 'object')
            return null;
        const data = body;
        const windows = [];
        for (const key of WINDOW_KEYS) {
            const w = data[key];
            if (w === null || w === undefined || typeof w !== 'object')
                continue;
            const wObj = w;
            const utilization = wObj['utilization'];
            const resetsAt = wObj['resets_at'];
            if (typeof utilization !== 'number')
                continue;
            const resetsAtMs = typeof resetsAt === 'string' ? Date.parse(resetsAt) : null;
            windows.push({ utilization, resetsAtMs: resetsAtMs !== null && !Number.isNaN(resetsAtMs) ? resetsAtMs : null });
        }
        const overThreshold = windows.filter((w) => w.utilization >= threshold);
        const limited = overThreshold.length > 0;
        let resetsAtMs = null;
        if (limited) {
            for (const w of overThreshold) {
                if (w.resetsAtMs !== null) {
                    if (resetsAtMs === null || w.resetsAtMs > resetsAtMs) {
                        resetsAtMs = w.resetsAtMs;
                    }
                }
            }
        }
        return { limited, resetsAtMs };
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=usage.js.map