# TASKS: claude-auto-retry (zellij edition)

Ordered. One per ralph iteration. Verify cmd must exit 0. Full detail + review levels in CONTRACT.md §4.

| #   | Task | Verify (exit 0) | Review |
| :-- | :--- | :-------------- | :----- |
| 001 | **Spike**: prove zellij capture+inject+pane-id roundtrip. Ship `spike/verify-zellij.sh` + `docs/ADR-001-zellij-capture.md` locking mechanism. | `bash spike/verify-zellij.sh` | opus |
| 002 | Scaffold: `package.json` (type=module, bin=claude-retry, devDep typescript), `tsconfig.json`, `src/` + `test/` dirs, npm-installable. | `npm install && npx tsc --noEmit` | self |
| 003 | `src/patterns.ts` + ANSI stripper + `test/patterns.test.ts`. Port regexes from original. | `node --test test/patterns.test.ts` | self |
| 004 | `src/time-parser.ts` + `test/time-parser.test.ts`. Reset-time + tz + DST. | `node --test test/time-parser.test.ts` | sonnet |
| 005 | `src/zellij.ts`: capturePane / inject / resolvePaneId per ADR-001 + `test/zellij.test.ts` (execFile mocked). | `node --test test/zellij.test.ts` | sonnet |
| 006 | `src/monitor.ts`: poll state machine (DI capture/inject/now/sleep) + `test/monitor.test.ts`. | `node --test test/monitor.test.ts` | sonnet |
| 007 | `src/cli.ts` + `src/launcher.ts`: subcommands monitor/start/install/help. | `npx tsc && node dist/cli.js help` | self |
| 008 | Shell wrappers `shell/wrapper.fish` + `shell/wrapper.bash` (bash+zsh). | `fish -n shell/wrapper.fish && bash -n shell/wrapper.bash` | self |
| 009 | Packaging: build to dist, bin shebang, npm pack dry-run clean. | `npx tsc && node dist/cli.js help && npm pack --dry-run` | sonnet |
| 010 | `README.md` (install per shell, usage, run-inside-zellij). Final full gate. | full gate (CONTRACT §2) | self |
