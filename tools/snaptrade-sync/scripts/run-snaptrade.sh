#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOL_DIR="$(dirname "$SCRIPT_DIR")"
REPO_ROOT="$(cd "$TOOL_DIR/../.." && pwd)"
export HOME="${HOME:-/home/samsung}"
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH"
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1 || true
# SnapTrade is an overseas API — use the phone-hotspot proxy (per project CLAUDE.md)
export HTTPS_PROXY="${HTTPS_PROXY:-http://127.0.0.1:7892}"
export HTTP_PROXY="${HTTP_PROXY:-http://127.0.0.1:7892}"
export NO_PROXY="localhost,127.0.0.1"
# secrets (gitignored): exports SNAPTRADE_* and WEALTHFOLIO_*
# shellcheck source=/dev/null
source "$REPO_ROOT/docs/snaptrade-sync/secrets.local.sh"
mkdir -p "$TOOL_DIR/logs"
LOG="$TOOL_DIR/logs/sync-$(date +%Y%m%d).log"
cd "$TOOL_DIR"
{
  echo "=== $(date -Is) start ==="
  npx tsx src/sync.ts
  echo "=== $(date -Is) end rc=$? ==="
} >> "$LOG" 2>&1
