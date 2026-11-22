# 8 MiB Window, Range & Relay Contracts

## 1. 8 MiB Windowed ISO Reading (`BrowserFileLoader`)

Loading a full 1.5 GB PSP ISO into Emscripten `MEMFS` exhausts 32-bit WASM linear memory. PPSSPW mounts a zero-byte read-only stub under `/browser-games/<name>` whose `read()` throws `ErrnoError(29)` (`EIO`), ensuring all disc reads pass through `BrowserFileLoader::ReadAt`.

- `deps/ppsspp-wasm/Core/FileLoaders/BrowserFileLoader.cpp` proxies `ReadAt` back to `wasm-page/public/browser-files.js` (`__proxy: 'sync'`, `__async: 'auto'`).
- `ReadAt` immediately returns `0` if called on `emscripten_is_main_runtime_thread()`. Therefore `deps/ppsspp-wasm/SDL/SDLMain.cpp` (`EmuThreadStart`) dispatches `EmuThreadFunc` onto a dedicated pthread whenever `BrowserFileLoaderHasFiles()` or `g_Config.bEnableWlan` is active.
- `browser-files.js` enforces `BLOCK_BYTES = 256 KiB`, `MAX_READ_BYTES = 1 MiB`, `CACHE_BYTES = 8 MiB` LRU window, and `READ_CONCURRENCY = 4`.

## 2. Manifest & HTTP Range Resume Contract

`game-download.js`, `online-games.js`, and Dedicated Worker `download-worker.js` enforce strict download integrity:

- Only `HTTP 206 Partial Content` responses with empty/`identity` `Content-Encoding` and no cross-origin redirect are accepted.
- Each chunk's SHA-256 is verified against the manifest (`schemaVersion: 1`, `64 KiB–16 MiB` chunks) before writing via OPFS `createSyncAccessHandle()` to `game-downloads/<fingerprint>/game.bin` and flushing the payload before updating one byte in `resume.bin`. Existing version-one journals remain readable.
- Concurrent downloads of the same fingerprint are serialized via Web Locks (`PpssppGameStorage.withShared` + exclusive `ppsspp-download-<fingerprint>`).

## 3. Ad Hoc WebSocket Relay Protocol (`LOCAL_ONLY = true` UI Gate)

While `wasm-page/public/ppsspp-runtime.js:31` sets `LOCAL_ONLY = true` (hiding `tabNetwork` and `tabDrive`), the repository includes a full WebSocket relay implementation (`server/relay.py`, `server/relay_auth.py`, `server/relay_admin.py`, `wasm-page/public/adhoc-transport.js`):

- 3-byte binary framing headers: `PRO` (registration/auth handshake), `PU1` (UDP packet relay), `PT1` (TCP stream relay).
- `RELAY_AUTH_MODE=keys` validates `psp_<16hex>.<43urlsafe>` tokens by constant-time comparison (`secrets.compare_digest`) of SHA-256 digests in `/data/relay-auth.sqlite3` managed solely via `relay_admin.py` CLI (`issue`, `list`, `revoke`).
- `RELAY_LATENCY_MS` and `RELAY_JITTER_MS` allow reproducible fault-injection testing alongside `server/tests/test_relay*.py` and `wasm-page/tests/adhoc-transport.test.mjs`.
