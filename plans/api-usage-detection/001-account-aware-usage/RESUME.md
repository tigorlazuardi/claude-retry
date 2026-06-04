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

### Phase 2 (deferred — separate slice)
Real `resolvePaneConfigDir` /proc bridge for the rare case: 2+ accounts limited
simultaneously, need exact pane→account. Approach: zellij-server `/proc/<pid>/fd`
→ pts set per session ∪ claude proc `tty`/`cwd` correlation. Until then that case
degrades to text-parse (acceptable). Single-account + single-limited-account cases
fully covered now.

### Not done
- README "How it works" not updated for API detection. (follow-up)
- Not committed. No version bump.
