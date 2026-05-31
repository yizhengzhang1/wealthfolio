#!/usr/bin/env bash
# Rebuild the patched Wealthfolio web image and restart the local container.
# One-shot helper for the "edit source -> rebuild -> restart" iteration loop on
# THIS machine (see .claude/CLAUDE.md "Network / Proxy"):
#   - build downloads go through the phone hotspot proxy (127.0.0.1:7892),
#     which requires --network=host so the build RUN steps can reach it;
#   - the container runs with --network host + HTTPS_PROXY=hotspot so its
#     market-data (Yahoo) egress works (company wired proxy blocks Yahoo).
# Backend Rust layers are cached, so a frontend-only change rebuilds in ~2-3 min.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"
cd "$REPO"

IMAGE="wealthfolio/wealthfolio:patched-local"
NAME="wf-ibkr-test"
VOL="wf-ibkr-data"
HOTSPOT="http://127.0.0.1:7892"

echo "==> building $IMAGE (hotspot proxy, host network)"
DOCKER_BUILDKIT=1 docker build --network=host -f Dockerfile -t "$IMAGE" \
  --build-arg http_proxy="$HOTSPOT"  --build-arg https_proxy="$HOTSPOT" \
  --build-arg HTTP_PROXY="$HOTSPOT"  --build-arg HTTPS_PROXY="$HOTSPOT" \
  --build-arg no_proxy=localhost,127.0.0.1 --build-arg NO_PROXY=localhost,127.0.0.1 \
  . || { echo "BUILD FAILED"; exit 1; }

# Pull WF_* config from .env (single-quoted hash kept literal).
SECRET=$(sed -n 's/^WF_SECRET_KEY=//p' .env)
HASH=$(sed -n "s/^WF_AUTH_PASSWORD_HASH='\(.*\)'/\1/p" .env)
CORS=$(sed -n 's/^WF_CORS_ALLOW_ORIGINS=//p' .env)

echo "==> restarting container $NAME"
docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" --network host \
  -e WF_LISTEN_ADDR=0.0.0.0:8088 -e WF_DB_PATH=/data/wealthfolio.db \
  -e WF_SECRET_KEY="$SECRET" -e WF_AUTH_PASSWORD_HASH="$HASH" \
  -e WF_AUTH_TOKEN_TTL_MINUTES=60 -e WF_CORS_ALLOW_ORIGINS="$CORS" \
  -e HTTP_PROXY="$HOTSPOT" -e HTTPS_PROXY="$HOTSPOT" \
  -e http_proxy="$HOTSPOT" -e https_proxy="$HOTSPOT" \
  -e NO_PROXY=localhost,127.0.0.1 -e no_proxy=localhost,127.0.0.1 \
  -v "$VOL":/data "$IMAGE" >/dev/null || { echo "RUN FAILED"; exit 1; }

sleep 4
printf '==> healthz: '; curl -s --noproxy '*' -m 8 http://localhost:8088/api/v1/healthz; echo
echo "==> done. Hard-refresh http://${WF_PUBLIC_HOST:-localhost}:8088 (Ctrl+Shift+R)."
