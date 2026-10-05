#!/usr/bin/env bash
# Deleted-items compatibility check against the real Notebook code.
#
#   scripts/notebook-compat.sh [NOTEBOOK_CHECKOUT]
#
# Copies the Notebook checkout (default: $NOTEBOOK_SRC, else
# /private/tmp/amed-notebook) to a scratch directory, adds
# src-tauri/tests/notebook-harness to the copy and builds it, starts a
# throwaway MinIO container (random fake credentials and bucket, bound to
# 127.0.0.1), runs src-tauri/tests/notebook_bin_compat.rs against it and
# removes the container. The checkout itself is never modified.
#
# Needs Docker, rsync, openssl and curl 7.75 or newer. NOTEBOOK_COMPAT_WORK
# picks the scratch directory, NOTEBOOK_COMPAT_TARGET the harness target dir,
# NOTEBOOK_COMPAT_MINIO_IMAGE the MinIO image. MinIO no longer publishes
# images on Docker Hub or quay.io, so the default is Bitnami's legacy build of
# the MinIO server; any image with a `minio` binary on PATH works.
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
source_dir="${1:-${NOTEBOOK_SRC:-/private/tmp/amed-notebook}}"
work="${NOTEBOOK_COMPAT_WORK:-$(mktemp -d "${TMPDIR:-/tmp}/notebook-compat.XXXXXX")}"
target="${NOTEBOOK_COMPAT_TARGET:-$work/target}"
copy="$work/notebook"

[ -f "$source_dir/src/app/deleted_items.rs" ] || {
  echo "not a Notebook checkout: $source_dir" >&2
  exit 1
}

echo "== Building Notebook harness from a copy of $source_dir"
mkdir -p "$copy"
rsync -a --delete --exclude target --exclude .git "$source_dir/" "$copy/"
cp "$repo/src-tauri/tests/notebook-harness/compat_harness.rs" "$copy/src/app/compat_harness.rs"
mkdir -p "$copy/src/bin"
cp "$repo/src-tauri/tests/notebook-harness/bin.rs" "$copy/src/bin/compat-harness.rs"
printf '\npub mod compat_harness;\n' >>"$copy/src/app/mod.rs"
printf '\npub use app::compat_harness;\n' >>"$copy/src/lib.rs"
CARGO_TARGET_DIR="$target" cargo build --quiet --locked \
  --manifest-path "$copy/Cargo.toml" --bin compat-harness
harness="$target/debug/compat-harness"

user="compat$(openssl rand -hex 4)"
password="$(openssl rand -hex 16)"
bucket="compat-$(openssl rand -hex 6)"
container="notebook-compat-minio-$$"
image="${NOTEBOOK_COMPAT_MINIO_IMAGE:-bitnamilegacy/minio:latest}"
echo "== Starting MinIO ($image as $container, bucket $bucket)"
docker image inspect "$image" >/dev/null 2>&1 || docker pull "$image"
docker run -d --rm --name "$container" -p 127.0.0.1::9000 \
  -e MINIO_ROOT_USER="$user" -e MINIO_ROOT_PASSWORD="$password" \
  --entrypoint minio "$image" server /tmp/minio-data >/dev/null
trap 'docker rm -f "$container" >/dev/null 2>&1 || true' EXIT
port="$(docker port "$container" 9000/tcp | head -n 1 | sed 's/.*://')"
endpoint="http://127.0.0.1:$port"
for _ in $(seq 1 60); do
  curl -fsS -o /dev/null "$endpoint/minio/health/ready" 2>/dev/null && break
  sleep 0.5
done
curl -fsS -X PUT --aws-sigv4 "aws:amz:us-east-1:s3" --user "$user:$password" \
  "$endpoint/$bucket" >/dev/null

echo "== Running the compatibility test"
NOTEBOOK_MINIO_URL="$endpoint" \
  NOTEBOOK_MINIO_BUCKET="$bucket" \
  NOTEBOOK_MINIO_ACCESS_KEY_ID="$user" \
  NOTEBOOK_MINIO_SECRET_ACCESS_KEY="$password" \
  NOTEBOOK_HARNESS_BIN="$harness" \
  cargo test --locked --manifest-path "$repo/src-tauri/Cargo.toml" \
  --test notebook_bin_compat -- --nocapture
