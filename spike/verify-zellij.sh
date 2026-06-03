#!/usr/bin/env bash
# verify-zellij.sh — prove zellij capture+inject roundtrip works
# Exit 0 on full success, exit 1 on any failure.
set -euo pipefail

SESS="spike-verify-$$"
MARKER="ZELLIJ_SPIKE_$$"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

pass() { echo "[PASS] $*"; }
fail() {
  echo "[FAIL] $*"
  cleanup
  exit 1
}

cleanup() {
  zellij kill-session "$SESS" 2>/dev/null || true
}

# ---------------------------------------------------------------------------
# Step 1: zellij installed?
# ---------------------------------------------------------------------------

if ! command -v zellij &>/dev/null; then
  echo "[FAIL] zellij not found in PATH"
  exit 1
fi
pass "zellij found: $(zellij --version)"

# ---------------------------------------------------------------------------
# Step 2: create background test session
# ---------------------------------------------------------------------------

zellij attach --create-background "$SESS"
sleep 0.5
pass "session created: $SESS"

# ---------------------------------------------------------------------------
# Step 3: get terminal pane ID (first non-plugin pane)
# ---------------------------------------------------------------------------

PANES_JSON=$(zellij action list-panes -j 2>&1)

# Parse with node (contract prereq — node v26 required)
PANE_ID=$(PANES_JSON="$PANES_JSON" node --input-type=module <<'JSEOF'
import { createRequire } from 'module';
const raw = process.env.PANES_JSON ?? '';
let panes;
try { panes = JSON.parse(raw); } catch { process.exit(1); }
if (!Array.isArray(panes)) process.exit(1);
const t = panes.find(p => !p.is_plugin);
if (!t) { process.stderr.write('no terminal pane found\n'); process.exit(1); }
process.stdout.write(String(t.id));
JSEOF
)

if [ -z "$PANE_ID" ]; then
  fail "could not determine pane ID. list-panes output: $PANES_JSON"
fi
pass "pane ID resolved: $PANE_ID"

# ---------------------------------------------------------------------------
# Step 4: CAPTURE — dump-screen exits 0 and returns non-empty output
# ---------------------------------------------------------------------------

DUMP=$(zellij action dump-screen --pane-id "$PANE_ID" 2>&1)
if [ $? -ne 0 ]; then
  fail "dump-screen exited non-zero"
fi
if [ -z "$DUMP" ]; then
  fail "dump-screen returned empty output"
fi
pass "capture: dump-screen returned non-empty output"

# ---------------------------------------------------------------------------
# Step 5: WRITE+INJECT — write-chars + write 13, then verify in dump
# ---------------------------------------------------------------------------

zellij action write-chars --pane-id "$PANE_ID" "echo $MARKER"
sleep 0.2
zellij action write --pane-id "$PANE_ID" 13
sleep 0.5

DUMP2=$(zellij action dump-screen --pane-id "$PANE_ID" 2>&1)
if ! echo "$DUMP2" | grep -qF "$MARKER"; then
  fail "marker '$MARKER' not found in screen after inject. dump:\n$DUMP2"
fi
pass "write+inject: marker '$MARKER' appeared in screen output"

# ---------------------------------------------------------------------------
# Step 6: full inject roundtrip — second distinct marker
# ---------------------------------------------------------------------------

MARKER2="INJECT_OK_$$"

zellij action write-chars --pane-id "$PANE_ID" "echo $MARKER2"
sleep 0.2
zellij action write --pane-id "$PANE_ID" 13
sleep 0.5

DUMP3=$(zellij action dump-screen --pane-id "$PANE_ID" 2>&1)
if ! echo "$DUMP3" | grep -qF "$MARKER2"; then
  fail "marker '$MARKER2' not found in screen after second inject. dump:\n$DUMP3"
fi
pass "full inject roundtrip: '$MARKER2' confirmed in screen"

# ---------------------------------------------------------------------------
# Cleanup + done
# ---------------------------------------------------------------------------

cleanup
echo ""
echo "All checks passed."
exit 0
