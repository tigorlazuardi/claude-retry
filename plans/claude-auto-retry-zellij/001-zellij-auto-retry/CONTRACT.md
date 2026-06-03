# Ralph Contract: claude-auto-retry (zellij edition)

**Slice:** plans/claude-auto-retry-zellij/001-zellij-auto-retry/
**Executor:** Sonnet orchestrator, autonomous ralph-loop (fresh session)
**Planner:** Opus — contract authored 2026-06-03

## 0. Sanity check (preflight — run FIRST, every iteration, before any task work)

```bash
SLICE="plans/claude-auto-retry-zellij/001-zellij-auto-retry"
# 1. Must be on a ralph/ branch, never main/master
git branch --show-current | grep -qE "^ralph/" \
  || { echo "ERROR: not on ralph/ branch (run: git init && git checkout -b ralph/claude-auto-retry-zellij-001) — abort"; exit 1; }
# 2. Contract + progress files must exist
test -f "$SLICE/CONTRACT.md" || { echo "ERROR: CONTRACT.md missing"; exit 1; }
test -f "$SLICE/RESUME.md"   || { echo "ERROR: RESUME.md missing"; exit 1; }
# 3. If blocked, surface and stop
test ! -f "$SLICE/BLOCKED.md" \
  || { echo "Loop BLOCKED — read BLOCKED.md:"; cat "$SLICE/BLOCKED.md"; exit 0; }
# 4. Prereqs: node + zellij present
command -v node   >/dev/null || { echo "ERROR: node not found"; exit 1; }
command -v zellij >/dev/null || { echo "ERROR: zellij not found"; exit 1; }
```

If ANY check fails: stop, print the error, do NOT proceed to §4 tasks.

## 1. Mission
Port `cheapestinference/claude-auto-retry` to zellij: detect Claude Code rate-limit message in a zellij pane, parse reset time, wait, inject `continue`. Zero runtime deps, TS source → dist JS, npm-publishable, fish+bash/zsh wrappers. Run-inside-zellij model (pane targeted by id).

## 2. Success criteria (definition of done)
Loop is DONE only when ALL hold, each proven by a command that exits 0:
- Spike mechanism proven + ADR written — verify: `bash spike/verify-zellij.sh`
- Typecheck clean — verify: `npx tsc --noEmit`
- All unit tests pass — verify: `node --test test/`
- Build produces working CLI — verify: `npx tsc && node dist/cli.js help`
- Package is publishable — verify: `npm pack --dry-run`
- Shell wrappers syntactically valid — verify: `fish -n shell/wrapper.fish && bash -n shell/wrapper.bash`
- README exists — verify: `test -f README.md`

Full gate (run ALL, in order, before any promise):
```bash
bash spike/verify-zellij.sh \
  && npm install \
  && npx tsc --noEmit \
  && node --test test/ \
  && npx tsc \
  && node dist/cli.js help \
  && fish -n shell/wrapper.fish && bash -n shell/wrapper.bash \
  && npm pack --dry-run \
  && test -f README.md
```

## 3. Completion promise
Phrase: `ALL ACCEPTANCE MET`   (must match --completion-promise exactly)

Gate — MANDATORY before emitting, no exceptions:
1. Every task in §4 checked done in RESUME.md.
2. Run every verify command in §2 full gate. ALL exit 0.
3. Paste the verify output into your response.
4. ONLY THEN output: `<promise>ALL ACCEPTANCE MET</promise>`

NEVER emit on self-assessment alone. NEVER emit to escape a stuck loop. Cannot make gate green → not done → iterate, escalate (§6), or abort (§7).

## 4. Tasks
Ordered. Each iteration: execute the next unchecked task. Track state in RESUME.md.

