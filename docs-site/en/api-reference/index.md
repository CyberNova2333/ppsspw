---
layout: page
sidebar: false
title: API & Component Reference
description: Reference for PPSSPW BrowserFileLoader (8 MiB LRU), create-game-manifest.py, serve-player.py COOP/COEP headers, performance controls, and the Ad Hoc PRO/PU1/PT1 relay.
---

<script setup lang="ts">
import { apiSpecEn } from '../../.vitepress/data/api-spec'
</script>

<ApiExplorer :spec="apiSpecEn">

### 8 MiB Windowed ISO Proxy (`BrowserFileLoader`) {#browser-file-loader}

Mounts zero-byte MEMFS stubs (POSIX `read()` throws `EIO`) and serves 256 KiB slices via an 8 MiB LRU window exclusively on a dedicated Emscripten pthread.

### Chunked Manifest & OPFS Resumable Downloader (`create-game-manifest.py`) {#manifest-and-opfs-resume}

Validates `64 KiB–16 MiB` chunks, `<= 8 GiB` disc size, `HTTPS`, and `HTTP 206` (`identity` encoding) before flushing SHA-256-verified blocks to OPFS under Web Locks.

### 1x–3x Scaling, 8 ms AudioWorklet & Sanitized Telemetry (`performance.js`) {#runtime-perf-controls}

Supports `1x–3x` 3D scaling (does not upscale 2D sprites), an 8 ms SAB `AudioWorklet`, and title/URL-free metrics; production CI blocks diagnostic builds by default.

### COOP/COEP Preview Server & Header Gates (`serve-player.py`) {#serve-player-headers}

Serves packaged builds on `127.0.0.1:17881` with COOP/COEP/CORP isolation headers, `.wasm` streaming MIME, and TLS/CSP overrides; HTTPS is required on mobile LAN clients.

### Ad Hoc WebSocket Relay Framing (`PRO` / `PU1` / `PT1`) {#adhoc-relay-protocol}

Implements multiplayer UDP/TCP frame relaying behind `RELAY_AUTH_MODE=open|keys`; default UI sets `LOCAL_ONLY = true` (`tabNetwork` and `tabDrive` hidden/inert).

### Local SQLite Relay Credential CLI (`server/relay_admin.py`) {#relay-admin-cli}

Issues, lists, and revokes `psp_<16hex>.<43urlsafe>` tokens locally with SHA-256 storage and zero public HTTP management routes.

</ApiExplorer>
