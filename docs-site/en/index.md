---
layout: home

hero:
  name: PPSSPW Web Emulator
  text: WASM Retro Gaming
  tagline: High-performance WebAssembly and WebGL PSP emulator platform running entirely within the modern web browser.
  actions:
    - theme: brand
      text: Get Started
      link: /en/docs/
    - theme: alt
      text: Interactive Architecture
      link: /en/docs/architecture
    - theme: alt
      text: GitHub Repo
      link: https://github.com/CyberNova2333/ppsspw

features:
  - title: Near-Native WebAssembly Speed
    details: Compiled via Clang/Emscripten with optimized memory models delivering smooth 60 FPS.
  - title: WebGL 2.0 / WebAudio Pipeline
    details: Hardware-accelerated shader graphics pipeline with low-latency audio ring buffers.
  - title: Zero-Install Client-Side
    details: Runs completely client-side in browser sandboxes with drag-and-drop ISO mounting.
---

::: warning AI Translation Notice
This site and documentation have been translated by an AI language model. In case of any discrepancies or ambiguities, please refer to the [original Chinese documentation](/) as the authoritative source.
:::

## Architecture Overview

<div class="archify-diagram-card" style="margin: 1.5rem 0; border: 1px solid var(--vp-c-border); border-radius: 12px; overflow: hidden; background: var(--vp-c-bg-soft); box-shadow: 0 4px 16px rgba(0,0,0,0.06);">
  <div style="display: flex; justify-content: space-between; align-items: center; padding: 10px 18px; background: var(--vp-c-bg-elv); border-bottom: 1px solid var(--vp-c-border); font-size: 13px;">
    <span style="font-weight: 600; color: var(--vp-c-text-1); display: flex; align-items: center; gap: 8px;">
      <span style="font-size: 16px;">📐</span> PPSSPW WebAssembly Architecture Pipeline (Archify interactive diagram; pan / zoom / inspect supported)
    </span>
    <a href="/diagrams/ppsspw-architecture.html" target="_blank" rel="noreferrer" style="font-size: 12px; color: var(--vp-c-brand-1); text-decoration: none; font-weight: 500;">
      Open Fullscreen ↗
    </a>
  </div>
  <iframe src="/diagrams/ppsspw-architecture.html" width="100%" height="520px" frameborder="0" style="display: block; border: none;" allowfullscreen loading="lazy"></iframe>
</div>

## Quick Start Demo

```bash
# 1. Install project dependencies
pnpm install

# 2. Run local tests
pnpm test
```
