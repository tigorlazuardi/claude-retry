# claude-retry

Watches every Claude CLI pane in a [zellij](https://zellij.dev/) terminal session. When a pane hits Anthropic's 5-hour usage limit, it detects the rate-limit message, waits until that pane's reset time, then injects `continue` to resume automatically. One daemon covers all your Claude sessions at once.

## Install

```bash
npm install -g @tigorhutasuhut/claude-retry
```

The package is scoped (`@tigorhutasuhut/claude-retry`); the installed command is still `claude-retry`.

## Usage

Must be run inside a zellij session. The recommended way to run claude-retry is as a foreground daemon in a dedicated zellij pane:

1. In your main pane, run `claude` as normal.
2. Open a second pane (e.g. `Ctrl+p` then `d` to split down).
3. In the new pane, start the daemon:

```bash
claude-retry start
```

`start` rediscovers Claude panes on **every pass** (every 60s) via `zellij action list-clients`. This means:

- You only ever need **one** daemon, no matter how many Claude sessions you run.
- Open a new Claude session in a new pane → it's picked up automatically on the next pass. **No restart needed.**
- Close a Claude pane → it's dropped from the watch list silently.
- Each pane gets its own independent rate-limit state.

Leave it running — the pane *is* the daemon. zellij keeps it alive across detach/attach, so you don't need systemd or any external supervisor. Logs stream to stderr so you always see signs of life.

> **Start Claude the right way for detection.** Launch the session with the plain `claude` command, then run the `/remote-control` slash command *inside* it. Do **not** use the `claude remote-control` CLI subcommand directly — that mode silences the on-screen text, so `dump-screen` captures nothing and the rate-limit message can't be detected. Running `claude` → `/remote-control` keeps the session "live" and visible to the monitor.

To pin the daemon to a single pane instead of auto-discovery:

```bash
# Watch one specific pane by ID:
claude-retry monitor 3

# Or restrict 'start' to one pane via env:
CLAUDE_PANE_ID=3 claude-retry start
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

## Configuration

```bash
CLAUDE_PANE_ID=3 claude-retry start   # pin to one pane, skip auto-discovery
```

## How it works

Every pass (60s for `start`, 5s for single-pane `monitor`):

1. **Discover** — `start` lists Claude panes via `zellij action list-clients`, matching panes whose command is the `claude` CLI (the daemon's own `claude-retry` pane is excluded). New panes are added, closed panes are pruned.
2. **Capture** — for each pane, grabs the screen with `zellij action dump-screen` (ANSI stripped).
3. **Match** — checks the text against the rate-limit patterns.
4. **Retry** — on detection, parses the reset time and marks the pane `waiting`; once the reset elapses, injects `continue` via `zellij action write-chars`.

Per-pane state persists across passes, so a pane mid-wait isn't disturbed by rediscovery. It runs as a plain foreground process inside the same zellij session as Claude — no transparent session wrapping, no external daemon. The zellij pane is the daemon.

## Requirements

- Node.js >= 20
- zellij >= 0.40
- Must be inside a zellij session when running

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
   npm publish
   ```
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
