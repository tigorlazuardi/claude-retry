#!/usr/bin/env node
import { capturePane, inject, listClaudePanes } from './zellij.ts';
import { runMonitor, runMultiMonitor } from './monitor.ts';

const USAGE = `claude-retry — Auto-inject 'continue' when Claude hits a rate limit in zellij

Usage:
  claude-retry start               Watch ALL Claude panes (re-discovers each pass)
  claude-retry monitor <pane-id>   Watch one specific zellij pane by ID
  claude-retry help                Show this help

Options:
  CLAUDE_PANE_ID=<id>   Pin 'start' to a single pane instead of auto-discovery

Run as a foreground daemon in a dedicated zellij pane. 'start' polls every
60s, finds every pane running the 'claude' CLI, and injects 'continue' after
each one's rate-limit reset time. New Claude sessions are picked up
automatically; closed panes are dropped. Logs go to stderr.`;

/** Timestamped stderr logger — chatty so the daemon shows clear signs of life. */
function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 19); // HH:MM:SS
  process.stderr.write(`[${ts}] ${msg}\n`);
}

const deps = {
  capture: (id: string) => capturePane(id),
  inject: (id: string, text: string) => inject(id, text),
  now: () => Date.now(),
  sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  listPanes: () => listClaudePanes(),
  log,
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
      log(`monitoring single pane ${paneId} (poll 5s)`);
      await runMonitor(paneId, deps);
      break;
    }

    case 'start': {
      log('claude-retry daemon starting — discovering Claude panes (poll 60s)');
      await runMultiMonitor(deps);
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
