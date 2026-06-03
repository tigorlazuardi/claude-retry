# IMPLEMENTATION: claude-auto-retry (zellij edition)

## Why
Original `claude-auto-retry` auto-resumes rate-limited Claude Code via tmux (`capture-pane` + `send-keys`). User wants the same UX on zellij. zellij's CLI action model differs from tmux enough that the capture+inject mechanism is the real risk — hence a spike gate before parity build.

## Approach (chosen)
**Option A — dump-screen polling** (recommended; B/C rejected, see SCOPE non-goals):
- Capture: `zellij action dump-screen --pane-id <id> --path <tmpfile>` then read file. Poll ~5s.
- Inject: `zellij action write-chars --pane-id <id> "continue"` then `zellij action write --pane-id <id> 13` (13 = CR/Enter).
- Pane-id resolution: parse `zellij action dump-layout` (or `list-clients`) to find the claude pane id; allow override via env (`CLAUDE_RETRY_PANE_ID`) set by the shell wrapper.

Spike (task 001) locks this in an ADR and ships a repeatable roundtrip verify script before any product code.

## Architecture
```
src/
  patterns.ts     rate-limit regexes + matcher (port from original src/patterns.js)
  time-parser.ts  parse "resets 3pm" / "5-hour limit" etc → epoch ms, tz + DST aware
  zellij.ts       execFile wrappers: capturePane(id), inject(id, text), resolvePaneId()
  monitor.ts      poll loop state machine: capture→detect→parse→sleep→inject; pure core
                  takes capture/inject/now/sleep as injectable deps → unit-testable
  launcher.ts     run-inside-zellij helpers (resolve pane, start monitor)
  cli.ts          arg parse + subcommands: monitor | start | install | help
shell/
  wrapper.fish    function `claude` → ensure pane id exported, launch + monitor
  wrapper.bash    bash + zsh variant
test/
  patterns.test.ts
  time-parser.test.ts
  monitor.test.ts     drives state machine with fake capture strings + fake clock
spike/
  verify-zellij.sh    spins zellij session, asserts capture+inject roundtrip
docs/
  ADR-001-zellij-capture.md   spike output: locked mechanism + rationale
```

## Key decisions
- **Dependency injection in monitor** so detection/wait logic is testable without a live zellij/tmux. zellij.ts is the only impure boundary.
- **node built-in test runner** (`node --test`) + `node:assert` → zero test deps. Node 26 strips TS types natively, so `.ts` tests run directly.
- **Build step**: `tsc` → `dist/`. `bin` points at `dist/cli.js` with node shebang so `npx claude-retry` works on stock Node.
- **Pane-id strategy**: env override first (wrapper-set), else dump-layout parse, else error (do NOT silently grab focused pane — focused-fallback was explicitly rejected as the spike-fail path; spike fail = abort).
- Port `patterns` + `time-parser` logic faithfully from the original JS; only the transport (tmux→zellij) is new.

## Risks
- **R1 (high):** pane-id not programmatically resolvable from `dump-layout`/`list-clients`. → Spike resolves; if impossible, Opus-diagnose → abort (per user).
- **R2 (med):** `dump-screen` ANSI/scrollback differences vs tmux change regex matching. → strip ANSI (port original's stripper), test against real captured strings.
- **R3 (med):** non-interactive zellij in verify script (needs a pty). → spike script uses `script -qec` or detached session; if too flaky, gate downgrades to documented manual verify (noted in ADR, logged — no silent skip).
- **R4 (low):** Enter keycode — confirm `write 13` submits in claude TUI vs needing bracketed-paste handling.
