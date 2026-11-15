# 概览与运行边界

PPSSPW 是基于上游 `ppsspp-wasm` 与 `ppsspp-web` 构建的浏览器端 PSP 模拟器包装工程。它把 Angular 运行时界面、8 MiB 本地镜像分窗读取、OPFS 持久化存档、分块下载续传、移动触控手柄与可选的多人中继服务整合在同一仓库中，并以静态 Web 产物对外分发。

## 核心能力与页面功能区

当前页面构建（资产版本 `ppsspp-player-v16`）在右侧控制面板提供 8 个可见工作区：

| 面板页签 | 职责说明 | 运行依赖 |
| --- | --- | --- |
| 游戏库（`library`） | 导入用户自持本地 `.iso`/`.cso`/`.chd` 镜像，或从在线分块清单安装游戏 | `BrowserFileLoader`、OPFS |
| 在线游戏（`online`） | 解析并校验 HTTPS 分块清单，调度断点续传下载 | `game-download.js`、Web Locks |
| 设置（`settings`） | 调整 `1x`–`3x` 渲染内部分辨率与触控/显示偏好 | `WEB_NATIVE_TIMING_CONFIG` 叠加应用 |
| 存档（`saves`） | 管理游戏原生记忆棒存档与即时存档状态 | OPFS `/ppsspp-web/persist` |
| 存储（`storage`） | 导出、清理站内缓存与未完成下载目录 | `PpssppGameStorage` |
| 信息（`info`） | 开启按需性能采样、查看主机帧率/速度与导出脱敏 JSON | `performance.js` |
| 日志（`log`） | 查看带时间戳与级别染色的最近 500 条运行时与音频输出 | 仅本地内存缓冲 |
| 关于（`about`） | 展示构建指纹、配套核心版本与许可来源 | `build-info.json` |

> [!IMPORTANT]
> **联机与云端入口现状**：在 `wasm-page/public/ppsspp-runtime.js` 第 31 行，常量 `LOCAL_ONLY = true` 默认开启。页面模板 `app.html` 中的联机页签（`tabNetwork`）和云驱动页签（`tabDrive`）已置于 `hidden` + `inert` 容器下隐藏；如需搭建联机服务，请先核对[部署模式与下载清单准备](/docs/deployment)与[契约说明](/docs/contracts)。

## 运行前提与安全边界

1. **必须启用跨源隔离**：WASM 多线程核心（Emscripten `pthreads`）及低复制 `AudioWorklet` 环形缓冲区强依赖 `SharedArrayBuffer`。站点必须在响应头同时返回 `Cross-Origin-Opener-Policy: same-origin` 与 `Cross-Origin-Embedder-Policy: require-corp`，使浏览器满足 `window.crossOriginIsolated === true`。
2. **必须运行在安全上下文**：正式浏览需要 `HTTPS`，仅本地回环地址（`localhost` / `127.0.0.1` / `[::1]`）例外；移动真机无法通过局域网明文 HTTP 使用 OPFS 同步写入与 `SharedArrayBuffer`。
3. **不包含游戏内容与 BIOS 版权**：本仓库、CI 构建流水线以及已发布静态页面均**不内置任何游戏镜像、下载清单地址或私有凭据**；玩家与自托管站点需自行准备合法持有的游戏文件或合规模板清单。
4. **必须保证浏览器与核心配套同源版本一致**：运行前前端会检查核心清单与必需二进制文件，缺件或混用版本会被启动看门狗（`startupWatchdog`）拦截，避免半残状态进入仿真主循环。

下一步：根据你的部署场景选择[本地预览、Docker、EdgeOne 发布与下载清单准备](/docs/deployment)。
