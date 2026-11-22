# PPSSPW 代码地图

先读[主流程的输入与交接](walkthroughs/one-real-run.md)，再按责任定位修改。本页只覆盖已声明主流程，不把目录出现过当作完整模块调查。

| 路径 | 职责 | 关键代码 | 与主流程的关系 |
| --- | --- | --- | --- |
| `wasm-page/src/` | 页面外观与游玩控件布局 | `player-controls.css / styles.css` | 由 Angular 构建配置依次载入 |
| `wasm-page/src/app/` | 页面结构、栏目与运行时脚本接线 | `app.html / ppsspp-runtime.ts` | Angular 入口调用 |
| `wasm-page/public/` | 启动、触控、浏览器文件与存档的实际运行逻辑 | `ppsspp-runtime.js / touch-controls.js` | 页面按序载入 |
| `wasm-page/tests/` | 约束启动、栏目切换、触控和存储失败行为 | `runtime.test.mjs / touch-controls.test.mjs` | wasm-page 的 test 命令 |
| `scripts/` | 把配套核心交给静态网页产物 | `scripts/package-player.py` | make pages 或显式打包命令 |
| `server/` | 静态预览服务与 WebSocket 多人中继服务 | `serve-player.py / relay.py / relay_auth.py` | 本地预览与自托管中继容器 |
| `deploy/relay/` | 多人中继容器编排与 Caddy 反代配置 | `compose.yml / Caddyfile / deploy.sh` | 自托管联机中继部署 |
| `deps/ppsspp-wasm/Core/FileLoaders/` | 浏览器分段随机读取桥接 | `BrowserFileLoader.cpp` | 原生文件加载路径经 Emscripten 代理调回 JS |
| `deps/ppsspp-wasm/SDL/` | 窗口变化时同步显示尺寸与输入比例 | `SDLMain.cpp` | 网页尺寸通知抵达原生 SDL 后处理 |
| `deps/ppsspp-wasm/UI/` | 原生设置栏目按可用宽度切换布局 | `TabbedDialogScreen.cpp / GameSettingsScreen.cpp` | 接收核心尺寸变化并重建栏目 |
| `deps/ppsspp-wasm/Common/UI/` | 栏目导航、选中可见与视图状态恢复 | `TabHolder.cpp / UIScreen.cpp` | 原生设置页共用的视图机制 |

## `wasm-page/src/`

基础页面外观与游玩控件分开维护。栏目导航、按键键帽及模拟摇杆的样式放在独立样式表，避免将视觉改动混进输入状态处理。

| 重要代码 | 功能 | 关键符号 | 调用方 / 使用方 |
| --- | --- | --- | --- |
| [游玩控件](../wasm-page/src/player-controls.css) | 手柄视觉、命中区域、栏目布局和短横屏适配 | `.touch-gamepad / .panel-navigation / #panelTabList` | 模板与触控状态类 |
| [基础样式](../wasm-page/src/styles.css) | 页面整体结构、面板与原有响应式规则 | `.stage / #sidePanel` | 页面模板 |
| [样式加载配置](../wasm-page/angular.json) | 先加载基础样式，再加载游玩控件样式 | `build.options.styles` | Angular 构建 |

相关验证：独立网页构建及浏览器布局检查；触控外观检查不代表真机操作体验已经通过。

## `wasm-page/src/app/`

页面启动与运行时脚本接线。范围仅为下表入口及主流程直接使用的契约，其余文件没有逐一审核。

| 重要代码 | 功能 | 关键符号 | 调用方 / 使用方 |
| --- | --- | --- | --- |
| [职责入口](../wasm-page/src/app/ppsspp-runtime.ts) | 页面启动与运行时脚本接线 | `PpssppRuntime.bootstrap` | Angular 入口调用 |
| [页面模板](../wasm-page/src/app/app.html) | 图标文字栏目、关联面板与屏幕手柄语义 | `panelTabList / touchGamepad` | Angular 渲染；运行时绑定事件 |

相关验证：`wasm-page/tests/runtime.test.mjs`；实际执行结果集中记在[指南变更记录](change-log.md)。

## `wasm-page/public/`

