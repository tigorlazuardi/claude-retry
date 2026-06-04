# Account-aware usage detection

## Goal
Replace fragile text-only rate-limit detection with authoritative usage data from
the Anthropic OAuth usage endpoint. Kill two bugs:
1. **Stale banner** — old limit banner left on screen re-detected as a fresh limit
   (false wait, sometimes until next day).
2. **Fuzzy reset time** — `parseResetTime` guesses am/pm/tz from screen text.

## Ground truth
```
GET https://api.anthropic.com/api/oauth/usage
Authorization: Bearer <accessToken from <configDir>/.credentials.json>
anthropic-beta: oauth-2025-04-20
anthropic-version: 2023-06-01
```
Returns (relevant fields):
```json
{"five_hour":{"utilization":5.0,"resets_at":"2026-06-04T08:50:00+00:00"},
 "seven_day":{"utilization":44.0,"resets_at":"2026-06-05T07:00:00+00:00"},
 "seven_day_opus":{...}|null,"seven_day_sonnet":{...}|null}
```
`utilization` is a percentage (0–100). Blocked when a window hits ~100.
`resets_at` is ISO-8601 **with offset** → `Date.parse()` is tz-correct.

## Three-tier resolution (chosen design)
When a pane shows a limit banner, decide its reset time by:
1. **Account-centric (primary)** — poll usage per known account. If exactly one
   account is limited, attribute the banner to it; use its `resets_at`.
   **Staleness gate:** if the pane's account is resolved and *not* limited →
   banner is stale → ignore (stay monitoring).
2. **/proc bridge (Linux fallback)** — only when ambiguous (2+ accounts limited
   at once). Map pane→account via session/proc correlation. *Phase 2 — stub for
   now (resolver returns null → falls through to tier 3).*
3. **Text fallback** — API unreachable, account unknown, or still ambiguous →
   current `parseResetTime` behavior. **Never ignore a banner when the account is
   unknown or usage is unavailable** (avoid masking a real limit).

Rate limits are **account-wide**, so the unit of truth is the account, not the pane.

## Modules

### `src/usage.ts` (new)
```ts
export interface WindowUsage { utilization: number; resetsAtMs: number | null }
export interface AccountUsage {
  limited: boolean;        // any window utilization >= threshold
  resetsAtMs: number | null; // latest resets_at among over-threshold windows
}
export type FetchFn = (url: string, init: { headers: Record<string,string> }) => Promise<{ status: number; json: () => Promise<unknown> }>;
export type ReadFileFn = (path: string) => Promise<string>;

export function defaultConfigDir(env?: NodeJS.ProcessEnv): string;
//   env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')

export async function readAccessToken(configDir: string, readFile?: ReadFileFn):
  Promise<{ token: string; expiresAtMs: number | null } | null>;
//   read <configDir>/.credentials.json → .claudeAiOauth.accessToken / .expiresAt
//   null on missing file / parse error / missing token

export async function fetchUsage(token: string, fetchFn?: FetchFn, threshold?: number):
  Promise<AccountUsage | null>;
//   GET endpoint with headers above. null on non-200 / network error / parse error.
//   threshold default = LIMIT_THRESHOLD (90). Consider windows: five_hour,
//   seven_day, seven_day_opus, seven_day_sonnet (skip null windows).
//   limited = any window.utilization >= threshold.
//   resetsAtMs = max resetsAtMs among windows with utilization >= threshold (else null).

export const LIMIT_THRESHOLD = 90; // override via env CLAUDE_RETRY_LIMIT_THRESHOLD
```
- Use global `fetch` as the default `fetchFn` (Node >=20 has it); wrap so the
  injected signature matches (status + json()).
- Use `node:fs/promises` `readFile` default; `node:os` homedir; `node:path` join.
- All network/file errors swallowed → return null (caller degrades to text).

