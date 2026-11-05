#!/usr/bin/env bash
# End-to-end check of the web version (web/) on a throwaway MinIO:
#  1. starts MinIO in Docker with random credentials and CORS for the test
#     site's origin (MinIO has no bucket CORS API; MINIO_API_CORS_ALLOW_ORIGIN
#     is its server-wide equivalent of the bucket rule in web/README.md),
#  2. builds the site into a scratch directory with MinIO in its CSP and
#     serves it with the deploy headers (tests/web-e2e/serve.mjs),
#  3. the desktop codec writes a note (src-tauri/tests/web_compat.rs),
#  4. Playwright drives the site at phone, tablet and desktop sizes in
#     Chromium and WebKit (tests/web-e2e/e2e.mjs),
#  5. the desktop codec opens everything the web app wrote,
# then removes the container. dist-web/ is not touched.
#
#   npm run test:web:e2e            (screenshots in test-results/web-e2e/)
#   E2E_BROWSERS=chromium E2E_SHOTS=/some/dir npm run test:web:e2e
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/notebook-web-e2e.XXXXXX")"
MINIO_PORT="${MINIO_PORT:-19400}"
WEB_PORT="${WEB_PORT:-19410}"
NAME="notebook-web-e2e-$$"
IMAGE="${MINIO_IMAGE:-bitnamilegacy/minio:latest}"
BUCKET="notebook-e2e"
PREFIX="team-notes"
SHOTS="${E2E_SHOTS:-$ROOT/test-results/web-e2e}"
mkdir -p "$WORK/docker" "$SHOTS"
export DOCKER_CONFIG="$WORK/docker" # empty: no registry credentials are read

dock() { perl -e 'alarm 90; exec @ARGV' docker "$@"; }

SERVER=""
MINIO_PID=""
cleanup() {
  [ -n "$SERVER" ] && kill "$SERVER" 2>/dev/null || true
  [ -n "$MINIO_PID" ] && kill "$MINIO_PID" 2>/dev/null || true
  dock rm -f "$NAME" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

AK="e2e$(openssl rand -hex 8)"
SK="$(openssl rand -hex 24)"
PHRASE="e2e phrase $(openssl rand -hex 6)"

# Docker by default; a native MinIO (MINIO_BIN, or `minio` on PATH, e.g.
# `brew install minio`) when Docker is not reachable from this account.
NATIVE="${MINIO_BIN:-}"
if [ -z "$NATIVE" ] && ! dock info >/dev/null 2>&1; then
  NATIVE="$(command -v minio || true)"
  [ -n "$NATIVE" ] || { echo "Docker is not reachable and no minio binary was found (brew install minio)." >&2; exit 1; }
fi
if [ -n "$NATIVE" ]; then
  echo "starting MinIO ($NATIVE) on 127.0.0.1:$MINIO_PORT"
  MINIO_ROOT_USER="$AK" MINIO_ROOT_PASSWORD="$SK" \
    MINIO_API_CORS_ALLOW_ORIGIN="http://127.0.0.1:$WEB_PORT" MINIO_BROWSER=off \
    "$NATIVE" server "$WORK/minio-data" --address "127.0.0.1:$MINIO_PORT" --quiet >"$WORK/minio.log" 2>&1 &
  MINIO_PID=$!
  for _ in $(seq 1 60); do
    curl -sf "http://127.0.0.1:$MINIO_PORT/minio/health/ready" >/dev/null && break
    sleep 1
  done
  curl -sf -X PUT --aws-sigv4 "aws:amz:us-east-1:s3" --user "$AK:$SK" "http://127.0.0.1:$MINIO_PORT/$BUCKET" >/dev/null
else
  echo "starting MinIO ($IMAGE) on 127.0.0.1:$MINIO_PORT"
  dock run -d --name "$NAME" -p "127.0.0.1:$MINIO_PORT:9000" \
    -e MINIO_ROOT_USER="$AK" -e MINIO_ROOT_PASSWORD="$SK" \
    -e MINIO_DEFAULT_BUCKETS="$BUCKET" \
    -e MINIO_API_CORS_ALLOW_ORIGIN="http://127.0.0.1:$WEB_PORT" \
    "$IMAGE" >/dev/null
  for _ in $(seq 1 60); do
    curl -sf "http://127.0.0.1:$MINIO_PORT/minio/health/ready" >/dev/null && break
    sleep 1
  done
  for _ in $(seq 1 30); do
    dock exec "$NAME" sh -c 'mc alias set local http://127.0.0.1:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null && mc ls local/'"$BUCKET" >/dev/null 2>&1 && break
    sleep 1
  done
fi

echo "building the site with MinIO in its CSP"
(cd "$ROOT" && NOTEBOOK_WEB_CONNECT_SRC="http://127.0.0.1:$MINIO_PORT" npx vite build --config web/vite.config.ts --outDir "$WORK/site" --emptyOutDir --logLevel warn)
node "$ROOT/tests/web-e2e/serve.mjs" "$WORK/site" "$WEB_PORT" >/dev/null &
SERVER=$!

export NOTEBOOK_WEB_MINIO_URL="http://127.0.0.1:$MINIO_PORT"
export NOTEBOOK_WEB_MINIO_BUCKET="$BUCKET" NOTEBOOK_WEB_MINIO_PREFIX="$PREFIX"
export NOTEBOOK_WEB_MINIO_ACCESS_KEY_ID="$AK" NOTEBOOK_WEB_MINIO_SECRET_ACCESS_KEY="$SK" NOTEBOOK_WEB_MINIO_PHRASE="$PHRASE"
cat > "$WORK/desktop-doc.json" <<'JSON'
{"folder": "From desktop", "name": "Desktop note.md", "text": "# Written by the desktop app\n\nThis note was encrypted by the **Rust** codec.\n\n## Checklist\n\n- [x] encrypted name\n- [ ] opened on the web\n\nSee [the second heading](#checklist).\n"}
JSON

echo "desktop codec writes a note"
(cd "$ROOT/src-tauri" && NOTEBOOK_WEB_DESKTOP_DOC="$WORK/desktop-doc.json" \
  cargo test --locked --quiet --test web_compat desktop_writes_a_document_for_the_web_app -- --nocapture 2>&1 | grep -E "desktop wrote|test result")

echo "web app, Playwright"
(cd "$ROOT" && E2E_WEB_URL="http://127.0.0.1:$WEB_PORT/" E2E_MINIO_URL="$NOTEBOOK_WEB_MINIO_URL" E2E_BUCKET="$BUCKET" E2E_PREFIX="$PREFIX" \
  E2E_AK="$AK" E2E_SK="$SK" E2E_PHRASE="$PHRASE" E2E_SHOTS="$SHOTS" E2E_EXPECT="$WORK/expect.json" \
  node tests/web-e2e/e2e.mjs)

echo "desktop codec opens what the web app wrote"
(cd "$ROOT/src-tauri" && NOTEBOOK_WEB_EXPECT="$WORK/expect.json" \
  cargo test --locked --quiet --test web_compat desktop_opens_documents_the_web_app_wrote -- --nocapture 2>&1 | grep -E "desktop opened|test result")

echo "screenshots: $SHOTS"
