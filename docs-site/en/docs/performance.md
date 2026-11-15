# Render Scale, Audio & Stability Tuning

## Default Timing, Memory & Build Baselines

`deps/ppsspp-wasm/CMakeLists.txt` locks core browser defaults:

- `WASM_INITIAL_MEMORY=536870912` (512 MiB) / `WASM_MAXIMUM_MEMORY=4294967296` (4 GiB)
- `WASM_COMPUTE_THREADS=2` / `WASM_PTHREAD_POOL_SIZE=auto`
- `WASM_MALLOC=mimalloc`, `USE_NO_MMAP=ON` (`MemArena` browser path without native `mmap`)
- `WASM_ENABLE_LTO=OFF` (avoids multi-threaded WebGL shader initialization stalls)
- `WASM_MAIN_LOOP_FPS=60` (tracks `requestAnimationFrame` instead of drifting fixed 16 ms timers)

Before launching a game, `wasm-page/public/ppsspp-runtime.js` writes `WEB_NATIVE_TIMING_CONFIG` (`ForceLagSync2=True`, `DisplayRefreshRate=60`, `FrameSkip=0`, `VerticalSync=True`, `AudioBufferSize=1024`, `FillAudioGaps=True`) and `WEB_STABILITY_CONFIG` (`IgnoreBadMemAccess=True`, `FastMemoryAccess=True`), then applies the user's `1x`–`3x` `InternalResolution` selection.

## 8 ms Clock-Gated Audio Pump & OPFS Ownership

- **Audio ring**: With `crossOriginIsolated`, `AudioWorklet` (`SP-shim`) consumes a `16384`-frame `SharedArrayBuffer` ring. `setInterval(pump, 8)` runs every `8 ms` (`ppsspp-runtime.js:4144`), pushing frames only when queued audio drops below the `>= 70 ms` lookahead threshold (with adaptive underrun headroom). Non-isolated fallback uses a `32768`-frame `ScriptProcessor`.
- **Zero-copy sync & chunked savestates**: OPFS persistence (`PERSIST_SYNC_MS = 30000`) uses `canOwn` buffer takeover and handle reuse, while savestate decompression uses 1 MiB chunked ZSTD streaming (`UPSTREAM.md`).

## Sanitized Telemetry & Profiling Boundaries

`wasm-page/public/performance.js` samples read-only atomic snapshots at emulation frame boundaries and exports sanitized JSON reports stripped of game titles, URLs, and runtime logs. Deeper offline diagnostics (`scripts/profile-browser.mjs`, `profile-frame-timing.mjs`, `profile-ir-blocks.mjs`, `compare-browser-performance.mjs`) require non-production diagnostic flags rejected by `prepare-deploy.mjs`. Restricted emulator environments missing 3D geometry are explicitly excluded from performance baselines.
