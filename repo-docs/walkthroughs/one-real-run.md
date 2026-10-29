# PPSSPW：一次真实主流程

玩家选择自己持有的游戏镜像后，网页需要先确认浏览器能力、配套核心和存档状态，才能把文件交给模拟器。本指南沿本地文件启动说明这条交接，帮助维护者区分页面能打开、核心能启动和游戏能流畅运行。

难点是网页、配套核心与存储状态必须同时就绪：文件不配套、浏览器缺少能力或存储维护互斥时，需要拒绝或延后启动，防止留下半启动状态。

下面的 case 是依据源码分支整理的代表性输入与结果，不是本轮线上观测。

| 输入或状态 | 动作与结果 |
| --- | --- |
| 选择本地镜像并启动 | 能力检查、存档恢复和核心就绪后交给模拟器 |
| 缺少 WebGL2 或共享内存 | 提示具体原因并拒绝启动 |
| 存储维护正在持有互斥租约 | 保持可重试，不写入半启动状态 |
| 核心只有 JS 而缺少 Wasm/data | 配套检查拒绝，不能混用不同构建 |

## Step 1: 网页按顺序接上运行时

打开页面后，Angular 服务只启动一次运行时加载，并按顺序装入性能、存储、文件、联机、触控和核心入口脚本。页面外观与模拟器运行由不同层负责；只构建网页不足以产生配套的模拟器核心。

[对应实现](../../wasm-page/src/app/ppsspp-runtime.ts)，定位 `PpssppRuntime.bootstrap / start / loadScript`。

## Step 2: 用户启动前核对浏览器能力

点击启动时先验证所选文件和画布，再探测 WebGL2、Wasm SIMD、跨源隔离和共享内存。缺少能力时显示具体失败原因并停止；存在条件时尝试恢复跨源隔离。页面成功加载不能替代这一检查。

[对应实现](../../wasm-page/public/ppsspp-runtime.js)，定位 `start、probeWebGLFeaturesWithPref、reloadForCrossOriginIsolation`。

## Step 3: 锁定存储并选择配套核心

通过能力检查后启动音频初始化，并取得游戏存储的共享租约，避免维护操作同时改写文件。拿不到租约会恢复可重试的启动状态；随后选择包含配套 JS、Wasm 和 data 的构建。启动计时器会报告等待超时，不把长期无响应当成功。

[对应实现](../../wasm-page/public/ppsspp-runtime.js)，定位 `PpssppGameStorage.acquireShared、selectBuildDir、startupWatchdog`。

## Step 4: 恢复存档并按需挂载镜像

运行时在核心预运行阶段恢复持久化配置与存档，再把所选文件挂到浏览器文件层。读取缓存有界，不要求先把整个镜像复制进模拟器内存。普通本地文件选择只用于本次会话；保存进游戏库与存档同步是另外的显式动作。

[对应实现](../../wasm-page/public/browser-files.js)，定位 `CACHE_BYTES；在运行时搜索 mountBrowserGame / loadPersistedFiles`。

## Step 5: 通过受限预览入口提供运行条件

打包脚本检查必需核心产物，再复制到网页产物目录；本地服务器仅提供该打包目录，并设置线程所需的 COOP/COEP 等响应头。移动设备需要受信任 HTTPS；桌面能启动不能推出手机的帧率或兼容性。

[对应实现](../../server/serve-player.py)，定位 `PlayerHandler、root；打包脚本 scripts/package-player.py`。

## 检查这条解释

```sh
npm --prefix wasm-page test
python -m unittest discover -s server/player-tests -v
```

运行时测试会提取真实 public 脚本函数并用替身验证边界；这与真实核心和真实游戏验收不同。本轮不运行核心构建、网页构建或业务测试，也不替换现有 wasm-page/dist。完整核心构建仍按根 README 的 Emscripten/Linux 或 WSL 要求执行。

理解这条交接后，用[代码地图定位下一次修改](../code-map.md)；需要反查依据时查看[源码调查与边界证据](../references/source-evidence.md)。

证据状态：除特别标注外，本页基于当前源码已确认。
