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
    - theme: alt
      text: "GitHub Repo"
      link: https://github.com/CyberNova2333/ppsspw

features:
  - title: "8 MiB Windowed ISO Access"
    details: "BrowserFileLoader proxies ReadAt from the emulator pthread to 256 KiB slices capped by an 8 MiB LRU cache, keeping large ISOs out of MEMFS."
  - title: "OPFS Resume & Chunked Savestates"
    details: "Dedicated download workers verify HTTP 206 ranges with per-block SHA-256 before writing OPFS sync handles, paired with 1 MiB chunked ZSTD savestate reads."
  - title: "Header Enforcement & Optional Relay"
    details: "Ships COOP/COEP/CORP preview tooling, EdgeOne deployment gates, and a self-hosted PRO/PU1/PT1 Ad Hoc WebSocket relay stack."
---

## Architecture Overview

<div class="archify-diagram-card" style="margin: 1.5rem 0; border: 1px solid var(--vp-c-border); border-radius: 12px; overflow: hidden; background: var(--vp-c-bg-soft); box-shadow: 0 4px 16px rgba(0,0,0,0.06);">
  <div style="display: flex; justify-content: space-between; align-items: center; padding: 10px 18px; background: var(--vp-c-bg-elv); border-bottom: 1px solid var(--vp-c-border); font-size: 13px;">
    <span style="font-weight: 600; color: var(--vp-c-text-1); display: flex; align-items: center; gap: 8px;">
      <span style="font-size: 16px;">📐</span> PPSSPW Browser WebAssembly Runtime Architecture (Archify interactive diagram; pan / zoom / inspect)
    </span>
    <a href="/diagrams/ppsspw-architecture.html" target="_blank" rel="noreferrer" style="font-size: 12px; color: var(--vp-c-brand-1); text-decoration: none; font-weight: 500;">
      Open Fullscreen ↗
    </a>
  </div>
  <iframe src="/diagrams/ppsspw-architecture.html" width="100%" height="520px" frameborder="0" style="display: block; border: none;" allowfullscreen loading="lazy"></iframe>
</div>

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