| #   | Action | Files in-scope | Out-of-scope | Done when (exit 0) | Difficulty | Review | escalate_after |
| :-- | :----- | :------------- | :----------- | :----------------- | :--------- | :----- | :------------- |
| 001 | Spike zellij capture+inject+pane-id. Manual/scripted: dump-screen reads a known marker from a target pane by id; write-chars+`write 13` injects + submits into that pane; resolve claude pane-id from `dump-layout`/`list-clients` (or env override). Write `docs/ADR-001-zellij-capture.md` (locked mechanism, exact commands, pane-id strategy, ANSI handling) + `spike/verify-zellij.sh` (repeatable roundtrip, exit 0 on success). | `spike/`, `docs/ADR-001-zellij-capture.md` | any `src/` product code | `bash spike/verify-zellij.sh` | hard | opus | 2 |
| 002 | Scaffold project: `package.json` (type=module, `bin.claude-retry=dist/cli.js`, devDep typescript, scripts: build/test/typecheck), `tsconfig.json` (outDir dist, strict), create `src/` + `test/` dirs with a placeholder so tsc passes. | `package.json`, `tsconfig.json`, `src/`, `test/` | shell/, README | `npm install && npx tsc --noEmit` | easy | self | 2 |
| 003 | `src/patterns.ts`: port rate-limit regexes from original `src/patterns.js` + ANSI-strip helper + `match(text)` API. `test/patterns.test.ts` covers real strings ("5-hour limit reached - resets 3pm", "You've hit your limit"). | `src/patterns.ts`, `test/patterns.test.ts` | other src | `node --test test/patterns.test.ts` | medium | self | 2 |
| 004 | `src/time-parser.ts`: port reset-time parse (clock time, "N-hour limit", tz + DST via iterative offset). Returns target epoch ms. `test/time-parser.test.ts` incl. DST + tz cases with injected fixed `now`. | `src/time-parser.ts`, `test/time-parser.test.ts` | other src | `node --test test/time-parser.test.ts` | hard | sonnet | 2 |
| 005 | `src/zellij.ts`: `capturePane(id)` (dump-screen --pane-id --path → read+strip), `inject(id,text)` (write-chars + `write 13`), `resolvePaneId()` per ADR. execFile via node:child_process. `test/zellij.test.ts` mocks execFile, asserts exact argv. | `src/zellij.ts`, `test/zellij.test.ts` | other src | `node --test test/zellij.test.ts` | hard | sonnet | 2 |
| 006 | `src/monitor.ts`: poll state machine. Deps injected: `{capture, inject, now, sleep}`. Flow capture→patterns.match→time-parser→sleep(until reset+60s margin)→inject("continue"). `test/monitor.test.ts` drives full cycle with fakes + fake clock. | `src/monitor.ts`, `test/monitor.test.ts` | other src | `node --test test/monitor.test.ts` | hard | sonnet | 2 |
| 007 | `src/cli.ts` + `src/launcher.ts`: arg parse, subcommands `monitor` (run loop on a pane id), `start` (resolve pane + run), `install` (write shell wrapper), `help`. Node shebang on cli. | `src/cli.ts`, `src/launcher.ts` | shell/, README | `npx tsc && node dist/cli.js help` | medium | self | 2 |
| 008 | Shell wrappers: `shell/wrapper.fish` (function for config.fish) + `shell/wrapper.bash` (bash+zsh). Export pane id / launch claude + monitor. Match original `wrapper.sh` intent, zellij-adapted. | `shell/wrapper.fish`, `shell/wrapper.bash` | src | `fish -n shell/wrapper.fish && bash -n shell/wrapper.bash` | medium | self | 2 |
| 009 | Packaging: finalize bin shebang, `files` field, `.npmignore`/`files` excludes plans+spike, build clean. | `package.json`, `dist/`, `.npmignore` | src logic | `npx tsc && node dist/cli.js help && npm pack --dry-run` | medium | sonnet | 2 |
| 010 | `README.md`: install per shell (fish/bash/zsh), usage, run-inside-zellij model, config. Then run §2 full gate. | `README.md` | — | full gate (§2) | easy | self | 2 |