启动、浏览器文件与存档的实际运行逻辑。范围仅为下表入口及主流程直接使用的契约，其余文件没有逐一审核。

| 重要代码 | 功能 | 关键符号 | 调用方 / 使用方 |
| --- | --- | --- | --- |
| [职责入口](../wasm-page/public/ppsspp-runtime.js) | 启动、浏览器文件与存档的实际运行逻辑 | `start / loadPersistedFiles / mountBrowserGame` | 页面按序载入 |
| [本机存档](../wasm-page/public/ppsspp-runtime.js) | 跨标签页核对槽位版本，扫描成功后同步，恢复中断的备份导入 | `reserveSaveGroups / persistFilesNow / recoverSaveImport` | 游戏启动、游玩菜单、自动同步与导入 |
| [栏目导航](../wasm-page/public/ppsspp-runtime.js) | 切换选中面板、焦点和键盘导航 | `activatePanelTab / onPanelTabKeyDown` | 模板中的栏目按钮 |
| [布局与画布跟踪](../wasm-page/public/ppsspp-runtime.js) | 区分布局与可视区域，向核心通知画布尺寸变化、向手柄通知位置变化 | `syncViewportSize / installCanvasResizeTracking / ppsspp-player-layout` | 浏览器视口、全屏、画布观察器 |
| [按键预设](../wasm-page/public/pad-presets.js) | 预设草稿、位置与大小、持久化和编辑器预览 | `mount / replaceLayout` | 设置面板与全屏游玩菜单 |
| [屏幕手柄](../wasm-page/public/touch-controls.js) | 每指针输入、方向拖动、摇杆死区与安全释放 | `createState / mount / dpadButtons / stickAxes` | 运行时输入桥采样 |
| [8 MiB 分窗读取](../wasm-page/public/browser-files.js) | 256 KiB 分块调度、8 MiB LRU 窗口与零字节存根兜底 | `CACHE_BYTES / BLOCK_BYTES / READ_CONCURRENCY` | 原生 `BrowserFileLoader` 跨线程代理 |
| [在线清单与续传](../wasm-page/public/game-download.js) | 分块 HTTP Range 校验、按块刷盘的续传进度，以及与页面共享的缓存锁和目录 | `download-worker.js / online-games.js` | 在线清单安装与续传任务 |
| [运行时性能采样](../wasm-page/public/performance.js) | 读取帧边界快照并导出脱敏采样 JSON | `start / exportReport` | 面板诊断开关与离线比对脚本 |
| [Ad Hoc 中继传输](../wasm-page/public/adhoc-transport.js) | `PRO`/`PU1`/`PT1` WebSocket 联机二进制封装（当前受 `LOCAL_ONLY = true` 隐藏） | `connect / sendPacket` | 联机开启时的原生网口桥 |

相关验证：`wasm-page/tests/runtime.test.mjs`、`wasm-page/tests/orientation.test.mjs`、`wasm-page/tests/touch-controls.test.mjs`；模拟器核心仍需单独验收。

## `wasm-page/tests/`

约束启动能力和存储失败行为。范围仅为下表入口及主流程直接使用的契约，其余文件没有逐一审核。

| 重要代码 | 功能 | 关键符号 | 调用方 / 使用方 |
| --- | --- | --- | --- |
| [职责入口](../wasm-page/tests/runtime.test.mjs) | 约束启动能力和存储失败行为 | `partial core / storage maintenance 用例` | wasm-page 的 test 命令 |
| [触控回归](../wasm-page/tests/touch-controls.test.mjs) | 多指并按、短按、方向换向、摇杆落点与失焦释放 | `mounted controls / mounted stick 用例` | wasm-page 的 test 命令 |
| [原生窗口尺寸夹具](../wasm-page/tests/sdl-viewport.cpp) | 为真实生产分支提供窗口数据与断言 | `production-resize.inc / main` | 独立 Python 编译脚本，不属于 pnpm test |
| [栏目模式夹具](../wasm-page/tests/tabbed-layout.cpp) | 检查宽度边界、平台分支与跨模式重建请求 | `production-tabbed-layout.inc / main` | 独立 Python 编译脚本；视图重建为替身 |

