#!/usr/bin/env bash
# Invoked by cron every hour. Spawns a headless `claude -p` session that
# (1) calls the IBKR MCP tools, (2) runs src/sync.ts to push to Wealthfolio.
#
# Install: see scripts/install-cron.sh
# Logs:    tools/ibkr-sync/logs/sync-YYYYMMDD.log
set -uo pipefail

# Derive the repo root from this script's own location so the tool is
# host-portable (no hardcoded /home/<user>). This script lives at
# $REPO/tools/ibkr-sync/scripts/run-hourly.sh.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"

# Cron has a minimal env. Restore HOME (so claude finds
# ~/.claude/.credentials.json) and a realistic PATH so claude / npx / node /
# docker / etc. resolve correctly.
export HOME="${HOME:-$(getent passwd "$(id -un)" | cut -d: -f6)}"
export PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"

# Auth note: this script intentionally does NOT set CLAUDE_CODE_OAUTH_TOKEN.
# A long-lived token from `claude setup-token` disables claude.ai
# connectors (including the IBKR MCP we need). Instead, headless `claude -p`
# reads the interactive-login OAuth state from $HOME/.claude/.credentials.json
# and auto-refreshes via refreshToken on each run. If cron starts failing
# with "Not logged in" after long inactivity (90+ days), run `claude`
# interactively once to refresh, then cron resumes.

REPO="$(cd "$SCRIPT_DIR/../../.." && pwd)"
TOOL_DIR="$REPO/tools/ibkr-sync"
LOG_DIR="$TOOL_DIR/logs"
PROMPT_FILE="$TOOL_DIR/scripts/routine-prompt.txt"

mkdir -p "$LOG_DIR"

NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
LOG="$LOG_DIR/sync-$(date -u +%Y%m%d).log"

{
  echo ""
  echo "=== $NOW start (pid=$$) ==="
} >> "$LOG"

# The allowedTools list locks down what the headless session can do — only
# the IBKR read tools, plus the file/process primitives the prompt needs.
claude -p "$(sed "s|{REPO}|$REPO|g" "$PROMPT_FILE")" \
  --output-format text \
  --allowedTools "Bash,Read,Write,mcp__claude_ai_Interactive_Brokers_IBKR__get_account_positions,mcp__claude_ai_Interactive_Brokers_IBKR__get_account_balances,mcp__claude_ai_Interactive_Brokers_IBKR__get_account_summary" \
  --permission-mode acceptEdits \
  >> "$LOG" 2>&1

EC=$?

echo "=== $(date -u +%Y-%m-%dT%H:%M:%SZ) end (exit=$EC) ===" >> "$LOG"
exit $EC
