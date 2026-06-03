# ADR-001: Use Zellij Native Actions for Capture/Inject

**Status:** ACCEPTED  
**Date:** 2026-06-03

---

## Context

claude-retry needs to monitor a Claude CLI pane in a terminal multiplexer and inject retry commands when Claude hits a rate-limit or stops. Two capabilities are required:

1. **Capture** — read current terminal output to detect error states.
2. **Inject** — write a command and send Enter to restart Claude.

The project targets users already running zellij as their multiplexer. We evaluated three approaches.

---

## Decision

Use **zellij native actions** (`dump-screen`, `write-chars`, `write`) via CLI subprocesses. No WASM plugin, no tee/pipe wrapping.

---

## Mechanism

### Capture

```bash
zellij action dump-screen --pane-id <id>
```

- No `--ansi` flag. Default output strips ANSI escape codes automatically.
- No additional stripping needed in application code.
- Exits 0 on success; output is the plain-text screen contents.

### Inject text

```bash
zellij action write-chars --pane-id <id> "<text>"
```

### Inject Enter (send command)

```bash
zellij action write --pane-id <id> 13
```

`13` is the decimal value of the carriage return byte (0x0D).

### Full inject sequence

```bash
zellij action write-chars --pane-id "$PANE_ID" "claude --resume"
zellij action write --pane-id "$PANE_ID" 13
```

---

## Pane-ID Resolution

Resolved in priority order. Abort if unresolvable — **never fall back to the focused pane**.

1. **Explicit** — `--pane-id <id>` CLI argument or `CLAUDE_PANE_ID` environment variable.
2. **Auto-detect by running command** — parse `zellij action list-clients` output (columns: `CLIENT_ID ZELLIJ_PANE_ID RUNNING_COMMAND`). Find the row whose `RUNNING_COMMAND` contains `claude`. Use the `ZELLIJ_PANE_ID` from that row.
   - Note: `zellij action list-panes -j` field `terminal_command` is `null` while a process runs — unusable for live detection. `list-clients` is the correct source.
3. **Title fallback** — `zellij action list-panes -j`, filter `is_plugin=false`, find pane where `title` contains `"claude"`. Documented weakness: title reflects cwd in most shells, not the running process — will false-positive on any pane whose cwd path contains "claude" (e.g., this repo). Only use if `list-clients` yields no match.
4. **Abort** — if none of the above resolves to exactly one pane, exit with an error asking the user to set `CLAUDE_PANE_ID` or pass `--pane-id`.

**Rationale for hard abort:** falling back to the focused pane is wrong when claude-retry runs as a background watcher. The focused pane at inject time is likely the user's shell, not Claude. Injecting into the wrong pane corrupts user work.

### Pane-ID format and namespacing

`zellij action list-panes -j` returns `"id": <integer>` per pane. **This integer is NOT globally unique** — a plugin pane and a terminal pane can both have `id: 0`. The namespace is per-type: bare `0` in `--pane-id` is equivalent to `terminal_0`; plugins require `plugin_0`.

Mandatory filter: **always gate on `is_plugin=false` before reading `id`**. Never scrape a raw `id` from the JSON without type-checking.

Pass the bare integer (not `terminal_N`) to `--pane-id` — simpler to forward from JSON parse.

Plugin panes (`"is_plugin": true`) must be excluded from all resolution steps.

---

## Session Targeting

`zellij action` without an explicit session flag targets the active/current session.

- When claude-retry runs **inside** zellij (env var `$ZELLIJ` is set), the session is picked up automatically.
- When claude-retry runs **outside** zellij (e.g. a background daemon), the user must ensure only one zellij session exists, or pass the session name explicitly. This is a known limitation; multi-session targeting is out of scope for the initial implementation.

Background session creation (used in tests only):

```bash
zellij attach --create-background <session-name>
```

---

## Rejected Approaches

| Approach | Reason rejected |
|---|---|
| **WASM plugin** | Requires compiling and loading a custom plugin. Significant complexity; overkill for CLI capture/inject. No advantage over native actions for this use case. |
| **tee/pipe wrapping** | Requires the user to start Claude through a wrapper that tees stdout to a file. Changes launch UX, breaks if Claude is already running, fragile across shell configs. |
| **Focused-pane fallback** | Wrong pane risk when running as a background watcher. Explicitly forbidden by contract. |

---

## Consequences

- **Zero runtime deps** beyond zellij itself (already required by the user).
- Capture is a polling snapshot, not a stream — acceptable for the retry use case (poll interval ~1–5s).
- `dump-screen` returns the visible screen buffer only; long scrollback is not captured. This is acceptable: rate-limit errors appear in the last few lines.
- If zellij changes its action API, the command strings need updating — no abstraction layer. Acceptable tradeoff for simplicity.