相关验证入口：`wasm-page/package.json`。DOM 替身中的输入断言不替代浏览器命中测试或游戏内响应。

## `scripts/`

把配套核心交给静态网页产物。范围仅为下表入口及主流程直接使用的契约，其余文件没有逐一审核。

| 重要代码 | 功能 | 关键符号 | 调用方 / 使用方 |
| --- | --- | --- | --- |
| [职责入口](../scripts/package-player.py) | 校验配套核心、拒绝诊断包并复制五份许可文本 | `main / diagnostic_metadata / read_required_licenses` | make pages 或显式打包命令 |
| [窗口尺寸回归入口](../scripts/test-sdl-viewport.py) | 从当前生产源码提取函数和 resize 分支，编译并执行小型 Wasm 测试 | `body / main` | 显式运行；需要 Emscripten SDK 与 Node.js |
| [栏目模式回归入口](../scripts/test-tabbed-layout.py) | 提取真实布局决策和尺寸回调，分别验证网页与非网页分支 | `main / UseHorizontalTabs / resized` | 显式运行；需要 Emscripten SDK 与 Node.js |
| [构建验证顺序](../scripts/ci/build.sh) | 调用共用回归入口，再编译核心并打包网页 | `make test-ci / make wasm-release / make app-build-pages` | 构建任务入口；改动脚本不代表任务已执行 |
| [清单生成工具](../scripts/create-game-manifest.py) | 按 64 KiB–16 MiB 切分镜像并计算每块 SHA-256 与 HTTPS 源约束 | `main / schemaVersion` | 部署在线分块镜像前的离线准备 |
| [发布前门禁](../scripts/ci/prepare-deploy.mjs) | 检查随包许可、写入隔离响应头配置并核对部署标识 | `verifyLicenses / prepareDeployment / verifyStaticOutput` | EdgeOne 部署准备与校验步骤 |

打包边界的验证入口为 `server/player-tests/`；窗口尺寸分支由独立编译脚本执行，结果分别记录，不能互相替代。

## `server/`

只暴露打包目录并设置线程所需响应头。范围仅为下表入口及主流程直接使用的契约，其余文件没有逐一审核。

| 重要代码 | 功能 | 关键符号 | 调用方 / 使用方 |
| --- | --- | --- | --- |
| [职责入口](../server/serve-player.py) | 只暴露打包目录并设置线程所需响应头 | `PlayerServer / PlayerHandler / main` | 打包后的人工预览 |
| [Ad Hoc 中继核心](../server/relay.py) | 处理 `PRO`/`PU1`/`PT1` 二进制帧分发、连接上限与网络损伤参数 | `RELAY_MAX_CONNECTIONS / RELAY_LATENCY_MS` | 自托管联机中继容器与中继单测 |
| [中继鉴权与命令行管理](../server/relay_auth.py) | 管理 `open`/`keys` 鉴权模式与本地 SQLite 哈希密钥签发吊销 | `KeyStore / RelayAuth / relay_admin.py` | 中继服务握手鉴权与运维 CLI |

相关验证：`server/player-tests/`。本轮只检查可读证据，业务测试没有执行。

## `deps/ppsspp-wasm/SDL/`

网页端在此处理原生窗口尺寸、输入坐标和针对当前游戏的即时存读档请求。

| 重要代码 | 功能 | 关键符号 | 调用方 / 使用方 |
| --- | --- | --- | --- |
| [窗口事件与 DPI](../deps/ppsspp-wasm/SDL/SDLMain.cpp) | 尺寸变化时先更新 DPI，再更新显示边界，拒绝无效尺寸 | `UpdateScreenDPI / SDL_WINDOWEVENT_SIZE_CHANGED` | SDL 事件循环、原生显示与输入换算 |
| [网页即时存档](../deps/ppsspp-wasm/SDL/WasmStateSlots.cpp) | 在模拟器线程核对当前游戏与槽位，把原生存读档完成结果送回网页 | `ppssppWebStateSlot / SaveState::SaveSlot / SaveState::LoadSlot` | 游玩菜单的槽位选择与本机持久化 |

相关验证：`python scripts/test-sdl-viewport.py` 检查真实分支，但 SDL 调用为替身；还需完整重建并加载新核心，才能验证浏览器原生触点。

