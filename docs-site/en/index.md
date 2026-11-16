---
layout: home

hero:
  name: "PPSSPW"
  text: "PPSSPP WebAssembly Runtime in the Browser"
  tagline: "8 MiB windowed ISO reads, OPFS persistent saves, SHA-256 chunked resume, and multi-threaded WebGL2 emulation."
  actions:
    - theme: brand
      text: "Getting Started & Deploy"
      link: /en/docs/
    - theme: alt
      text: "API & Components"
      link: /en/api-reference/
    - theme: alt
      text: "Architecture & Diagram"
      link: /en/docs/architecture

features:
  - title: "8 MiB Windowed ISO Access"
    details: "BrowserFileLoader proxies ReadAt from the emulator pthread to 256 KiB slices capped by an 8 MiB LRU cache, keeping large ISOs out of MEMFS."
  - title: "OPFS Resume & Chunked Savestates"
    details: "Dedicated download workers verify HTTP 206 ranges with per-block SHA-256 before writing OPFS sync handles, paired with 1 MiB chunked ZSTD savestate reads."
  - title: "Header Enforcement & Optional Relay"
    details: "Ships COOP/COEP/CORP preview tooling, EdgeOne deployment gates, and a self-hosted PRO/PU1/PT1 Ad Hoc WebSocket relay stack."
---

::: info Delivered Capabilities (How Far It Goes)
- Streams local `1.5 GB+` `.iso`/`.cso`/`.chd` images on-demand (`256 KiB` slices / `8 MiB` LRU / `4` concurrent reads), verifies `HTTP 206` + per-block `SHA-256` chunks into OPFS under Web Locks, and streams `1 MiB` ZSTD savestates.
- Provides `1x–3x` 3D scaling, an `8 ms` SAB `SP-shim AudioWorklet`, sanitized telemetry exports, and a `PRO`/`PU1`/`PT1` WebSocket relay stack — explore every module and CLI flag in [API & Components](/en/api-reference/).
:::

::: warning Explicit Non-Goals & Hard Boundaries
- **Zero ROMs/credentials & hidden Netplay UI (`LOCAL_ONLY = true`)**: Ships zero games or keys; default frontend sets `LOCAL_ONLY = true` (`ppsspp-runtime.js:31`), keeping `tabNetwork` and `tabDrive` `hidden` and `inert`.
- **Requires COOP/COEP & HTTPS outside localhost**: Without `crossOriginIsolated === true`, `pthreads` and SAB audio rings cannot run; `1x–3x` scaling enhances 3D geometry only (never 2D textures).
- **No runtime core rebuild & no HTTP admin panel**: `docker-compose.yml` mounts prebuilt `dist` only (`emsdk:6.0.12` needed to rebuild C++), and `relay_admin.py` is CLI-only with zero HTTP endpoints.
:::

## Architecture Overview

<DiagramFrame
  src="/diagrams/ppsspw-architecture.html"
  title="PPSSPW Browser WebAssembly Runtime Architecture (Archify interactive diagram; pan / zoom / inspect)"
  aspect="940 / 368"
  new-tab-label="Open Fullscreen ↗"
/>

## Quick Start Demo

```bash
# 1. Start local preview server with COOP/COEP isolation headers
python3 scripts/serve-player.py --root web/player --port 8080

# 2. Run offline verification suite (manifest, deployment gates, and relay tests)
python3 -m unittest discover -s tests -p "test_*.py" -v
```

## Documentation Guide

::: tip Quick Navigation by Goal
- **Run locally or deploy static assets**: Start with [Deployment, Headers & Manifests](/en/docs/deployment) and [Deployment & Runtime FAQ](/en/docs/troubleshooting) to launch via `serve-player.py`, Docker Compose, or EdgeOne with valid COOP/COEP headers;
- **Integrate chunk manifests, relay, or tune FPS**: Read [8 MiB Window, Range & Relay Contracts](/en/docs/contracts) and [Render Scale, Audio & Stability Tuning](/en/docs/performance) for manifest schemas, `PRO`/`PU1`/`PT1` framing, and `1x–3x` scaling;
- **Trace source ownership and key ADRs**: Explore [Architecture & Interactive Diagram](/en/docs/architecture) and [Decisions, ADRs & Investigations](/en/docs/decisions).
:::
