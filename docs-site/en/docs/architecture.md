# Architecture & Interactive Diagram

PPSSPW combines an Angular control shell, pure-browser worker scripts, minimal upstream patches inside `deps/ppsspp-wasm/`, and standalone Python/Docker packaging and relay services.

<DiagramFrame
  src="/diagrams/ppsspw-architecture.html"
  title="PPSSPW Frontend & WASM Architecture (Interactive Archify Diagram)"
  aspect="940 / 368"
  new-tab-label="Open Fullscreen ↗"
/>

## Four-Layer Responsibility Split

1. **Angular UI Shell (`wasm-page/src/`)**: Renders the 8 active tabs + canvas viewport and sequentially loads the 6 public runtime scripts via `PpssppRuntime` (`ppsspp-runtime.ts`).
2. **Browser Runtime & Workers (`wasm-page/public/`)**: Enforces `crossOriginIsolated` + WebGL2 preflight, manages `browser-files.js` (8 MiB window), `game-download.js` / `download-worker.js` (HTTP 206 + SHA-256 + OPFS), `touch-controls.js` (`60 ms` minimum tap duration, per-pointer D-pad replacement, `cancelAll()` on layout changes), and `sw.js` (`ppsspp-player-v16`).
3. **Minimal Upstream WASM Patch Set (`deps/ppsspp-wasm/`)**: Pinned upstream provenance (`UPSTREAM.md`, `upstream/source-lock.json`) with scoped edits in `Core/FileLoaders/BrowserFileLoader.cpp`, `SDL/SDLMain.cpp` (`EmuThreadStart` pthread & `UpdateScreenDPI` ordering), and `UI/TabbedDialogScreen.cpp` (`720` UI-unit horizontal tab switch).
4. **Delivery & Relay Tooling (`scripts/`, `server/`, `deploy/relay/`)**: Handles builds, `prepare-deploy.mjs` security/header gates, `PlayerServer` preview, and optional `relay.py` deployment.

Deep code walkthroughs, module specs, and source-evidence ledgers are maintained in Chinese under the repository's `repo-docs/` directory (`repo-docs/README.md`, `repo-docs/walkthroughs/one-real-run.md`, `repo-docs/code-map.md`, `repo-docs/modules/`). See [Decisions, ADRs & Investigations](/en/docs/decisions) next.
