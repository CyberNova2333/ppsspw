# 运行时节拍、音频泵与浏览器稳定性边界

网页端把原生的文件读取、音频播放与 WebGL 渲染放进单页进程与多个 pthread 之间，任何阻塞主线程或打破时钟节拍的配置都会立刻表现为爆音、掉速或启动卡死。这一模块集中管理构建内存参数、帧节拍默认配置、AudioWorklet 泵、OPFS 所有权接管以及性能诊断边界。

## 网页帧节拍与核心构建默认值

`deps/ppsspp-wasm/CMakeLists.txt` 固定了面向浏览器多线程运行的一组基础约束：初始内存 `512 MiB`（`WASM_INITIAL_MEMORY=536870912`）、上限 `4 GiB`（`WASM_MAXIMUM_MEMORY=4294967296`）、`2` 个计算线程（`WASM_COMPUTE_THREADS=2`）、`WASM_PTHREAD_POOL_SIZE=auto`，并启用 `WASM_MALLOC=mimalloc` 与 `USE_NO_MMAP=ON`（`MemArena` 不在浏览器依赖原生 `mmap`）。同时 `WASM_ENABLE_LTO` 默认保持 `OFF`，因为历史实测 ThinLTO 与浏览器端 WebGL 多线程着色器初始化冲突，容易在游戏进场前卡死。

前端启动核心前，会在用户配置之前写入一组网页基线配置（`WEB_NATIVE_TIMING_CONFIG` 与 `WEB_STABILITY_CONFIG`），然后再把用户在设置面板勾选的 `1x`–`3x` 渲染倍率（`InternalResolution`）叠加生效：

```js
// wasm-page/public/ppsspp-runtime.js
const WEB_NATIVE_TIMING_CONFIG = [
  ["General", "ForceLagSync2", "True"],
  ["Graphics", "DisplayRefreshRate", "60"],
  ["Graphics", "FrameSkip", "0"],
  ["Graphics", "VerticalSync", "True"],
  ["Sound", "AudioBufferSize", "1024"],
  ["Sound", "FillAudioGaps", "True"],
];
```

- **正常与调试边界**：
  - **生产基线**：主循环使用浏览器 `requestAnimationFrame` 节拍（`WASM_MAIN_LOOP_FPS` 目标 60 Hz，避免固定 16 ms 定时器与 RAF 错拍导致的启动期掉帧和卡死），并且禁止开启编译期分析开关 `WASM_FRAME_TIMING` 与 `WASM_IR_BLOCK_PROFILE`。
  - **诊断拒绝门禁**：`scripts/ci/prepare-deploy.mjs` 在发布前会校验静态产物与构建配置；若发现诊断开关未关闭且未显式传入 `--allow-diagnostics`，发布准备直接报错终止，防止高开销探针进入生产站点。

## AudioWorklet 音频泵与时钟门控

浏览器主线程和音频线程之间的桥接由 `wasm-page/public/ppsspp-runtime.js` 维护。在支持 `crossOriginIsolated` 与 `SharedArrayBuffer` 的环境中，音频经 `16384` 帧共享环形缓冲区进入 `AudioWorklet`（`SP-shim`，工作线程仅通过原子游标交互、不在音频线程派发未监听的状态消息），由 `setInterval(pump, 8)` 每 `8 ms` 检查一次时钟游标与缓冲区水位，只有当待消费音频不足 `>=70 ms` 前瞻窗口时才继续推入采样；当缓冲区因主线程停顿出现欠载（underrun）时，自适应补偿按当次欠载突发量快速拉高预缓冲上限（最高额外 `180 ms`），并在 8 秒无欠载后逐步回落，桌面无欠载场景保持原 `70 ms` 低延迟。若运行环境退化或关闭 Worklet 路径，运行时自动降级到 `32768` 帧 `ScriptProcessor`（`createScriptProcessor(2048, 0, 2)`）路径以保底出声。

## OPFS 接管、离主线程分阶段提交、ZSTD 分块解压与性能采样边界

