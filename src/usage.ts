import * as os from 'node:os';
import * as path from 'node:path';
import { readFile as fsReadFile } from 'node:fs/promises';

export interface WindowUsage {
  utilization: number;
  resetsAtMs: number | null;
}

export interface AccountUsage {
  limited: boolean;
  resetsAtMs: number | null;
}

export type FetchFn = (
  url: string,
  init: { headers: Record<string, string> },
) => Promise<{ status: number; json: () => Promise<unknown> }>;

export type ReadFileFn = (path: string) => Promise<string>;

export const LIMIT_THRESHOLD: number = (() => {
  const raw = process.env['CLAUDE_RETRY_LIMIT_THRESHOLD'];
  if (raw !== undefined) {
    const n = Number(raw);
    if (!Number.isNaN(n)) return n;
  }
  return 90;
})();

export function defaultConfigDir(env?: NodeJS.ProcessEnv): string {
  const e = env ?? process.env;
  return e['CLAUDE_CONFIG_DIR'] || path.join(os.homedir(), '.claude');
}

export async function readAccessToken(
  configDir: string,
  readFile: ReadFileFn = (p) => fsReadFile(p, 'utf8'),
): Promise<{ token: string; expiresAtMs: number | null } | null> {
  try {
    const credPath = path.join(configDir, '.credentials.json');
    const raw = await readFile(credPath);
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const oauth = parsed['claudeAiOauth'];
    if (oauth === null || typeof oauth !== 'object') return null;
    const oauthObj = oauth as Record<string, unknown>;
    const token = oauthObj['accessToken'];
    if (typeof token !== 'string' || token === '') return null;
    const expiresAt = oauthObj['expiresAt'];
    const expiresAtMs =
      typeof expiresAt === 'number' ? expiresAt : null;
    return { token, expiresAtMs };
  } catch {
    return null;
  }
}

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const WINDOW_KEYS = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet'] as const;

function defaultFetchFn(url: string, init: { headers: Record<string, string> }) {
  return fetch(url, init).then((r) => ({
    status: r.status,
    json: () => r.json() as Promise<unknown>,
  }));
}

export async function fetchUsage(
  token: string,
  fetchFn: FetchFn = defaultFetchFn,
  threshold: number = LIMIT_THRESHOLD,
): Promise<AccountUsage | null> {
  try {
    const res = await fetchFn(USAGE_URL, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'anthropic-version': '2023-06-01',
      },
    });
    if (res.status !== 200) return null;

    const body = await res.json();
    if (body === null || typeof body !== 'object') return null;
    const data = body as Record<string, unknown>;

    const windows: WindowUsage[] = [];
    for (const key of WINDOW_KEYS) {
      const w = data[key];
      if (w === null || w === undefined || typeof w !== 'object') continue;
      const wObj = w as Record<string, unknown>;
      const utilization = wObj['utilization'];
      const resetsAt = wObj['resets_at'];
      if (typeof utilization !== 'number') continue;
      const resetsAtMs =
        typeof resetsAt === 'string' ? Date.parse(resetsAt) : null;
      windows.push({ utilization, resetsAtMs: resetsAtMs !== null && !Number.isNaN(resetsAtMs) ? resetsAtMs : null });
    }

    const overThreshold = windows.filter((w) => w.utilization >= threshold);
    const limited = overThreshold.length > 0;

    let resetsAtMs: number | null = null;
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
  } catch {
    return null;
  }
}
