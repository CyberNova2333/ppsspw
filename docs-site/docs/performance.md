# 画质倍率、音频与稳定性调优

浏览器的内存模型、渲染驱动和音频回调周期与原生桌面端显著不同。本页说明 PPSSPW 默认写入的运行时节拍配置、音频环形泵工作方式、画质倍率调节范围，以及脱敏性能采样与排查脚本的使用边界。

## 默认构建与启动节拍基线

`deps/ppsspp-wasm/CMakeLists.txt` 与前端运行时在启动前共同锁死了一组浏览器稳定性默认值：

| 配置项 | 默认值 | 作用说明 |
| --- | --- | --- |
| `WASM_INITIAL_MEMORY` / `WASM_MAXIMUM_MEMORY` | `512 MiB` / `4 GiB` | 平衡首次初始化速度与大游戏线性寻址空间 |
| `WASM_COMPUTE_THREADS` / `WASM_PTHREAD_POOL_SIZE` | `2` / `auto` | 预分配核心与文件/着色器工作线程池 |
| `WASM_MALLOC` / `USE_NO_MMAP` | `mimalloc` / `ON` | 避开浏览器缺失原生 `mmap` 的内存分配回退 |
| `WASM_ENABLE_LTO` | `OFF` | 关闭 ThinLTO 以防多线程 WebGL2 着色器阶段卡死 |
| `WASM_MAIN_LOOP_FPS` | `60`（RAF 同步） | 跟随浏览器 `requestAnimationFrame`，避免固定定时器错拍 |

启动游戏核心前，`wasm-page/public/ppsspp-runtime.js` 会先应用 `WEB_NATIVE_TIMING_CONFIG`（强制 `ForceLagSync2=True`、`DisplayRefreshRate=60`、`FrameSkip=0`、`VerticalSync=True`、`AudioBufferSize=1024`、`FillAudioGaps=True`）和 `WEB_STABILITY_CONFIG`（`IgnoreBadMemAccess=True`、`FastMemoryAccess=True`），之后再应用用户在「设置」页选择的 `1x`–`3x` 渲染内部分辨率（`InternalResolution`）与显示配置。

## 音频泵、OPFS 所有权接管与即时存档

1. **8 ms 时钟门控音频泵**：在 `crossOriginIsolated` 就绪的环境中，运行时通过 `AudioWorklet`（`SP-shim`）建立 `16384` 帧的 `SharedArrayBuffer` 环形缓冲。主线程以 `setInterval(pump, 8)` 每 `8 ms` 校验一次硬件时钟游标与缓冲区水位，只有当待播放采样低于 `>= 70 ms` 前瞻窗口时才补入新帧；发生欠载时自适应扩展预留窗口并在稳定 3 秒后回落。不满足隔离条件时自动退回 `32768` 帧 `ScriptProcessor` 路径。
2. **OPFS 持久化与 `canOwn` 零多余拷贝**：运行期存档每 30 秒（`PERSIST_SYNC_MS`）自动同步至站点 `OPFS`（`ppsspp-web/persist`），并支持文件句柄复用与 `canOwn` 缓冲区所有权移交，减小大体积存档同步引起的主线程 GC 卡顿。
3. **1 MiB 分块 ZSTD 即时存档**：底层对即时存档的 ZSTD 读取改为按 `1 MiB` 分块流式解压（见 `UPSTREAM.md` 与 `wasm-page/tests/state-zstd-input.cpp`），避免读档瞬间申请大块线性内存导致分配失败。

## 性能采样、高负载调优与证据边界

网页「信息（`info`）」面板由 `wasm-page/public/performance.js` 驱动，可在仿真帧边界读取只读原子快照，按真实时间计算主机帧率、仿真速度、启动阶段耗时、ISO 读取延迟及音频欠载次数，并导出**不包含游戏名称、访问网址或运行日志**的性能 JSON。

针对《战神》等高绘制开销 3D 游戏或重编译阶段瓶颈，可结合自身设备性能按顺序排查：
- 在面板将 `InternalResolution` 从 `3x`/`2x` 降回 `1x` 以缓解片元着色与显存带宽压力；
- 利用原生设置中的骨骼蒙皮、曲线精度与顶点缓存选项降低每帧 draw call 与顶点提交开销；
- 在开发机需要定位热路径时，才按需运行离线性能分析脚本：
  - `scripts/profile-browser.mjs`：无头浏览器场景采样
  - `scripts/profile-frame-timing.mjs`：帧耗时拆解（需 `WASM_FRAME_TIMING`）
  - `scripts/profile-ir-blocks.mjs`：JIT IR 块热点分析（需 `WASM_IR_BLOCK_PROFILE`）
  - `scripts/compare-browser-performance.mjs`：跨构建基线对比

> [!NOTE]
> **采样适用边界**：`scripts/ci/prepare-deploy.mjs` 默认拒绝开启 `WASM_FRAME_TIMING` 或 `WASM_IR_BLOCK_PROFILE` 的诊断版核心上线，避免探针开销污染线上表现；同时 Android 模拟环境等受限渲染器下（如历史排查中出现 3D 物体缺失）测得的数值仅作问题诊断，**不计入有效桌面或真机性能基线**。
