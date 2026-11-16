---
layout: home

hero:
  name: "PPSSPW"
  text: "浏览器端 PPSSPP WebAssembly 运行时"
  tagline: "8 MiB 分窗按需读取本地镜像、OPFS 持久化存档、SHA-256 分块续传与 WebGL2 多线程核心。"
  actions:
    - theme: brand
      text: "起步与配置部署"
      link: /docs/
    - theme: alt
      text: "架构全景与交互图谱"
      link: /docs/architecture
    - theme: alt
      text: "GitHub 仓库"
      link: https://github.com/CyberNova2333/ppsspw

features:
  - title: "8 MiB 滑动窗口直读"
    details: "BrowserFileLoader 将原生 ReadAt 经跨线程代理映射到 256 KiB 分块与 8 MiB LRU 窗口，无需将 1.5 GB ISO 整体塞入 WASM 内存。"
  - title: "OPFS 断点续传与即时存档"
    details: "专用 Worker 通过 HTTP Range 206 与逐块 SHA-256 校验写入 OPFS；运行期存档通过 canOwn 所有权接管与 1 MiB ZSTD 流式解压落盘。"
  - title: "隔离头门禁与自托管栈"
    details: "内置 COOP/COEP/CORP 与 .wasm MIME 检测、EdgeOne 部署校验脚本，以及可按 open/keys 模式鉴权的 Ad Hoc WebSocket 中继栈。"
---

## 架构全景

<div class="archify-diagram-card" style="margin: 1.5rem 0; border: 1px solid var(--vp-c-border); border-radius: 12px; overflow: hidden; background: var(--vp-c-bg-soft); box-shadow: 0 4px 16px rgba(0,0,0,0.06);">
  <div style="display: flex; justify-content: space-between; align-items: center; padding: 10px 18px; background: var(--vp-c-bg-elv); border-bottom: 1px solid var(--vp-c-border); font-size: 13px;">
    <span style="font-weight: 600; color: var(--vp-c-text-1); display: flex; align-items: center; gap: 8px;">
      <span style="font-size: 16px;">📐</span> 浏览器端 PPSSPP WebAssembly 运行时架构（基于 Archify 的高保真交互图表，支持平移/缩放/探查）
    </span>
    <a href="/diagrams/ppsspw-architecture.html" target="_blank" rel="noreferrer" style="font-size: 12px; color: var(--vp-c-brand-1); text-decoration: none; font-weight: 500;">
      在新窗口全屏打开 ↗
    </a>
  </div>
  <iframe src="/diagrams/ppsspw-architecture.html" width="100%" height="520px" frameborder="0" style="display: block; border: none;" allowfullscreen loading="lazy"></iframe>
</div>

## 快速上手演示

```bash
# 1. 启动带 COOP/COEP 隔离头的本地预览服务（需已放置 ppsspw.js / ppsspw.wasm 构建产物）
python3 scripts/serve-player.py --root web/player --port 8080

# 2. 运行离线门禁测试（Manifest 校验、部署门禁与中继单元/集成测试）
python3 -m unittest discover -s tests -p "test_*.py" -v
```

## 文档分层导航

::: tip 按照读者需求快速跳转
- **第一次在本地或服务器跑起来**：阅读 [部署模式与下载清单准备](/docs/deployment) 与 [部署与运行排错 FAQ](/docs/troubleshooting)，用 `serve-player.py`、Docker Compose 或 EdgeOne 注入 COOP/COEP 并排查 `crossOriginIsolated`；
- **接入 8 MiB 读取、分块清单或性能调优**：查阅 [8 MiB 分窗、续传与中继契约](/docs/contracts) 与 [画质倍率、音频与稳定性调优](/docs/performance)，确认清单 schema、`PRO`/`PU1`/`PT1` 二进制帧与 `1x–3x` 倍率；
- **二次开发前端壳层、WASM 补丁或定位源码**：查阅 [架构全景与交互图谱](/docs/architecture)、[一次真实运行走查](/docs/walkthrough)、[代码地图](/docs/code-map) 与 [工程决策与调查迁移](/docs/decisions)。
:::
