#!/usr/bin/env node
import { capturePane, inject, resolvePaneId } from './zellij.ts';
import { runMonitor } from './monitor.ts';

const USAGE = `claude-retry — Auto-inject 'continue' when Claude hits a rate limit in zellij

Usage:
  claude-retry monitor <pane-id>   Monitor a specific zellij pane by ID
  claude-retry start               Auto-detect the Claude pane and start monitoring
  claude-retry help                Show this help

Options:
  CLAUDE_PANE_ID=<id>   Env var override for pane ID (used by 'start')

Run inside a zellij session. The tool monitors the target pane for
rate-limit messages and injects 'continue' after the reset time.`;

const deps = {
  capture: (id: string) => capturePane(id),
  inject: (id: string, text: string) => inject(id, text),
  now: () => Date.now(),
  sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
};

const [, , subcommand, ...rest] = process.argv;

async function main(): Promise<void> {
  switch (subcommand) {
    case 'monitor': {
      const paneId = rest[0];
      if (!paneId) {
        console.error('Error: pane-id required\n');
        console.error(USAGE);
        process.exit(1);
      }
      await runMonitor(paneId, deps);
      break;
    }

    case 'start': {
      const paneId = await resolvePaneId();
      await runMonitor(paneId, deps);
      break;
    }

    case 'help': {
      console.log(USAGE);
      process.exit(0);
      break;
    }

    default: {
      console.error(USAGE);
      process.exit(1);
    }
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