**Review levels:** `self` = run verify + self-check diff. `sonnet` = re-read full diff fresh-eyes vs acceptance before done. `opus` = spawn Opus subagent to deep-review BEFORE marking done (mandatory for opus rows — task 001 locks architecture).

## 5. Guardrails (do NOT violate)
- Do NOT touch: `plans/` (planning docs), `.claude/`, anything outside `/home/tigor/Projects/claude-retry`.
- **Zero runtime dependencies.** No `dependencies` in package.json. Only devDep allowed: `typescript`. Adding any runtime dep = scope violation → record in RESUME.md Open questions, do NOT install.
- Core (`patterns`, `time-parser`, `monitor`) must use only cross-runtime built-ins (node:*) — runnable under both Node and Bun. zellij.ts is the only impure boundary.
- Do NOT implement the rejected approaches (WASM plugin, tee/pipe). Run-inside-zellij only — do NOT build transparent session auto-create.
- Do NOT silently fall back to focused-pane if pane-id unresolvable — that path is abort (§7), per user decision.
- Do NOT expand scope beyond §4. New need → RESUME.md "Open questions", not silent code.
- Follow CLAUDE.md orchestrator/worker split: delegate code writes to `sonnet-implementer`; loop session orchestrates + reviews.

## 6. Escalation rules
Spawn Opus subagent (cold-context briefing) when ANY:
- Task tagged `review: opus` (001) → Opus reviews diff before marking done.
- SAME task fails verify `escalate_after` times (2; track `attempts:` in RESUME.md) → Opus DIAGNOSE → returns:
  - `SOLVABLE` + hint → reset attempts to 0, apply, continue.
  - `IMPOSSIBLE` + rationale → §7 Abort.
- Spike (001) proves capture/inject/pane-id mechanism impossible → Opus DIAGNOSE → likely IMPOSSIBLE → §7 (per user: spike fail = abort, no silent fallback).
Briefing = task row + failing verify output + file paths. Batch Opus questions into ONE call.

## 7. Abort protocol (only authorized exit besides success)
Trigger: Opus DIAGNOSE returned `IMPOSSIBLE`. (Sonnet judgment alone is NOT valid.)
1. Write `BLOCKED.md` in slice folder (template in ralph-contract-template.md).
2. Set RESUME.md status: `blocked`.
3. Run: `rm .claude/.ralph-loop.local.md`
4. Exit with short summary pointing at BLOCKED.md.
Do NOT emit the promise to abort. Do NOT delete the state file for any other reason.

## 8. Iteration discipline (every iteration, in order)
1. Read CONTRACT.md + RESUME.md first.
2. Idempotent: never redo a task already checked done.
3. Pick next unchecked task in §4.
4. Implement (delegate code writes per CLAUDE.md split).
5. Run task verify:
   - Pass → check done in RESUME.md; record files + decisions; reset attempts to 0.
   - Fail → increment `attempts:`. If `>= escalate_after` → §6.
6. Checkpoint commit (one per completed task — keeps iterations revertable).
7. All tasks done → run §3 promise gate.

## 9. Backstop
max-iterations: 30. Hard ceiling. If hit, loop stops; user reviews RESUME.md + any BLOCKED.md.

## 10. Start command (fresh Sonnet session, dedicated branch)
```
git init && git add -A && git commit -m "chore: ralph slice plan for claude-auto-retry-zellij"
git checkout -b ralph/claude-auto-retry-zellij-001
/ralph-loop "Autonomous execution. Read plans/claude-auto-retry-zellij/001-zellij-auto-retry/CONTRACT.md and RESUME.md. Execute the next unchecked task per the contract. Honor guardrails, escalation, abort, and the promise gate. Emit the promise ONLY when the §3 gate passes." --max-iterations 30 --completion-promise 'ALL ACCEPTANCE MET'
```
