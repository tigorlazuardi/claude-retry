# RESUME — account-aware usage detection

## Status: Phase 1 COMPLETE (uncommitted)

### Done
- `src/usage.ts` — credentials read + live usage API (`/api/oauth/usage`). 22 tests.
- `src/accounts.ts` — `/proc` account discovery (Linux) + `resolvePaneConfigDir` stub. tests.
- `src/monitor.ts` — three-tier resolution wired into `stepState`/`multiTick`.
  Resolution order: `byDir.size===1` → single-limited-dir → resolver(stub) → text.
  Staleness gate + exact `resetsAtMs` wait.
- `src/cli.ts` — real `getAccountSnapshot` (discover → readToken → fetchUsage per pass, no caching).
- `npm run verify`: 94 pass, build clean.
- Live smoke: discovered both `.claude` + `.xprivate`, fetched usage for each. Works.

### Bug caught in review (fixed)
Initial resolution missed single-account STALE banner (0 limited dirs → fell to text → re-waited).
Fixed with `byDir.size===1` rule. Test added reflecting real (no-resolver) wiring.

### Phase 2 — COMPLETE
Real `resolvePaneConfigDir` /proc bridge implemented in src/accounts.ts:
session → zellij-server pid (cmdline `--server .../contract_version_1/<session>`)
→ pts set (server fd readlinks → /dev/pts/N) → claude proc on that pts
(fd/0 → pts, environ → CLAUDE_CONFIG_DIR). Exactly-one distinct dir → resolved,
else null → text fallback. `npm run verify`: 103 pass. Live-verified: "XPrivate
Education Development" → /home/homeserver/.xprivate, others → /home/homeserver/.claude.
Minor: cmdline 'claude' match is loose but degrades safely (ambiguous→null→text).
Spec: PHASE2.md.

### Remaining
- Not committed (phase 2). No version bump.

### Not done
- README "How it works" not updated for API detection. (follow-up)
- Not committed. No version bump.
