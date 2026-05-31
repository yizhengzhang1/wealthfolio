#!/usr/bin/env bash
# Install (or refresh) the hourly cron entry for the IBKR sync.
# Idempotent: safe to re-run; it replaces any pre-existing entry with the
# IBKR_SYNC_TAG marker.
set -euo pipefail

IBKR_SYNC_TAG="# managed-by:ibkr-sync"
# Resolve run-hourly.sh next to this installer — host-portable, no hardcoded path.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
SCRIPT="$SCRIPT_DIR/run-hourly.sh"
CRON_LINE="0 * * * * $SCRIPT  $IBKR_SYNC_TAG"

# Snapshot existing crontab (empty if none), strip our prior entries, append fresh.
current=$(crontab -l 2>/dev/null || true)
filtered=$(printf '%s\n' "$current" | grep -v -F "$IBKR_SYNC_TAG" || true)
{
  printf '%s\n' "$filtered"
  printf '%s\n' "$CRON_LINE"
} | sed '/^$/d' | crontab -

echo "Installed:"
crontab -l | grep -F "$IBKR_SYNC_TAG"
