#!/usr/bin/env bash
# Install (or refresh) the cron entry for the SnapTrade sync.
# Idempotent: safe to re-run; it replaces any pre-existing entry with the
# SNAPTRADE_SYNC_TAG marker.
#
# Schedule defaults to 0 10,12,22 * * *. Override with the first arg or $SNAPTRADE_SYNC_CRON,
# e.g. install-cron.sh "0 10,12,22 * * *" (cron uses the host's local time).
set -euo pipefail

SNAPTRADE_SYNC_TAG="# managed-by:snaptrade-sync"
CRON_SCHEDULE="${1:-${SNAPTRADE_SYNC_CRON:-0 10,12,22 * * *}}"
# Resolve run-snaptrade.sh next to this installer — host-portable, no hardcoded path.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
SCRIPT="$SCRIPT_DIR/run-snaptrade.sh"
CRON_LINE="$CRON_SCHEDULE $SCRIPT  $SNAPTRADE_SYNC_TAG"

# Snapshot existing crontab (empty if none), strip our prior entries, append fresh.
current=$(crontab -l 2>/dev/null || true)
filtered=$(printf '%s\n' "$current" | grep -v -F "$SNAPTRADE_SYNC_TAG" || true)
{
  printf '%s\n' "$filtered"
  printf '%s\n' "$CRON_LINE"
} | sed '/^$/d' | crontab -

echo "Installed:"
crontab -l | grep -F "$SNAPTRADE_SYNC_TAG"
