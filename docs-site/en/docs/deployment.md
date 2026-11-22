# Deployment, Headers & Manifests

PPSSPW separates heavy C++/Emscripten compilation from lightweight static hosting. Production serving only needs `wasm-page/dist/ppsspp-web/` plus strict cross-origin isolation HTTP headers.

## 1. Local Packaged Preview

```sh
# Build Angular shell and validate/bundle WASM artifacts into wasm-page/dist/ppsspp-web
make app-install app-build-pages

# Serve with mandatory COOP/COEP/CORP/CSP headers on 127.0.0.1:17881
python3 server/serve-player.py
```

- `PlayerServer` enforces exclusive port binding on `127.0.0.1:17881` to prevent stale background processes from racing on requests.
- For mobile LAN testing over HTTPS, pass `--bind 0.0.0.0 --cert cert.pem --key key.pem` (and `--connect-origin <url>` if downloading from an external HTTPS origin).

## 2. Docker Compose Static Preview

`docker-compose.yml` mounts the packaged player read-only at `/app/wasm-page/dist/ppsspp-web` in the container. The service listens on `0.0.0.0:17881` inside the container and is published on `127.0.0.1:17881` on the host.

```sh
docker compose up -d
```

Note that Docker Compose only serves prebuilt `wasm-page/dist/ppsspp-web` assets; it does not run Emscripten builds.

## 3. Full Toolchain Build & EdgeOne CI Release

`scripts/ci/Dockerfile` pins Node 24.21.0, pnpm 12.6.0 and Emscripten 6.0.12. Inside this toolchain, `scripts/ci/build.sh` installs the locked dependencies, runs `make test-ci`, then builds the core with `make wasm-release`. The final `make app-build-pages` builds the web UI and invokes the packager. It rejects diagnostic cores by default and copies all five license texts linked from the About panel.

The deploy workflow installs the CLI from the frozen lockfile in `scripts/ci/deploy-tool` and checks its deploy command during dry runs.

During deployment preparation, `scripts/ci/prepare-deploy.mjs` checks that all five texts exist and contain data before cleaning up old manifests, writing the header configuration and assigning a deployment revision. The manual deployment workflow can run this build as a dry run. After publication, its optional live check verifies the deployment revision and HTTP headers.

## 4. Required HTTP Headers for Any Reverse Proxy

| Route | Required Header | Purpose |
| --- | --- | --- |
| `/*` | `Cross-Origin-Opener-Policy: same-origin` | Enables cross-origin isolation |
| `/*` | `Cross-Origin-Embedder-Policy: require-corp` | Unlocks `SharedArrayBuffer` & `pthreads` |
| `/*` | `Cross-Origin-Resource-Policy: same-origin` | Restricts unauthorized cross-site embedding |
| `/*` | `Content-Security-Policy` (`worker-src 'self' blob:; connect-src 'self' blob: https:`) | Allows Worker scripts and HTTPS range chunks |
| `/build-wasm/*.wasm` | `Content-Type: application/wasm` | Enables `instantiateStreaming` |
| `/sw.js`, `/build-info.json` | `Cache-Control: no-cache` | Prevents stale Service Worker (`ppsspp-player-v22`) metadata |

## 5. Creating Chunked Game Manifests & Optional Relay Stack

```sh
python3 scripts/create-game-manifest.py path/to/game.iso \
  --url https://static.example.com/psp/game.iso \
  --chunk-size 4194304 \
  --out ./game.manifest.json
```

- Limits enforced by `create-game-manifest.py` and `online-games.js`: `64 KiB`–`16 MiB` chunks (default `4 MiB`), `<= 8 GiB` game size, `<= 1 MiB` manifest JSON, `1–6` HTTPS sources (HTTP allowed only on `localhost` / `127.0.0.1` / `[::1]`).
- Optional Ad Hoc relay deployment lives separately in `deploy/relay/` (`compose.yml` + `Caddyfile` exposing `/healthz` and `/adhoc`; configured via `.env.example` `RELAY_AUTH_MODE=open|keys`, `RELAY_MAX_CONNECTIONS=512`, `RELAY_TIMEOUT=60`).