### `src/accounts.ts` (new)
```ts
export interface AccountSnapshot { byDir: Map<string, AccountUsage> } // configDir -> usage
export async function discoverAccountDirs(deps?: {...}): Promise<string[]>;
//   Linux only (process.platform === 'linux' && /proc readable).
//   Scan /proc/<pid>/cmdline for the claude CLI; read /proc/<pid>/environ,
//   extract CLAUDE_CONFIG_DIR (NUL-separated). Unset → defaultConfigDir().
//   Return DISTINCT dirs actually in use. Non-linux / failure → [].
//   Always also include defaultConfigDir() so the common single-account case
//   works even without /proc.

export async function resolvePaneConfigDir(target, snapshot, deps?): Promise<string | null>;
//   PHASE 2 STUB: return null for now (tier-3 text fallback handles ambiguity).
//   Future: zellij-server fd→pts ∪ proc tty correlation → session→account.
```
Inject fs/exec deps for testability. `/proc` access guarded; pure parse helpers
(`parseConfigDirFromEnviron(buf)`) unit-tested.

### `src/monitor.ts` (edit)
- Extend `MultiMonitorDeps`:
  ```ts
  getAccountSnapshot?: () => Promise<AccountSnapshot>; // called ONCE per multiTick
  resolvePaneAccount?: (t: PaneTarget, s: AccountSnapshot) => Promise<string | null>;
  ```
- `multiTick`: if `getAccountSnapshot` present, call once, pass snapshot down to
  each `tickTarget`/`stepState`.
- New limit decision in `stepState` (monitoring + `match().limited`):
  1. If snapshot available: resolve account dir
     (single-limited → that dir; else `resolvePaneAccount` → may be null).
     - account resolved + usage present:
       - `limited === false` → **stale, return 'monitoring'** (ignore banner).
       - `limited === true` → `waitUntil = resetsAtMs + margin` (fall back to
         text/`fallbackHours` if `resetsAtMs` null).
     - account unknown / usage missing → tier-3.
  2. Tier-3 (text): current `parseResetTime` + `calculateWaitMs` path.
- Keep single-pane `tick`/`runMonitor` unchanged (no account deps) — text-only.
- Optional polish: on `waiting`→reset, before injecting, if snapshot says account
  still limited, extend wait to new `resetsAtMs`. (Nice-to-have; only if cheap.)
- Add log lines: "stale banner ignored (account not limited)", "account <dir>
  limited, reset <iso>".

### `src/cli.ts` (edit)
Wire real deps into `multiDeps`:
- `getAccountSnapshot`: `discoverAccountDirs()` → for each dir `readAccessToken` →
  `fetchUsage` → build `Map`. Swallow per-account errors. Cache token reads per
  pass (re-read each pass so Claude Code's own token refresh is picked up).
- `resolvePaneAccount`: `resolvePaneConfigDir` (stub).
- Single-pane `monitor` command stays text-only (no change).

## Constraints / gotchas
- **Token refresh**: re-read `.credentials.json` every pass; do NOT manage refresh.
  On 401 the token is stale → fetchUsage returns null → degrade to text.
- **Undocumented endpoint**: any non-200 / shape change → null → text fallback.
  Never throw out of the daemon loop.
- **Security**: only reads the user's own credential files + GETs their own usage.
  Never log tokens.
- **Linux-only /proc**: non-Linux still works via default account + text.
- Node >=20, ESM, `.ts` extensions in imports (repo uses `--experimental-strip-types`).

## Tests (TDD — write first)
- `test/usage.test.ts`: `defaultConfigDir`, `readAccessToken` (good/missing/garbage),
  `fetchUsage` with injected fetch (limited / not-limited / multi-window latest-reset /
  non-200 → null / bad json → null), threshold boundary.
- `test/accounts.test.ts`: `parseConfigDirFromEnviron` (set/unset), `discoverAccountDirs`
  non-linux → [default], resolver stub → null.
- `test/monitor.test.ts` (extend): staleness gate (banner + account not-limited →
  stays monitoring), account-limited → waits to exact `resetsAtMs`, snapshot absent →
  text fallback unchanged, account unknown → text fallback (not ignored).

## Verify gate
`npm run verify` (typecheck + node --test + build) must pass.

## Phasing
- **Phase 1 (this slice)**: usage.ts, accounts.ts (discovery + stub resolver),
  monitor wiring (tiers 1 & 3), cli wiring, tests. Solves both stated bugs.
- **Phase 2 (separate slice)**: real `resolvePaneConfigDir` /proc bridge for the
  simultaneous-multi-account-limit case.
