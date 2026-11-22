#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# This file is part of PPSSPW and is licensed under GNU AGPLv3 with Additional Terms (see LICENSE and LICENSE-ADDITIONAL_TERMS-zh-CN.md; ref: LICENSE-ADDITIONAL_TERMS-en.md).
set -euo pipefail
cd "$(dirname "$0")/../.."

test "$(node --version)" = "v24.21.0"
test "$(pnpm --version)" = "$(node -p "require('./wasm-page/package.json').packageManager.split('@').pop()")"
emcc --version | head -n 1 | grep -q '6.0.12'
if [ -n "$(git ls-files resources)" ]; then
  printf '%s\n' 'Game resources must not be tracked or included in builds.' >&2
  exit 1
fi

make app-install
make test-ci
make wasm-release WASM_JOBS=-j8 WASM_FFMPEG_JOBS=8 WASM_ENABLE_LTO=OFF
make app-build-pages
# Push builds are independent of private configuration and never publish.
node scripts/ci/prepare-deploy.mjs
