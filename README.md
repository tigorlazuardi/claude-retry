# claude-retry

Watches every pane across **all** your [zellij](https://zellij.dev/) sessions. When a pane hits Anthropic's usage/session limit, it detects the on-screen rate-limit banner and cross-checks against Anthropic's usage API to get the **exact** reset time and discard stale or incidental banners. Once the reset elapses it clears the input and injects `continue` to resume automatically. One daemon covers every session at once — even detached ones.

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

Every pass (60s for `start`):

1. **Discover** — `zellij list-sessions` enumerates live sessions (EXITED ones and the daemon's own `$ZELLIJ_SESSION_NAME` are skipped). For each, `zellij --session <name> action list-panes -j` lists its panes; plugins and exited panes are dropped. New panes are added; gone panes are tracked via a miss-counter and dropped only after **3 consecutive absent passes**, so a transient `list-panes` hiccup never loses a pane mid-wait.
2. **Capture** — each pane's visible screen is dumped with `zellij --session <name> action dump-screen --pane-id <id>` (ANSI stripped). Works on detached sessions — no attached client required.
3. **Signal check** — the screen is checked for two signals:
   - **Loose banner match** — any rate-limit text present anywhere on screen (candidate trigger).
   - **Canonical banner** (`isBlockedAtBanner`) — a high-confidence match anchored to the **bottom** of the screen, meaning Claude is parked at the limit right above its input box. This distinguishes an active block from incidental banner text in scrollback.
4. **API call (conditional)** — the usage API (`GET https://api.anthropic.com/api/oauth/usage`) is called **only** when at least one pane shows a banner or is already waiting. Zero API calls when nothing is limited. Account is resolved as: the sole account on the machine, else the sole limited account, else via the Linux `/proc` bridge (pane → pts → `CLAUDE_CONFIG_DIR`), else unknown.
5. **State machine per pane:**

   **MONITORING:**
   - No banner → idle, nothing to do.
   - Banner + account **LIMITED** → enter WAITING until `resets_at`.
   - Banner + account **CLEARED** → if a canonical banner sits at the bottom (Claude restarted after reset, or a reopened `claude --continue` left idle) → inject `continue`; otherwise ignore (stale or scrollback text — no false triggers).
   - Banner + account **UNKNOWN** (API down) → parse reset time from on-screen text; future → enter WAITING; already-passed → inject `continue` if canonical banner at bottom, else ignore. A bare past time means the limit already reset — it is never rolled to tomorrow.

   **WAITING:**
   - Banner gone → abandon (Claude exited, user continued, or pane ID reused).
   - Account cleared **or** timer elapsed → inject `continue`.
   - Account still limited → keep waiting; `resets_at` refreshed live each pass.

6. **Inject** — Ctrl+C (clears any half-typed input; one Ctrl+C does not quit Claude Code), then `continue` + Enter via `write-chars` / `write`.

Per-pane state (keyed by `session:paneId`) persists across passes. Runs as a plain foreground process — the zellij pane is the daemon.

> **Single-pane `monitor <id>` mode** is text-only: no account API, just screen scraping against the current session.

> **Multi-account (Linux).** Account discovery reads `CLAUDE_CONFIG_DIR` from every live Claude process via `/proc` and polls usage for each account. On non-Linux the daemon uses the default account (`~/.claude`) and falls back to on-screen time parsing when the API is unavailable.

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
