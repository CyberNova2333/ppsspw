# 工程决策与调查迁移

本页记录构建开关取舍、关键稳定性修复结论，以及原仓库根目录技术专题整合迁移后的留档说明，便于维护者理解“为什么当前默认配置写成这样”。

## 关键架构与编译决策（ADR 摘要）

| 决策项 | 当前选择 | 放弃方案与核心原因 | 源码依据 |
| --- | --- | --- | --- |
| ThinLTO 编译开关 | `WASM_ENABLE_LTO=OFF` | 开启 LTO 后多线程 WebGL2 着色器初始化阶段偶发卡死与构建回归 | `deps/ppsspp-wasm/CMakeLists.txt` |
| 主循环定时节拍 | `requestAnimationFrame`（`WASM_MAIN_LOOP_FPS=60`） | 固定 16 ms 浏览器定时器会与显示刷新率错拍并在 CI 启动期引发假死调查问题 | `deps/ppsspp-wasm/CMakeLists.txt`、SDL 主循环 |
| 浏览器内存分配器 | `USE_NO_MMAP=ON` + `mimalloc` | 浏览器 WASM 线性堆无真实内核 `mmap` 映射语义，强依赖 `mmap` 会触发 `MemArena` 异常 | `deps/ppsspp-wasm/CMakeLists.txt`、`wasm-page/tests/no-mmap-arena.cpp` |
| 本地镜像挂载策略 | MEMFS 零字节存根 + `BrowserFileLoader` 8 MiB 窗口 | 直接读入整盘 ISO 会突破 32 位地址空间上限；主线程同步等读会死锁，因此 `ReadAt` 在主线程返回 `0` | `wasm-page/public/browser-files.js`、`BrowserFileLoader.cpp` |
| 即时存档解压 | 1 MiB 分块流式 ZSTD 输入 | 一次性解压大体积即时存档容易造成瞬时内存尖峰失败 | `UPSTREAM.md`、`wasm-page/tests/state-zstd-input.cpp` |
| 线上发行面板范围 | `LOCAL_ONLY = true` 隐藏 `tabNetwork`/`tabDrive` | 在未部署配套公网中继或云驱后端前，避免向玩家暴露失效入口，同时保留服务端栈测试 | `wasm-page/public/ppsspp-runtime.js:31`、`app.html` |
| 发布诊断开关门禁 | 默认禁止 `WASM_FRAME_TIMING` 与 `WASM_IR_BLOCK_PROFILE` | 防止调试探针以未受控的性能损耗流入公网发布，仅在显式传 `--allow-diagnostics` 时放行 | `scripts/ci/prepare-deploy.mjs` |

## 历史专题调查结论汇总

此前仓库根目录下的 9 份独立专题文档已按“单一归口”原则拆分沉淀到本站与 `repo-docs/modules/`：

1. **音频泵间隔由本地对照收敛至 `8 ms`**：早期比较过 `2 ms` 与 `8 ms` 轮询检查开销；借助 `AudioWorklet` 侧 `>= 70 ms` 硬件时钟前瞻门控，`8 ms` 定时检查既不额外产生重复音频，又降低了主线程定时器唤醒频率（实装在 `wasm-page/public/ppsspp-runtime.js:4144`）。
2. **CI 启动卡死与重度 3D 场景排查方法沉淀**：《战神》性能排查与 CI 游戏启动调查已提炼出可重复使用的无头浏览器分析链（`scripts/profile-browser.mjs`、`scripts/profile-frame-timing.mjs`、`scripts/profile-ir-blocks.mjs`、`scripts/compare-browser-performance.mjs`），并将所有设备对比明确划分为“桌面浏览器真核实测”、“离线 C++ 行为夹具回归”与“受限模拟环境（如缺 3D 渲染对象时不计入有效基线）”三类口径，避免跨环境误判。
3. **中继部署工作流澄清**：旧说明中曾提及 `wasm-pages.yml` 与镜像仓产物路径；当前仓库 `.github/workflows/` 实际运行 `ci.yml`（工具链编译检验）、`deploy.yml`（EdgeOne Pages 手动部署与线上头校验）与 `docs-pages.yml`（GitHub Pages 文档站部署），而多人中继由 `deploy/relay/` 独立编排管理。

## 本地验证命令参考

修改网页运行时、下载协议或服务器头规则后，建议在提交前运行：

```sh
# 网页运行时、触控、8 MiB 读取与下载续传测试（Node.js）
pnpm --dir wasm-page test

# 预览服务独占绑定与 Manifest 生成器测试（Python）
python3 -m unittest discover -s server/player-tests -v
python3 -m unittest discover -s server/tests -v
```

> [!NOTE]
> 上述 `pnpm test` 与 `unittest` 验证 JS 逻辑、协议边界和服务器行为，不能替代激活 Emscripten SDK 后通过 `scripts/ci/build.sh` 执行的完整 WASM 编译链路或浏览器实机游戏验收。
