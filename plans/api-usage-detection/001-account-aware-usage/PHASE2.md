# Phase 2 — /proc bridge: pane → account

## Goal
Implement real `resolvePaneConfigDir(target, snapshot, deps?)` in `src/accounts.ts`
(currently a stub returning null). Resolves a zellij `PaneTarget` → its account's
`CLAUDE_CONFIG_DIR`, for the rare case where 2+ accounts are limited at once and
tier-1 single-limited attribution is ambiguous.

## Verified bridge (Linux /proc)
1. **session → zellij-server pid**: each session has a process
   `zellij --server <sockdir>/contract_version_1/<SESSION NAME>`. Read
   `/proc/<pid>/cmdline` (NUL-separated args). It's a zellij server if an arg is
   `--server`. Session name = the part of the `--server` path AFTER the last
   `/contract_version_1/` segment (session names contain spaces; trim trailing ws).
2. **server → pts set**: readlink every entry in `/proc/<server-pid>/fd/`; collect
   those resolving to `/dev/pts/N`.
3. **claude proc → pts + account**: for each claude proc (cmdline references
   `claude`), readlink `/proc/<pid>/fd/0` → `/dev/pts/N`; read `/proc/<pid>/environ`
   → `CLAUDE_CONFIG_DIR` (else defaultConfigDir()).
4. **combine**: for `target.session`, find the matching server, get its pts set,
   collect distinct configDirs of claude procs whose pts ∈ that set. Return the
   single distinct dir, else `null` (0 or 2+ = ambiguous).

Confirmed live: server for "XPrivate Education Development" holds `/dev/pts/2`,
which is the `.xprivate` claude → resolves to `/home/homeserver/.xprivate`.

## Implementation (`src/accounts.ts`)
Refactor proc scanning into reusable, dependency-injected helpers:
```ts
interface ProcDeps {
  platform?: string;                          // default process.platform
  listProcPids: () => Promise<string[]>;      // numeric entries of /proc
  readCmdline: (pid: string) => Promise<string>;   // /proc/<pid>/cmdline (NUL-sep)
  readEnviron: (pid: string) => Promise<string>;   // /proc/<pid>/environ (NUL-sep)
  listFds: (pid: string) => Promise<string[]>;     // entries of /proc/<pid>/fd
  readlink: (path: string) => Promise<string>;     // readlink a path
}
```
- `listClaudeProcs(deps): Promise<{pid, configDir, pts: string|null}[]>` —
  cmdline references the claude CLI; pts from readlink fd/0 (`/dev/pts/N` or null);
  configDir from environ (parseConfigDirFromEnviron) else defaultConfigDir().
- `listZellijServers(deps): Promise<{session: string, pts: Set<string>}[]>` —
  cmdline has `--server`; parse session name; pts from readlink of each fd matching
  `/dev/pts/N`.
- `resolvePaneConfigDir(target, snapshot, deps?)`:
  - non-linux → null.
  - find server with `session === target.session`; none → null.
  - distinct claude configDirs whose pts ∈ server.pts; return the one, else null.
  - swallow all fs errors → null (degrade to text). NEVER throw.
- Keep `discoverAccountDirs` working (can reuse `listClaudeProcs`); all existing
  tests must stay green. `parseConfigDirFromEnviron` unchanged.
- Default `ProcDeps` wired from `node:fs/promises` (readdir/readFile/readlink),
  filtering `/proc` numeric dirs.

## cli wiring (`src/cli.ts`)
`resolvePaneAccount` already delegates to `resolvePaneConfigDir(t, snapshot)` — no
change needed (the stub becomes real). Confirm it still type-checks.

## Tests (`test/accounts.test.ts`, extend)
Inject a fake ProcDeps describing a synthetic /proc:
- two sessions, each one claude on a distinct pts with distinct configDir →
  resolvePaneConfigDir returns the right dir per session.
- session whose pts has a claude with default (unset) configDir → returns default.
- session with 2 claude procs on its pts with DIFFERENT configDirs → null (ambiguous).
- target.session with no matching server → null.
- platform='darwin' → null.
- pts parsing: readlink returns `/dev/pts/7` → "/dev/pts/7"; non-pts fd ignored.
NO real /proc access in tests.

## Verify
`npm run verify` green.
