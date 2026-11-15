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

## Quick Navigation by Goal

| Goal | Start Here | Outcome |
| --- | --- | --- |
| Run locally or deploy static assets | [Deployment, Headers & Manifests](/en/docs/deployment) | Launch via `serve-player.py`, Docker Compose, or EdgeOne with valid COOP/COEP headers |
| Fix startup blocks or Range failures | [Deployment & Runtime FAQ](/en/docs/troubleshooting) | Resolve `crossOriginIsolated=false`, port conflicts, stale Service Worker, and CORS issues |
| Integrate chunk manifests or Ad Hoc relay | [8 MiB Window, Range & Relay Contracts](/en/docs/contracts) | Inspect manifest limits, `PRO`/`PU1`/`PT1` framing, and the `LOCAL_ONLY = true` UI toggle |
| Tune FPS, render scale, and audio pump | [Render Scale, Audio & Stability Tuning](/en/docs/performance) | Configure `1x–3x` scale, `8 ms` audio cadence, and sanitized telemetry exports |
| Trace source ownership and key ADRs | [Architecture & Interactive Diagram](/en/docs/architecture) | Explore `/diagrams/ppsspw-architecture.html`, patch provenance, and engineering trade-offs |
