# >>> claude-retry >>>
claude() {
    if [ -z "${ZELLIJ:-}" ]; then
        echo "[claude-retry] Must run inside a zellij session" >&2
        return 1
    fi

    # Launch claude in a new pane, capture pane ID
    local pane_result
    pane_result=$(zellij run --close-on-exit -- claude "$@" 2>/dev/null)
    local pane_id
    pane_id=$(echo "$pane_result" | grep -oE '[0-9]+$')

    if [ -z "$pane_id" ]; then
        echo "[claude-retry] Failed to get pane ID from zellij run" >&2
        return 1
    fi

    # Start claude-retry monitor in a background pane
    CLAUDE_PANE_ID="$pane_id" zellij run --close-on-exit --name "claude-retry" -- claude-retry monitor "$pane_id"
}
# <<< claude-retry <<<
