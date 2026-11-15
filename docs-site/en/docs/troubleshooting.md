# Deployment & Runtime FAQ

## 1. `SharedArrayBuffer unavailable (crossOriginIsolated=false)`

Verify that your server sends both `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`, and that you access the player over `HTTPS` or `localhost`/`127.0.0.1`. Accessing a LAN IP over plain `http://` disables `crossOriginIsolated`.

## 2. `serve-player.py` refuses to start with port-in-use errors

`PlayerServer` uses exclusive port binding on port `17881` to stop multiple builds from racing on requests. Terminate any existing preview Python process or Docker container holding port `17881` first.

## 3. Online manifest download aborts mid-transfer

Check that your CDN/object storage returns `HTTP 206 Partial Content` (not `200 OK`), avoids redirects, sends empty/`identity` `Content-Encoding` (disable transparent gzip on `.iso`), allows CORS headers, and that no second browser tab holds the `ppsspp-download-<fingerprint>` Web Lock.

## 4. `prepare-deploy.mjs` fails before EdgeOne deployment

`prepare-deploy.mjs` blocks production deployment if the WASM binary was compiled with diagnostic flags (`WASM_FRAME_TIMING` or `WASM_IR_BLOCK_PROFILE`) unless `--allow-diagnostics` is passed explicitly, or if memory/thread bounds fall outside configured limits.

## 5. Stale core or UI after redeployment

Ensure `/sw.js` and `/build-info.json` are served with `Cache-Control: no-cache` and unregister older Service Workers if testing rapidly in browser DevTools.
