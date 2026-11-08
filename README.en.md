# PPSSPW · PSP in the browser

[简体中文](README.md) | **English**

PPSSPW is an unofficial Chinese browser client based on the PPSSPP WebAssembly emulator. The repository contains the web client, emulator source and expanded dependencies so builds do not require fetching upstream or applying an old patch series.

## Capabilities

- Local game selection and an explicit browser game library.
- Imported download manifests, chunked downloads and resumable storage; no bundled game catalog or download origin.
- Touch controls, physical-controller and keyboard input, mobile layouts and orientation fallback.
- Rendering-resolution preferences, frame-rate display, save import/export and local synchronization.
- Optional diagnostics with documented privacy and measurement boundaries.

Game files are provided by the user. Choosing a file does not automatically store a library copy. Saves must first be made inside the game, then synchronized or exported; browser storage may be cleared or reclaimed. A higher rendering resolution does not reconstruct missing texture detail or provide image super-resolution.

## Build and run

Use Linux or WSL for the core, an activated Emscripten 6.0.12 SDK, CMake/Ninja/Make, Python 3.9+, and Node/npm versions accepted by `wasm-page/package.json` (npm 11.19+). The Chinese README and checked-in CI files define the complete toolchain.

```sh
npm --prefix wasm-page ci
make wasm-release WASM_JOBS=-j8 WASM_FFMPEG_JOBS=8
npm --prefix wasm-page run build:pages
python scripts/package-player.py
python server/serve-player.py
```

Open `http://127.0.0.1:17881/`. `make pages` also builds the core, web app and package. A web-only rebuild clears Angular's output, so package the matching core again. `npm --prefix wasm-page start` is useful for UI development but cannot replace the core artifacts needed for games.

The preview server serves only the packaged directory and adds COOP/COEP headers. It does not serve game resources or repository source. Mobile access needs trusted HTTPS; use the server's bind/certificate/key options as appropriate. WebGL2, Wasm SIMD, cross-origin isolation and shared memory are checked before launch. Actual device speed and game compatibility require real-device verification.

## Verification

```sh
npm --prefix wasm-page test
python -m unittest discover -s server/player-tests -v
node --test scripts/ci/prepare-deploy.test.mjs
node --test scripts/profile-browser.test.mjs
```

These are existing verification entrypoints, not results from this documentation pass. No emulator build, business test or real-game run was performed here, and the current application output was preserved.

## Deployment and scope

Formal release uses a full-source build on GitHub Actions and a manual deployment entry point. GitHub reads the project name, deployment credential, and public verification origin from repository Actions secrets, exposing each only to its deployment or verification step. Keep credentials in project-specific private configuration; do not put them into manifests or documentation. See [deployment](docs/deployment.md), [downloads](docs/game-download.md) and [performance measurements](docs/browser-performance.md). The client does not include games or grant rights to game content.

## Read the implementation

Start at the [Chinese guide](repo-docs/README.md), follow [local file to emulator startup](repo-docs/walkthroughs/one-real-run.md), and use the [code map](repo-docs/code-map.md) for changes. The guide intentionally excludes emulator CPU/GPU internals and the full online-download/synchronization paths.

## License

The project is distributed under [GPLv3](LICENSE). Imported PPSSPP and web-runtime components retain their GPL-2.0-or-later notices and may be distributed under GPLv3; other components retain their own notices. See [upstream provenance](UPSTREAM.md). Game content is outside this license.

## Documentation site

The [Chinese living guide](repo-docs/README.md) follows one real workflow and states what it leaves uncovered. Build or serve it with its separate Node.js dependencies:

```sh
npm --prefix docs-site ci
npm --prefix docs-site run docs:dev -- --host 127.0.0.1
npm --prefix docs-site run docs:build
```

The documentation site uses the default VitePress theme, with dependencies installed separately from the application. Output defaults to `docs-site/.vitepress/dist/`; append `-- --outDir <external-absolute-directory>` for an isolated build. Markdown remains in `repo-docs/` and is included by the site. Repository source links are shown as exact paths; source files and local resources are not published.