持久存档同步与即时存档读写最容易在高频阶段制造主线程停顿与 GC 尖峰。为此网页端采用三条减少拷贝与主线程阻塞的设计：在 `MEMFS` 与站点 `OPFS`（`ppsspp-web/persist`）启动恢复时启用 `canOwn` 缓冲区所有权移交与文件句柄复用；同步写盘时，在支持 `createSyncAccessHandle()` 与 `FileSystemFileHandle.move()` 的浏览器中将事务写入迁至独立工作线程 `wasm-page/public/save-worker.js`，零拷贝转移内存缓冲写入 `player/import-stage`，以单次重命名 `pending.tmp → pending.json` 确立提交点后再 O(1) 移入正式目录（跳过占旧路径 73%–79% 耗时的整份旧档拷贝，并在同事务内复用目录句柄缓存），不支持该能力的环境自动回退到 `player/import-undo` 旧副本回滚；即时存档读入则在底层改为 1 MiB 块的流式 ZSTD 解压（见 `wasm-page/tests/state-zstd-input.cpp` 与 `UPSTREAM.md`），防止大体积存档一次申请过多线性内存。

性能分析由 `wasm-page/public/performance.js` 协同完成：核心在仿真帧边界发出只读原子快照，网页端按真实时间归一化计算主机帧率、仿真速度、启动阶段耗时、ISO 读取延迟与音频欠载次数，并支持导出有界采样 JSON（自动剥离游戏名称、原始网址与完整运行日志）。对于《战神》等高负载 3D 游戏或重编译阶段瓶颈，仓库提供了独立离线与无头采样脚本 `scripts/profile-browser.mjs`、`scripts/profile-frame-timing.mjs`、`scripts/profile-ir-blocks.mjs` 与 `scripts/compare-browser-performance.mjs`；需明确区分桌面浏览器与 Android 模拟环境采样结果（例如历史上 Android 模拟环境缺少 3D 物体渲染，相关数据仅作异常排查记录，不计入有效性能基线）。

## 小地图正常、三维景物缺失时如何复验

PSP 允许用负的视口深度缩放来反转远近顺序。旧核心会把这组数值直接交给 WebGL，近端值大于远端值时，浏览器返回 `INVALID_OPERATION`。在已复现的地图中，小地图仍会转动，但围栏、路障和地面标记消失。网页核心在 `GPU_GLES::CheckGPUFeatures()` 启用 `GPU_USE_ACCURATE_DEPTH`，通过投影保留缩放方向，交给 `depthRange` 的则是 PSP 的裁剪范围。[核心实现](../../deps/ppsspp-wasm/GPU/GLES/GPU_GLES.cpp) · [视口换算](../../deps/ppsspp-wasm/GPU/Common/GPUStateUtils.cpp) · [WebGL 深度范围约束](https://registry.khronos.org/webgl/specs/latest/1.0/#VIEWPORT_DEPTH_RANGE)

自动回归使用一个独立的 PSP 小程序。它先画近处的绿块，再画远处的红块，反转视口深度，两块重叠处应保留绿色。Android Firefox 运行打包后的核心，测试从画布截图读取左右对照区与重叠区。两侧正确而重叠区颜色错误时退出码为 1，通过为 0，启动失败或找不到对照区为 2。本次桌面 Chromium 在旧核心上也显示绿色，复验旧版时应保留能重现问题的 Android 图形环境。[场景源码](../../scripts/fixtures/reversed-depth/main.c) · [截图断言](../../scripts/test-webgl-depth.py)

在宿主机准备 PSPSDK、genisoimage、uv、ADB 和 geckodriver，在专用 Android 模拟器中安装 Firefox。为旧版和修复版分别启动配套的播放器预览，使用模拟器可访问的地址。若通过 ADB 反向转发本地预览，先为每个预览端口执行一次 `adb -s "$serial" reverse "tcp:$port" "tcp:$port"`。从仓库根目录构建一次测试镜像，对两个预览分别运行最后一条命令，使用同一份镜像。

```sh
fixture_src="$PWD/scripts/fixtures/reversed-depth"
fixture_out="$(mktemp -d)"
make -C "$fixture_out" -f "$fixture_src/Makefile" VPATH="$fixture_src" reversed-depth.iso
uv run --script scripts/test-webgl-depth.py "$player_url" "$fixture_out/reversed-depth.iso" \
  --android-serial "$serial" --geckodriver "$geckodriver" --screenshot "$screenshot"
```

复验时，为各版核心使用独立的站点存储，以相同网页、镜像、原始即时存档和渲染倍率进入同一机位。先观察固定景物，再用屏幕方向键转向、前进，把变化后的视角存入新槽。等本机同步完成后刷新，只重新选择游戏镜像，载入新槽并核对地标、小地图朝向和存档摘要。Android 模拟器与实体手机各自记录验收结果。

需要查看部署头信息检查或定位相关脚本位置时，请阅读[按职责定位源码](../code-map.md)或前往[8 MiB 分窗读取与断点下载恢复](windowed-iso-and-download.md)。

证据状态：除特别标注外，本页基于当前源码已确认。
