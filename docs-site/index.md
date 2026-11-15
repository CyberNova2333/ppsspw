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

features:
  - title: "8 MiB 滑动窗口直读"
    details: "BrowserFileLoader 将原生 ReadAt 经跨线程代理映射到 256 KiB 分块与 8 MiB LRU 窗口，无需将 1.5 GB ISO 整体塞入 WASM 内存。"
  - title: "OPFS 断点续传与即时存档"
    details: "专用 Worker 通过 HTTP Range 206 与逐块 SHA-256 校验写入 OPFS；运行期存档通过 canOwn 所有权接管与 1 MiB ZSTD 流式解压落盘。"
  - title: "隔离头门禁与自托管栈"
    details: "内置 COOP/COEP/CORP 与 .wasm MIME 检测、EdgeOne 部署校验脚本，以及可按 open/keys 模式鉴权的 Ad Hoc WebSocket 中继栈。"
---

## 按身份 / 目标快速入口

| 你的身份或当前目标 | 推荐先看这一页 | 你能直接完成的事 |
| --- | --- | --- |
| 第一次在本地或服务器跑起来 | [部署模式与下载清单准备](/docs/deployment) | 用 `serve-player.py`、Docker Compose 或 EdgeOne 正确注入 COOP/COEP 并打包运行 |
| 准备远程游戏清单 / 排查加载报错 | [部署与运行排错 FAQ](/docs/troubleshooting) | 检查 `crossOriginIsolated`、HTTPS/CSP、`Range 206` 与端口占用错误 |
| 接入 8 MiB 读取、分块清单或联机中继 | [8 MiB 分窗、续传与中继契约](/docs/contracts) | 确认清单 schema、`PRO`/`PU1`/`PT1` 二进制帧与 `LOCAL_ONLY = true` UI 开关现状 |
| 调优高负载游戏帧率、音频与内存 | [画质倍率、音频与稳定性调优](/docs/performance) | 配置 `1x–3x` 倍率、`8 ms` 音频泵、`WASM_FRAME_TIMING` 采样与手机对照边界 |
| 二次开发前端壳层、WASM 补丁或定位源码 | [架构全景与交互图谱](/docs/architecture) | 打开交互式架构图、顺着主链路走查和代码地图找到精准改动入口 |
| 了解关键编译开关与历史排坑结论 | [工程决策与调查迁移](/docs/decisions) | 查清 `WASM_ENABLE_LTO=OFF`、RAF 节拍、CI 卡死排查与《战神》调优结论 |
