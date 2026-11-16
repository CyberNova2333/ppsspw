---
layout: page
sidebar: false
title: API 与组件参考
description: PPSSPW 的 BrowserFileLoader 8 MiB 分窗 proxy、分块清单 create-game-manifest.py、COOP/COEP serve-player.py 与 PRO/PU1/PT1 中继参考。
---

<script setup lang="ts">
import { apiSpecZh } from '../.vitepress/data/api-spec'
</script>

<ApiExplorer :spec="apiSpecZh">

### 8 MiB 滑动窗口与跨线程读盘代理 (`BrowserFileLoader`) {#browser-file-loader}

仅在 MEMFS 挂零字节只读存根 `/browser-games/<name>`（`read()` 抛 `EIO`），通过 `256 KiB` 切片与 `8 MiB` LRU 窗口服务独立 pthread，主线程调用返回 `0`。

### 分块下载清单生成与 OPFS 断点续传 (`create-game-manifest.py`) {#manifest-and-opfs-resume}

限制 `64 KiB–16 MiB` 分块（默认 `4 MiB`）、镜像 `<= 8 GiB` 与 `HTTPS`+`HTTP 206`+`identity` 编码，通过 Web Locks 与 `createSyncAccessHandle()` 写入 OPFS。

### 渲染倍率、8 ms 音频泵与脱敏性能采样 (`performance.js`) {#runtime-perf-controls}

提供 `1x–3x` 3D 内部分辨率（不超分 2D 贴图）、`SP-shim` `16384` 帧 SAB 音频泵与不含游戏名/URL/日志的原子性能采样；CI 默认拒绝诊断核心上线。

### COOP/COEP 预览服务、打包门禁与 EdgeOne 发布 (`serve-player.py`) {#serve-player-headers}

强制返回 `COOP: same-origin`、`COEP: require-corp`、`CORP: same-origin` 与 `application/wasm`；移动真机除回环地址外必须使用 HTTPS。

### Ad Hoc WebSocket 二进制中继协议 (`PRO` / `PU1` / `PT1`) {#adhoc-relay-protocol}

实现联机握手与 UDP/TCP 帧转发及 `open`/`keys` 鉴权；注意默认发布版 `LOCAL_ONLY = true` 隐藏了前端联机与云盘入口。

### 本地 SQLite 中继密钥签发与吊销 (`server/relay_admin.py`) {#relay-admin-cli}

提供无公网 HTTP 接口的 `issue`、`list` 与 `revoke` 命令行管理，仅存储 SHA-256 摘要。

</ApiExplorer>
