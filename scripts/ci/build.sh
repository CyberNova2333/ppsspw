#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

test "$(node --version)" = "v24.21.0"
test "$(npm --version)" = "11.19.0"
emcc --version | head -n 1 | grep -q '6.0.12'
if [ -n "$(git ls-files resources)" ]; then
  printf '%s\n' 'Game resources must not be tracked or included in builds.' >&2
  exit 1
fi

npm --prefix wasm-page ci
npm --prefix wasm-page test
python3 -m unittest discover -s server/player-tests -v
node --test scripts/ci/prepare-deploy.test.mjs
python3 scripts/test-sdl-viewport.py
make wasm-release WASM_JOBS=-j8 WASM_FFMPEG_JOBS=8 WASM_ENABLE_LTO=OFF
npm --prefix wasm-page run build:pages
python3 scripts/package-player.py
# Push builds are independent of private configuration and never publish.
node scripts/ci/prepare-deploy.mjs