## `deps/ppsspp-wasm/UI/`

这里只追踪设置栏目在窗口收窄、展开时的布局与状态交接，不展开全部原生界面组件。

| 重要代码 | 功能 | 关键符号 | 调用方 / 使用方 |
| --- | --- | --- | --- |
| [栏目布局决策](../deps/ppsspp-wasm/UI/TabbedDialogScreen.cpp) | 网页核心按有效宽度切换栏目方向，安全重建搜索与初始选中项 | `UseHorizontalTabs / resized / CreateViews / ApplySearchFilter` | 核心窗口尺寸回调、各设置页 |
| [游戏设置栏目](../deps/ppsspp-wasm/UI/GameSettingsScreen.cpp) | 网页核心使用横向图标文字标签 | `GameSettingsScreen / HorizontalShowIcons` | 设置入口 |

相关验证：`python scripts/test-tabbed-layout.py` 执行真实模式决策与尺寸回调，视图重建使用替身；栏目点击和搜索生命周期仍需加载完整核心后验证。

## `deps/ppsspp-wasm/Common/UI/`

栏目切换与界面重建共用下列视图机制；这里仅追踪设置页直接依赖的入口。

| 重要代码 | 功能 | 关键符号 | 调用方 / 使用方 |
| --- | --- | --- | --- |
| [栏目容器](../deps/ppsspp-wasm/Common/UI/TabHolder.cpp) | 测量图标文字标签、恢复选中栏目，并在布局变化后将选中标签滚入视野 | `IconLabelTabChoice / Layout / SetInitialTab / PersistData` | 分栏设置页 |
| [视图状态交接](../deps/ppsspp-wasm/Common/UI/UIScreen.cpp) | 重建前后保存、恢复栏目内容滚动与焦点 | `DoRecreateViews / PersistData` | 原生视图重建 |

验证需在完整核心中检查栏目选中、手动导航、滚动与焦点恢复；实际已执行的项目及设备边界见[指南变更记录](change-log.md)。

## `deploy/relay/`

自托管 Ad Hoc 中继容器编排与 TLS 反代配置；独立于静态玩家前端与 GitHub Pages 文档站点部署。

| 重要代码 | 功能 | 关键符号 | 调用方 / 使用方 |
| --- | --- | --- | --- |
| [中继编排入口](../deploy/relay/compose.yml) | 拉起 `relay.py` 服务、挂载 `/data` SQLite 卷并传递环境开关 | `RELAY_AUTH_MODE / RELAY_AUTH_DB` | 自托管联机运维容器 |
| [反向代理与部署脚本](../deploy/relay/Caddyfile) | 暴露 `/healthz` 与 `/adhoc` WebSocket 入口；配合 `deploy.sh` 部署 | `/healthz / /adhoc` | 中继公网 HTTPS 入口 |

## `deps/ppsspp-wasm/Core/FileLoaders/`

仅追踪浏览器随机读盘边界，`deps/` 其余格式解码与通用文件系统不作逐层展开。

| 重要代码 | 功能 | 关键符号 | 调用方 / 使用方 |
| --- | --- | --- | --- |
| [浏览器文件加载器](../deps/ppsspp-wasm/Core/FileLoaders/BrowserFileLoader.cpp) | 把原生 `ReadAt` 转发至 Emscripten 异步代理并拒绝主线程阻塞调用 | `ReadAt / emscripten_is_main_runtime_thread` | 仿真线程读盘与 [8 MiB 分窗模块](modules/windowed-iso-and-download.md) |

## 覆盖范围

本地图覆盖 Angular 壳层、浏览器运行时、触控视口、8 MiB 分窗读盘与分块下载、性能采样、预览打包以及 Ad Hoc 中继服务；按模块细读机制请转到[模块目录](modules/windowed-iso-and-download.md)。PPSSPP 内部 CPU JIT、FFmpeg 与未点名的 `deps/` 子目录未作逐层拆解。

生成物、依赖安装目录、临时日志及第三方供应商源码不作为本次第一方模块地图。修改范围外机制前应重新调查，不能从本页推断兼容性。

证据状态：除特别标注外，本页基于当前源码已确认。
