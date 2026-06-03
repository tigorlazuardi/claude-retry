# SCOPE: claude-auto-retry (zellij edition)

**Slice:** 001-zellij-auto-retry
**Planner:** Opus, 2026-06-03

## Goal
Port `cheapestinference/claude-auto-retry` to zellij. Auto-resume Claude Code when rate-limited: detect limit message in the claude pane, parse reset time, wait, inject `continue`. Original uses tmux; this uses zellij CLI actions.

## In scope
- Core detection logic: rate-limit regex patterns (port from original).
- Reset-time parser with timezone + DST handling (port from original).
- Zellij integration layer: capture pane via `dump-screen`, inject text via `write-chars` + `write` (Enter), resolve claude pane-id.
- Monitor poll loop: every ~5s capture → detect → parse → wait-until-reset+margin → inject.
- CLI: `claude-retry` with subcommands (monitor/start/install/help).
- Shell wrappers: fish (`config.fish`) + bash/zsh (`.bashrc`/`.zshrc`).
- npm-publishable package (bin entry) + lives in this repo.
- Unit tests (node built-in runner, zero dep) for patterns + time-parser + monitor state machine.
- Spike phase FIRST: prove zellij capture+inject+pane-id mechanism before building.

## Out of scope (non-goals)
- Transparent session auto-create/attach (tmux version does this). **Run-inside-zellij model**: user already in a zellij session running claude. Monitor targets the claude pane by id.
- WASM/Rust zellij plugin approach (rejected — heavy, perm-limited).
- Piping/tee of claude output (rejected — breaks claude TUI).
- Windows / non-zellij multiplexers.
- GUI / config UI. Config = simple file or flags only.
- Auto-detecting which pane is claude beyond id resolution + a sane default.

## Constraints
- **Zero runtime dependencies.** Pure runtime built-ins (node:child_process, node:fs). Match original's zero-dep ethos.
- Single dev dep allowed: `typescript` (typecheck + build only).
- Runtime: Node (v26 present) primary; must also run under Bun. No runtime-specific APIs in core.
- TypeScript source; build to `dist/` JS for npm/npx consumers.
- zellij 0.44.3 (installed). CLI actions: `dump-screen`, `write-chars`, `write`, `dump-layout`, `list-clients`.
- No network calls.

## Success = original feature parity, zellij transport
Detect → parse → wait → inject works against real claude rate-limit strings, inside a real zellij session, with claude pane targeted by id (or focused fallback only if spike proves id unresolvable — but spike-fail = abort, not silent fallback).
