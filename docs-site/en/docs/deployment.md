# Deployment, Headers & Manifests

PPSSPW separates heavy C++/Emscripten compilation from lightweight static hosting. Production serving only needs `wasm-page/dist/ppsspp-web/` plus strict cross-origin isolation HTTP headers.

## 1. Local Packaged Preview

```sh
# Build Angular shell and validate/bundle WASM artifacts into wasm-page/dist/ppsspp-web
make app-build && python3 scripts/package-player.py

# Serve with mandatory COOP/COEP/CORP/CSP headers on 127.0.0.1:17881
python3 server/serve-player.py
```

- `PlayerServer` enforces exclusive port binding on `127.0.0.1:17881` to prevent stale background processes from racing on requests.
- For mobile LAN testing over HTTPS, pass `--bind 0.0.0.0 --cert cert.pem --key key.pem` (and `--connect-origin <url>` if downloading from an external HTTPS origin).

## 2. Docker Compose Static Preview

`docker-compose.yml` mounts `./wasm-page/dist/ppsspp-web` read-only into `python:3.13-slim` and starts `serve-player.py` on `0.0.0.0:17881`:

```sh
docker compose up -d
```

Note that Docker Compose only serves prebuilt `wasm-page/dist/ppsspp-web` assets; it does not run Emscripten builds.

## 3. Full Toolchain Build & EdgeOne CI Release

`scripts/ci/Dockerfile` pins `node:24.21.0`, `pnpm@12.6.0`, and `emsdk:6.0.12`. Full compilation runs `scripts/ci/build.sh` (`test-sdl-viewport.py`, `test-tabbed-layout.py`, `make wasm-ffmpeg`, `make wasm-release`, `app-build-pages`, `package-player.py`).

Manual deployment (`.github/workflows/deploy.yml`, `workflow_dispatch`) validates build bounds via `scripts/ci/prepare-deploy.mjs` (blocking unflagged diagnostic cores built with `WASM_FRAME_TIMING` or `WASM_IR_BLOCK_PROFILE`), runs `edgeone makers deploy`, and verifies live headers via `verify-deployment.mjs` using three repository Actions secrets (`EDGEONE_PROJECT_NAME`, `EDGEONE_PAGES_API_TOKEN`, `PLAYER_PUBLIC_ORIGIN`).

## 4. Required HTTP Headers for Any Reverse Proxy

| Route | Required Header | Purpose |
| --- | --- | --- |
| `/*` | `Cross-Origin-Opener-Policy: same-origin` | Enables cross-origin isolation |
| `/*` | `Cross-Origin-Embedder-Policy: require-corp` | Unlocks `SharedArrayBuffer` & `pthreads` |
| `/*` | `Cross-Origin-Resource-Policy: same-origin` | Restricts unauthorized cross-site embedding |
| `/*` | `Content-Security-Policy` (`worker-src 'self' blob:; connect-src 'self' blob: https:`) | Allows Worker scripts and HTTPS range chunks |
| `/build-wasm/*.wasm` | `Content-Type: application/wasm` | Enables `instantiateStreaming` |
| `/sw.js`, `/build-info.json` | `Cache-Control: no-cache` | Prevents stale Service Worker (`ppsspp-player-v16`) metadata |

## 5. Creating Chunked Game Manifests & Optional Relay Stack

```sh
python3 scripts/create-game-manifest.py path/to/game.iso \
  --url https://static.example.com/psp/game.iso \
  --chunk-size 4194304 \
  --out ./game.manifest.json
```

- Limits enforced by `create-game-manifest.py` and `online-games.js`: `64 KiB`–`16 MiB` chunks (default `4 MiB`), `<= 8 GiB` game size, `<= 1 MiB` manifest JSON, `1–6` HTTPS sources (HTTP allowed only on `localhost` / `127.0.0.1` / `[::1]`).
- Optional Ad Hoc relay deployment lives separately in `deploy/relay/` (`compose.yml` + `Caddyfile` exposing `/healthz` and `/adhoc`; configured via `.env.example` `RELAY_AUTH_MODE=open|keys`, `RELAY_MAX_CONNECTIONS=512`, `RELAY_TIMEOUT=60`).
