# claude-retry

Monitors a Claude CLI pane in a [zellij](https://zellij.dev/) terminal session. When Claude hits Anthropic's 5-hour usage limit, detects the rate limit message, waits until the reset time, then injects `continue` to resume automatically.

## Install

```bash
npm install -g claude-retry
```

Add the shell wrapper to your config:

**Fish** (`~/.config/fish/config.fish`):
```fish
source (npm root -g)/claude-retry/shell/wrapper.fish
```

**Bash** (`~/.bashrc`):
```bash
source "$(npm root -g)/claude-retry/shell/wrapper.bash"
```

**Zsh** (`~/.zshrc`):
```bash
source "$(npm root -g)/claude-retry/shell/wrapper.bash"
```

## Usage

Must be run inside a zellij session. Run `claude` as normal — the wrapper launches Claude in a new pane and starts a monitor pane alongside it.

Or run manually:

```bash
# Auto-detect the Claude pane:
claude-retry start

# Target a specific pane by ID:
claude-retry monitor 3
```

## Configuration

```bash
CLAUDE_PANE_ID=3 claude-retry start   # override pane ID
```

## How it works

1. The shell wrapper launches `claude` in a new zellij pane via `zellij run`
2. `claude-retry monitor <pane-id>` starts in a background pane
3. The monitor polls the pane every 5 seconds using `zellij action dump-screen`
4. On rate limit detection: parses the reset time, waits, then injects `continue`

The tool runs inside the same zellij session as Claude. There is no transparent session wrapping and no external daemon.

## Requirements

- Node.js >= 20
- zellij >= 0.40
- Must be inside a zellij session when running
