# >>> claude-retry >>>
function claude
    if not set -q ZELLIJ
        echo "[claude-retry] Must run inside a zellij session" >&2
        return 1
    end

    # Launch claude in a new pane, capture pane ID
    # zellij run returns "terminal_N" on stdout
    set -l pane_result (zellij run --close-on-exit -- claude $argv 2>/dev/null)
    # pane_result is like "terminal_3" — extract the numeric ID
    set -l pane_id (echo $pane_result | grep -oE '[0-9]+$')

    if test -z "$pane_id"
        echo "[claude-retry] Failed to get pane ID from zellij run" >&2
        return 1
    end

    # Start claude-retry monitor in a background pane
    set -x CLAUDE_PANE_ID $pane_id
    zellij run --close-on-exit --name "claude-retry" -- claude-retry monitor $pane_id
end
# <<< claude-retry <<<
