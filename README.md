# claude-retry

Watches every pane across **all** your [zellij](https://zellij.dev/) sessions. When a pane hits Anthropic's usage/session limit, it detects the on-screen rate-limit banner, then confirms against Anthropic's usage API — the same data the `/usage` command shows — to get the **exact** reset time and to discard stale banners. Once the reset elapses it clears the input and injects `continue` to resume automatically. One daemon covers every session at once — even detached ones.

## Install

```bash
npm install -g @tigorhutasuhut/claude-retry
```

The package is scoped (`@tigorhutasuhut/claude-retry`); the installed command is still `claude-retry`.

## Usage

Run it as a foreground daemon, ideally in its **own dedicated zellij session** (the daemon skips its own session, so this keeps it from scanning itself):

```bash
# in a session you keep around, e.g. "Claude Retry Monitor":
claude-retry start
```

`start` re-scans **every pass** (60s): it walks all live zellij sessions and every pane in them, dumps each pane's screen, and acts on the ones showing a rate-limit banner. This means:

- **One** daemon covers every session — projects, branches, all of them.
- It works on **detached** sessions (uses zellij's global `--session` flag, not attached clients).
- Open a brand-new Claude session anywhere → picked up on the next pass. **No restart needed.**
- Close a pane → dropped from the watch list silently.
- Each pane keeps its own independent rate-limit state.

Leave it running — the pane *is* the daemon. zellij keeps it alive across detach/attach, so you don't need systemd or any external supervisor. Chatty logs stream to stderr so you always see signs of life.

> **Start Claude the right way for detection.** Launch the session with the plain `claude` command, then run the `/remote-control` slash command *inside* it. Do **not** use the `claude remote-control` CLI subcommand directly — that mode silences the on-screen text, so `dump-screen` captures nothing and the rate-limit banner can't be detected. Running `claude` → `/remote-control` keeps the session "live" and visible to the monitor.

### Single-pane mode (legacy)

To watch just one pane in the **current** session, by ID:

```bash
claude-retry monitor 3
```

### Optional: shell wrapper

A shell wrapper is included that launches Claude and a monitor pane together when you run `claude`. It is **optional** — the foreground daemon above is the simpler, recommended path. Source it only if you want the auto-spawn behavior:

**Fish** (`~/.config/fish/config.fish`):
```fish
source (npm root -g)/claude-retry/shell/wrapper.fish
```

**Bash** (`~/.bashrc`) / **Zsh** (`~/.zshrc`):
```bash
source "$(npm root -g)/claude-retry/shell/wrapper.bash"
```

## How it works

Every pass (60s for `start`, 5s for single-pane `monitor`):

1. **Discover** — `zellij list-sessions` enumerates live sessions (EXITED ones and the daemon's own `$ZELLIJ_SESSION_NAME` are skipped). For each, `zellij --session <name> action list-panes -j` lists its panes; plugins and exited panes are dropped. New panes are added, gone ones pruned.
2. **Capture** — each pane's visible screen is dumped with `zellij --session <name> action dump-screen --pane-id <id>` (ANSI stripped). This works on detached sessions, no attached client required.
3. **Match** — the text is checked against the rate-limit patterns. Panes that aren't showing a limit banner are simply left alone.
4. **Resolve** — on a banner match, the reset time is determined via a three-tier cascade:
   - **Tier 1 — usage API (primary).** Once per pass, the daemon discovers every Claude account in use by reading `CLAUDE_CONFIG_DIR` from each Claude process via `/proc` (Linux). For each account it calls `GET https://api.anthropic.com/api/oauth/usage` with the OAuth token from `<CLAUDE_CONFIG_DIR>/.credentials.json`. If the account is **not** limited the banner is stale — it is silently ignored, no wait issued. If the account **is** limited the daemon waits until the API's exact `resets_at` timestamp. Credentials are re-read every pass, so token refreshes are picked up automatically.
   - **Tier 2 — /proc pane→account bridge (planned).** Needed only when two or more accounts are limited simultaneously, so the daemon must map a specific pane to its account. This is a phase-2 stub; until implemented, that case falls through to tier 3.
   - **Tier 3 — text fallback.** Used when the API is unreachable, the account is unknown, or tier 2 is unresolved. Falls back to parsing the reset time from the on-screen banner text (the original behavior). A banner is never silently ignored when the account is unknown — this ensures a real limit is never missed.
5. **Retry** — once the resolved reset time elapses, the daemon sends **Ctrl+C** (clears any half-typed input — a single Ctrl+C in Claude Code doesn't quit), then types `continue` and Enter via `write-chars` / `write`.

Per-pane state (keyed by `session:paneId`) persists across passes, so a pane mid-wait isn't disturbed by rediscovery. It runs as a plain foreground process — no transparent session wrapping, no external daemon. The zellij pane is the daemon.

> **Multi-account note.** On Linux, account discovery reads `CLAUDE_CONFIG_DIR` from every live Claude process via `/proc`. This means the daemon polls usage for every account in use — not just the default one. On non-Linux systems it falls back to the default account (`~/.claude`) plus tier-3 text parsing.

## Requirements

- Node.js >= 20 (required for global `fetch`, used by the usage API)
- zellij >= 0.40
- Must be inside a zellij session when running
- A logged-in Claude Code installation with a valid `<CLAUDE_CONFIG_DIR>/.credentials.json` (for usage-API tier 1 detection; without it the daemon degrades to text parsing)
- `/proc` account discovery is Linux-only; on other platforms the daemon uses the default account and text fallback

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # node --test
npm run build       # tsc -> dist/
npm run verify      # typecheck + test + build (the publish gate)
```

## Publishing

Releases are published to npm by GitHub Actions ([.github/workflows/publish.yml](.github/workflows/publish.yml)) when a GitHub Release is published. Auth uses npm [Trusted Publishing](https://docs.npmjs.com/trusted-publishers) (OIDC) — **no `NPM_TOKEN` secret** — and [provenance](https://docs.npmjs.com/generating-provenance-statements) is attached automatically.

### One-time setup

1. **Bootstrap the package** (trusted publishing can only be configured on a package that already exists). Publish `0.1.0` once from your machine:
   ```bash
   npm login
   npm run verify
   npm publish --provenance=false
   ```
   `--provenance=false` is required for this local bootstrap: provenance is only generated in CI via OIDC (`publishConfig.provenance` stays `true` for the Actions publish). Without the flag, a local publish fails with `Automatic provenance generation not supported for provider: null`.
2. **Configure the trusted publisher** on npmjs.com: open the package → **Settings → Trusted Publisher → GitHub Actions**, and set:
   - Organization or user: `tigorlazuardi`
   - Repository: `claude-retry`
   - Workflow filename: `publish.yml`
3. (Recommended) In package **Settings**, set publishing access to **require two-factor or trusted publisher**, which disables token publishes entirely.

### Cutting a release

```bash
npm version patch        # bump version + create git tag
git push --follow-tags
gh release create vX.Y.Z --generate-notes
```

Publishing the GitHub Release triggers the workflow, which runs `npm ci` then `npm publish`. `prepublishOnly` (`npm run verify`) gates the publish on a clean typecheck, test, and build.
