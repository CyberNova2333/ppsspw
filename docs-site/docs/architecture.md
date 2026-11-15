# 架构全景与交互图谱

PPSSPW 将“上游 PPSSPP WASM 源码树”、“前端 Angular 运行时界面”和“独立工具与中继服务”收拢在一个静态可分发的双层工作区中。前端只通过固定脚本边界、OPFS 目录和 `BrowserFileLoader` 与核心耦合。

<div class="archify-diagram-card" style="margin: 1.5rem 0; border: 1px solid var(--vp-c-border); border-radius: 12px; overflow: hidden; background: var(--vp-c-bg-soft); box-shadow: 0 4px 16px rgba(0,0,0,0.06);">
  <div style="display: flex; justify-content: space-between; align-items: center; padding: 10px 18px; background: var(--vp-c-bg-elv); border-bottom: 1px solid var(--vp-c-border); font-size: 13px;">
    <span style="font-weight: 600; color: var(--vp-c-text-1); display: flex; align-items: center; gap: 8px;">
      <span style="font-size: 16px;">📐</span> 模拟器前端与 WASM 调度架构（基于 Archify 的高保真交互图表，支持平移/缩放/探查）
    </span>
    <a href="/diagrams/ppsspw-architecture.html" target="_blank" rel="noreferrer" style="font-size: 12px; color: var(--vp-c-brand-1); text-decoration: none; font-weight: 500;">
      在新窗口全屏打开 ↗
    </a>
  </div>
  <iframe src="/diagrams/ppsspw-architecture.html" width="100%" height="520px" frameborder="0" style="display: block; border: none;" allowfullscreen loading="lazy"></iframe>
</div>

## 四层结构与职责边界

1. **前端 Angular 壳层（`wasm-page/src/`）**：`app.ts` 与 `app.html` 渲染控制面板（8 个活跃页签与 `.legacy-integrations` 隐藏占位）、画布与触控容器；`ppsspp-runtime.ts` 在浏览器端按严格依赖顺序动态载入 6 个核心 public 脚本。
2. **浏览器运行时与 Worker 层（`wasm-page/public/`）**：
   - `ppsspp-runtime.js`：能力预检（`crossOriginIsolated`、WebGL2）、核心清单挑选、`WEB_NATIVE_TIMING_CONFIG` 注入、OPFS 自动持久化与 `8 ms` 音频泵；
   - `browser-files.js` 与 `game-download.js` / `download-worker.js`：管理本地 8 MiB 分窗读取与在线 `Range 206` 断点下载；
   - `touch-controls.js`：实现多点并发状态、`60 ms` 最短轻触保底、动态摇杆零点以及视口重置时 `cancelAll()` 防卡键；
   - `sw.js`（`ppsspp-player-v16`）：为常规静态响应补齐隔离响应头，并显式跳过 `Range` 与 `no-store` 请求。
3. **WASM 核心与最小补丁层（`deps/ppsspp-wasm/`）**：基于上游锁定版本（见仓库根 `UPSTREAM.md` 与 `upstream/source-lock.json`），仅在三处关键边界做浏览器适配：
   - `Core/FileLoaders/BrowserFileLoader.cpp`：实现跨线程 `ReadAt` 并阻止主线程阻塞调用；
   - `SDL/SDLMain.cpp`：控制 `EmuThreadStart` pthread 派发及尺寸变化时“先刷新 DPI 再更新显示边界”的顺序；
   - `UI/TabbedDialogScreen.cpp` & `Common/UI/TabHolder.cpp`：以核心逻辑宽度 `720` 为阈值切换横向顶部栏与竖向侧栏。
4. **工程交付与外部服务层（`scripts/`、`server/`、`deploy/relay/`）**：负责构建编译、发布前诊断开关拦截、COOP/COEP 预览服以及自托管 Ad Hoc WebSocket 中继栈。

## 源码深潜入口（关联 `repo-docs/` 活文档）

- [一次真实运行走查（从点击运行到核心启动与失败边界）](/docs/walkthrough)：顺着真实启动请求跟踪 Angular -> JS 运行时 -> WASM pthread -> 预览服务的全部交接点与回归命令；
- [核心代码地图（按目录与符号定位改动入口）](/docs/code-map)：按 `wasm-page/`、`scripts/`、`server/`、`deploy/relay/` 与 `deps/ppsspp-wasm/` 精确检索对应源码文件与校验方法；
- 仓库 `repo-docs/modules/` 目录下另提供 4 篇源码级机制文档与 `repo-docs/glossary.md`、`repo-docs/references/source-evidence.md` 审计台账。
