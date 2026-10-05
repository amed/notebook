#!/usr/bin/env bash
# Fresh macOS build in one command: a universal (Apple Silicon + Intel) .app and .dmg.
#
#   npm run build:mac                build
#   npm run build:mac -- --install   build, then replace /Applications/Notebook.app
set -euo pipefail
cd "$(dirname "$0")/.."

# Homebrew's rustup is keg-only: its cargo/rustc wrappers are not on PATH by
# default. Prefer those wrappers over a toolchain's bin folder, because they
# also let rustc find libLLVM when it strips the release binary.
for dir in /opt/homebrew/opt/rustup/bin /usr/local/opt/rustup/bin "$HOME/.cargo/bin"; do
  if [ -x "$dir/cargo" ]; then
    export PATH="$dir:$PATH"
    break
  fi
done
if ! command -v cargo >/dev/null 2>&1; then
  echo "Rust is not installed. Install it from https://rustup.rs and run this again." >&2
  exit 1
fi

rustup target add aarch64-apple-darwin x86_64-apple-darwin >/dev/null
[ -d node_modules ] || npm ci

# On CI-like runs Tauri skips the Finder window-layout script in bundle_dmg.sh,
# which fails when Finder automation is not allowed.
export CI=true
npm run tauri -- build --target universal-apple-darwin

bundle=src-tauri/target/universal-apple-darwin/release/bundle
app="$bundle/macos/Notebook.app"
echo
echo "App: $app"
echo "DMG: $(ls "$bundle"/dmg/*.dmg)"

if [ "${1:-}" = "--install" ]; then
  osascript -e 'tell application id "com.securemd.vault" to quit' >/dev/null 2>&1 || true
  sleep 1
  rm -rf /Applications/Notebook.app
  ditto "$app" /Applications/Notebook.app
  echo "Installed /Applications/Notebook.app"
fi
