# Architecture & Interactive Diagram

PPSSPW combines an Angular control shell, pure-browser worker scripts, minimal upstream patches inside `deps/ppsspp-wasm/`, and standalone Python/Docker packaging and relay services.

<div class="archify-diagram-card" style="margin: 1.5rem 0; border: 1px solid var(--vp-c-border); border-radius: 12px; overflow: hidden; background: var(--vp-c-bg-soft); box-shadow: 0 4px 16px rgba(0,0,0,0.06);">
  <div style="display: flex; justify-content: space-between; align-items: center; padding: 10px 18px; background: var(--vp-c-bg-elv); border-bottom: 1px solid var(--vp-c-border); font-size: 13px;">
    <span style="font-weight: 600; color: var(--vp-c-text-1); display: flex; align-items: center; gap: 8px;">
      <span style="font-size: 16px;">📐</span> PPSSPW Frontend & WASM Architecture (Interactive Archify Diagram)
    </span>
    <a href="/diagrams/ppsspw-architecture.html" target="_blank" rel="noreferrer" style="font-size: 12px; color: var(--vp-c-brand-1); text-decoration: none; font-weight: 500;">
      Open Fullscreen ↗
    </a>
  </div>
  <iframe src="/diagrams/ppsspw-architecture.html" width="100%" height="520px" frameborder="0" style="display: block; border: none;" allowfullscreen loading="lazy"></iframe>
</div>

## Four-Layer Responsibility Split

1. **Angular UI Shell (`wasm-page/src/`)**: Renders the 8 active tabs + canvas viewport and sequentially loads the 6 public runtime scripts via `PpssppRuntime` (`ppsspp-runtime.ts`).
2. **Browser Runtime & Workers (`wasm-page/public/`)**: Enforces `crossOriginIsolated` + WebGL2 preflight, manages `browser-files.js` (8 MiB window), `game-download.js` / `download-worker.js` (HTTP 206 + SHA-256 + OPFS), `touch-controls.js` (`60 ms` minimum tap duration, per-pointer D-pad replacement, `cancelAll()` on layout changes), and `sw.js` (`ppsspp-player-v16`).
3. **Minimal Upstream WASM Patch Set (`deps/ppsspp-wasm/`)**: Pinned upstream provenance (`UPSTREAM.md`, `upstream/source-lock.json`) with scoped edits in `Core/FileLoaders/BrowserFileLoader.cpp`, `SDL/SDLMain.cpp` (`EmuThreadStart` pthread & `UpdateScreenDPI` ordering), and `UI/TabbedDialogScreen.cpp` (`720` UI-unit horizontal tab switch).
4. **Delivery & Relay Tooling (`scripts/`, `server/`, `deploy/relay/`)**: Handles builds, `prepare-deploy.mjs` security/header gates, `PlayerServer` preview, and optional `relay.py` deployment.

Deep code walkthroughs, module specs, and source-evidence ledgers are maintained in Chinese under the repository's `repo-docs/` directory (`repo-docs/README.md`, `repo-docs/walkthroughs/one-real-run.md`, `repo-docs/code-map.md`, `repo-docs/modules/`). See [Decisions, ADRs & Investigations](/en/docs/decisions) next.
