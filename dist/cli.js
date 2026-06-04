#!/usr/bin/env node
import { capturePane, inject, listPaneTargets, captureTarget, injectTarget, } from "./zellij.js";
import { runMonitor, runMultiMonitor } from "./monitor.js";
import { readAccessToken, fetchUsage } from "./usage.js";
import { discoverAccountDirs, resolvePaneConfigDir } from "./accounts.js";
const USAGE = `claude-retry — Auto-inject 'continue' when Claude hits a rate limit in zellij

Usage:
  claude-retry start               Watch ALL Claude panes across ALL sessions
  claude-retry monitor <pane-id>   Watch one pane by ID in the current session
  claude-retry help                Show this help

Run as a foreground daemon in any zellij pane (a dedicated session is ideal).
'start' polls every 60s, walks every live zellij session and every pane, and
auto-injects 'continue' after each Claude pane's rate-limit reset time. It works
on detached sessions and skips its own session. New Claude panes are picked up
automatically; closed ones are dropped. Logs go to stderr.

'monitor <pane-id>' is the legacy single-pane mode (current session only).`;
/** Timestamped stderr logger — chatty so the daemon shows clear signs of life. */
function log(msg) {
    const ts = new Date().toISOString().slice(11, 19); // HH:MM:SS
    process.stderr.write(`[${ts}] ${msg}\n`);
}
const now = () => Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Single-pane (legacy 'monitor') deps — addressed by bare pane id.
const singleDeps = {
    capture: (id) => capturePane(id),
    inject: (id, text) => inject(id, text),
    now,
    sleep,
};
// Multi-session ('start') deps — addressed by PaneTarget across sessions.
const multiDeps = {
    listTargets: () => listPaneTargets(),
    capture: (t) => captureTarget(t),
    inject: (t, text) => injectTarget(t, text),
    now,
    sleep,
    log,
    getAccountSnapshot: async () => {
        const dirs = await discoverAccountDirs();
        const byDir = new Map();
        await Promise.all(dirs.map(async (dir) => {
            try {
                const tok = await readAccessToken(dir);
                if (!tok)
                    return;
                const usage = await fetchUsage(tok.token);
                if (usage)
                    byDir.set(dir, usage);
            }
            catch {
                // swallow per-account errors — one bad account must not break the pass
            }
        }));
        return { byDir };
    },
    resolvePaneAccount: (t, snapshot) => resolvePaneConfigDir(t, snapshot),
};
const [, , subcommand, ...rest] = process.argv;
async function main() {
    switch (subcommand) {
        case 'monitor': {
            const paneId = rest[0];
            if (!paneId) {
                console.error('Error: pane-id required\n');
                console.error(USAGE);
                process.exit(1);
            }
            log(`monitoring single pane ${paneId} (poll 5s)`);
            await runMonitor(paneId, singleDeps);
            break;
        }
        case 'start': {
            log('claude-retry daemon starting — walking all sessions/panes (poll 60s)');
            log('usage-API detection enabled — account-aware rate-limit resolution active');
            await runMultiMonitor(multiDeps);
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
main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
});
//# sourceMappingURL=cli.js.map