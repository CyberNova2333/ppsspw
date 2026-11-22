# Overview & Scope Boundaries

PPSSPW packages an upstream `ppsspp-wasm` + `ppsspp-web` browser PSP emulator wrapper alongside an Angular control shell, an 8 MiB windowed ISO reader, OPFS persistence, SHA-256 chunked game downloads, mobile touch controls, and a self-hosted Ad Hoc WebSocket relay stack.

## Runtime Tabs & Capabilities

The active frontend build (`ppsspp-player-v22`) exposes 8 panels in the right sidebar (`wasm-page/src/app/app.html`):

| Tab | Role | Backing Mechanism |
| --- | --- | --- |
| Library (`library`) | Import user-owned local `.iso`/`.cso`/`.chd` images or launch installed games | `BrowserFileLoader`, OPFS |
| Online (`online`) | Validate HTTPS chunk manifests and run resumable downloads | `game-download.js`, Web Locks |
| Settings (`settings`) | Configure `1x`–`3x` internal resolution, display, and touch layout | Layered over `WEB_NATIVE_TIMING_CONFIG` |
| Saves (`saves`) | Manage Memory Stick saves and savestate snapshots | OPFS `/ppsspp-web/persist` |
| Storage (`storage`) | Inspect, export, or purge cached OPFS downloads and save data | `PpssppGameStorage` |
| Info (`info`) | Record real-time FPS, speed, startup phase, and sanitized JSON reports | `performance.js` |
| Log (`log`) | Inspect timestamped, color-coded runtime and audio diagnostics (500-line cap) | In-memory buffer |
| About (`about`) | Show core build metadata, provenance, and licensing notices | `build-info.json` |

> [!IMPORTANT]
> **Multiplayer & cloud UI gate**: `LOCAL_ONLY = true` (`wasm-page/public/ppsspp-runtime.js:31`) currently hides `tabNetwork` and `tabDrive` inside `.legacy-integrations[hidden][inert]`. See [Contracts](/en/docs/contracts) for the underlying `PRO`/`PU1`/`PT1` relay protocol.

## Browser Preconditions & Scope Limits

1. **Cross-Origin Isolation is required**: Emscripten `pthreads` and the `SharedArrayBuffer` audio ring require `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` (`window.crossOriginIsolated === true`).
2. **Secure Context required outside localhost**: Production deployments require `HTTPS` (`localhost`, `127.0.0.1`, and `[::1]` work locally over HTTP).
3. **Zero bundled ROMs or credentials**: Neither the repository nor CI pipelines contain PSP game images, manifest URLs, or third-party credentials.

Continue to [Deployment, Headers & Manifests](/en/docs/deployment), or inspect per-component constants, manifest CLI flags, and relay framing in [API & Component Reference](/en/api-reference/).
