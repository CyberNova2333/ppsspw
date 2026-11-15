# Decisions, ADRs & Investigations

## Key Engineering Decisions

| Decision | Choice Kept | Rejected Alternative & Rationale | Source Anchor |
| --- | --- | --- | --- |
| ThinLTO | `WASM_ENABLE_LTO=OFF` | ThinLTO caused multi-threaded WebGL2 shader startup hangs | `deps/ppsspp-wasm/CMakeLists.txt` |
| Main loop scheduling | `requestAnimationFrame` (`60`) | Fixed 16 ms timers drifted against vsync and contributed to CI startup stalls | `deps/ppsspp-wasm/CMakeLists.txt` |
| Memory arena | `USE_NO_MMAP=ON` + `mimalloc` | Browser WASM linear memory lacks host `mmap` semantics | `wasm-page/tests/no-mmap-arena.cpp` |
| ISO access boundary | Zero-byte MEMFS stub (`ErrnoError(29)`) + `8 MiB` `BrowserFileLoader` | Full ISO buffering hits 32-bit memory limits; main-thread `ReadAt` returns `0` to prevent sync-proxy deadlocks | `BrowserFileLoader.cpp`, `browser-files.js` |
| Savestate ZSTD input | `1 MiB` chunked decompression | Whole-buffer allocation spiked WASM memory on large states | `UPSTREAM.md`, `state-zstd-input.cpp` |
| Multiplayer UI visibility | `LOCAL_ONLY = true` | Prevents exposing disconnected Netplay/Drive tabs when no public backend is configured | `wasm-page/public/ppsspp-runtime.js:31` |
| Diagnostic release gate | Reject `WASM_FRAME_TIMING` / `WASM_IR_BLOCK_PROFILE` by default | Stops high-overhead probes from shipping unless `--allow-diagnostics` is passed | `scripts/ci/prepare-deploy.mjs` |

## Migrated Investigation Notes

- **Audio pump converged to `8 ms` cadence**: Controlled local comparisons between `2 ms` and `8 ms` timer polling showed that keeping the AudioWorklet's `>= 70 ms` hardware-clock lookahead gate lets `setInterval(pump, 8)` cut main-thread wakeups without introducing extra audio or drops.
- **CI vs active workflows**: Active GitHub workflows in `.github/workflows/` are `ci.yml`, `deploy.yml` (EdgeOne Makers), and `docs-pages.yml` (GitHub Pages); optional Ad Hoc relay deployment lives independently under `deploy/relay/`.
- **Verification**: Run `pnpm --dir wasm-page test`, `python3 -m unittest discover -s server/player-tests -v`, and `python3 -m unittest discover -s server/tests -v` to exercise JS, protocol, and server guards locally without rebuilding WASM C++.
