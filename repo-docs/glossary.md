# 术语表

| 术语 | 项目里的意思 | 延伸阅读 |
| --- | --- | --- |
| `OPFS` | 浏览器私有源文件系统（Origin Private File System），用于保存 `persist` 存档与 `game-downloads` 续传缓存，配合专用 Worker 与同步句柄规避大内存拷贝。 | [一次真实运行](walkthroughs/one-real-run.md) |
| `MEMFS` | Emscripten 内存文件系统；运行时只在 `/browser-games/` 挂载零字节镜像存根，避免把上 GB ISO 整包塞进 WASM 堆内存。 | [8 MiB 分窗读取与断点下载恢复](modules/windowed-iso-and-download.md) |
| `BrowserFileLoader` | 原生文件加载器，负责把模拟器的随机 `ReadAt` 请求经 JS 代理转发到浏览器的 `Blob` 切片缓存，并拒绝在主线程同步阻塞调用。 | [8 MiB 分窗读取与断点下载恢复](modules/windowed-iso-and-download.md) |
| `BrowserFileLoaderHasFiles` | 原生检查函数；只要存在浏览器直读文件或开启联机，`EmuThreadStart` 便会把仿真循环拆到独立 pthread 执行。 | [8 MiB 分窗读取与断点下载恢复](modules/windowed-iso-and-download.md) |
| `EmuThreadStart` / `EmuThreadFunc` | SDL 入口的仿真线程派发点，确保文件与网络读取在工作线程挂起等待而非卡死浏览器主线程。 | [8 MiB 分窗读取与断点下载恢复](modules/windowed-iso-and-download.md) |
| `CACHE_BYTES` / `BLOCK_BYTES` / `MAX_READ_BYTES` / `READ_CONCURRENCY` | `browser-files.js` 中的分窗读取上限：8 MiB LRU 窗口、256 KiB 分块粒度、1 MiB 单次读取上限及 4 路并发读。 | [8 MiB 分窗读取与断点下载恢复](modules/windowed-iso-and-download.md) |
| `ErrnoError(29)` | `MEMFS` 零字节存根文件遭遇非法 `read()` 时抛出的 `EIO` 异常，用于守卫分段直读路线不被绕过。 | [8 MiB 分窗读取与断点下载恢复](modules/windowed-iso-and-download.md) |
| `emscripten_is_main_runtime_thread` | Emscripten 运行时线程断言；`BrowserFileLoader::ReadAt` 命中主线程时直接返回 `0` 防死锁。 | [8 MiB 分窗读取与断点下载恢复](modules/windowed-iso-and-download.md) |
| `COOP` / `COEP` / `SharedArrayBuffer` / `crossOriginIsolated` | 跨源隔离响应头（`same-origin` / `require-corp`）；浏览器必须满足 `crossOriginIsolated` 才能启用 WASM pthread 与 `SharedArrayBuffer` 音频环。 | [一次真实运行](walkthroughs/one-real-run.md) |
| `createSyncAccessHandle` | Dedicated Worker 内可用的 OPFS 同步写入句柄，用于原子提交经 SHA-256 校验过的下载分块。 | [8 MiB 分窗读取与断点下载恢复](modules/windowed-iso-and-download.md) |
| `PpssppGameStorage` | 网页存储协调器，用 Web Locks 区分共享读锁与独占下载锁（`ppsspp-download-*`），防止多标签页写坏续传缓存。 | [8 MiB 分窗读取与断点下载恢复](modules/windowed-iso-and-download.md) |
| `WEB_NATIVE_TIMING_CONFIG` / `WEB_STABILITY_CONFIG` | 运行时在应用用户设置前写入的网页节拍与内存保护基线配置。 | [运行时节拍与浏览器稳定性边界](modules/runtime-perf-and-stability.md) |
| `InternalResolution` | PPSSPP 渲染内部分辨率倍率；网页默认与调优范围主要覆盖 `1x` 到 `3x`。 | [运行时节拍与浏览器稳定性边界](modules/runtime-perf-and-stability.md) |
| `AudioWorklet` / `SP-shim` / `ScriptProcessor` | 浏览器音频输出双路径；默认通过共享内存环形缓冲区与 `8 ms` 水位泵送采样（`70 ms` 前瞻），不支持环境回退至 `ScriptProcessor`。 | [运行时节拍与浏览器稳定性边界](modules/runtime-perf-and-stability.md) |
| `WASM_INITIAL_MEMORY` / `WASM_MAXIMUM_MEMORY` / `WASM_COMPUTE_THREADS` / `WASM_PTHREAD_POOL_SIZE` | CMake 构建关键资源配置：默认 512 MiB 初始堆、4 GiB 上限、2 个计算线程和自动线程池。 | [运行时节拍与浏览器稳定性边界](modules/runtime-perf-and-stability.md) |
| `WASM_ENABLE_LTO` / `WASM_MALLOC` / `USE_NO_MMAP` / `WASM_MAIN_LOOP_FPS` | 核心编译开关：默认关闭 LTO 防着色器初始化卡死、启用 `mimalloc` 与无 `mmap` 内存竞技场，主循环采用 RAF 同步。 | [运行时节拍与浏览器稳定性边界](modules/runtime-perf-and-stability.md) |
| `WASM_FRAME_TIMING` / `WASM_IR_BLOCK_PROFILE` | 帧级与 JIT IR 块性能探针编译宏；发布检查默认拦截启用了这些诊断开关的构建，除非显式传 `--allow-diagnostics`。 | [运行时节拍与浏览器稳定性边界](modules/runtime-perf-and-stability.md) |
| `canOwn` | 同步辅助标识，允许 OPFS/运行时路径直接接管缓冲区所有权而避免多余内存拷贝。 | [运行时节拍与浏览器稳定性边界](modules/runtime-perf-and-stability.md) |
| `LOCAL_ONLY` / `LOCAL_ONLY = true` | 前端总控布尔常量，当前设为 `true`，隐藏 `tabNetwork`（联机）与 `tabDrive`（云存档）UI 入口。 | [Ad Hoc 多人联机中继协议与前端开关边界](modules/adhoc-relay-protocol.md) |
| `PRO` / `PU1` / `PT1` | Ad Hoc WebSocket 中继二进制帧魔数：握手注册（`PRO`）、UDP 报文转发（`PU1`）和 TCP 虚连接转发（`PT1`）。 | [Ad Hoc 多人联机中继协议与前端开关边界](modules/adhoc-relay-protocol.md) |
| `RELAY_AUTH_MODE` / `RELAY_AUTH_MODE=keys` / `RELAY_MAX_CONNECTIONS` / `RELAY_LATENCY_MS` / `RELAY_JITTER_MS` | 中继服务运行变量：`open`/`keys` 鉴权模式（`keys` 模式要求 `psp_...` 个人密钥）、默认 512 最大连接数及网络损伤测试参数。 | [Ad Hoc 多人联机中继协议与前端开关边界](modules/adhoc-relay-protocol.md) |
| `PPSSPP_WASM_THREADED_ADHOC` / `bEnableWlan` | 控制开启局域网联机时把主循环移至独立 pthread 执行的开关条件。 | [Ad Hoc 多人联机中继协议与前端开关边界](modules/adhoc-relay-protocol.md) |
| `getSDLGamepads` / `60 ms` / `UpdateScreenDPI` / `SDL_WINDOWEVENT_SIZE_CHANGED` / `UseHorizontalTabs` | 触控与视口链路关键符号与约束：触控映射查询、`60 ms` 点按保底时长、先刷 DPI 再改显示边界及 720 阈值原生栏目切换逻辑。 | [虚拟触控手柄与多端视口适配](modules/touch-gamepad-and-viewport.md) |
| `PlayerServer` / `serve-player.py` | 仅挂载静态发布目录并注入 COOP/COEP/CORP/CSP 安全响应头的预览 HTTP 服务。 | [代码地图](code-map.md) |
