# RESUME: claude-auto-retry (zellij edition)

**Slice:** plans/claude-auto-retry-zellij/001-zellij-auto-retry/
**Status:** active
**Branch:** ralph/claude-auto-retry-zellij-001
**Last updated:** 2026-06-03 (Opus, initial)

## Ralph state
- Contract: CONTRACT.md (this slice)
- Loop status: active

## Initial state
- Empty repo at /home/tigor/Projects/claude-retry (NOT yet git init — user must `git init` + initial commit + create branch before first loop run).
- zellij 0.44.3 installed. node v26 installed. fish shell. Bun optional.
- Original reference: github.com/cheapestinference/claude-auto-retry (tmux, Node, zero-dep).

## Task progress (with attempt counters)
- [x] 001 spike (zellij capture+inject+pane-id + ADR) — attempts: 1 — DONE 2026-06-03
- [ ] 002 scaffold — attempts: 0
- [ ] 003 patterns.ts + test — attempts: 0
- [ ] 004 time-parser.ts + test — attempts: 0
- [ ] 005 zellij.ts + test — attempts: 0
- [ ] 006 monitor.ts + test — attempts: 0
- [ ] 007 cli.ts + launcher.ts — attempts: 0
- [ ] 008 shell wrappers — attempts: 0
- [ ] 009 packaging — attempts: 0
- [ ] 010 README + final gate — attempts: 0

## Decisions log
- ADR-001 written: dump-screen (no --ansi) for capture; write-chars + write 13 for inject; list-clients RUNNING_COMMAND for pane-id auto-detect; hard abort if unresolvable (no focused-pane fallback). Opus-reviewed + approved after fixes.

## Open questions
- (none — resolve via Opus escalation, do NOT silently expand scope)
