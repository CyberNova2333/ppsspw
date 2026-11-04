# PPSSPW 代码地图

先读[主流程的输入与交接](walkthroughs/one-real-run.md)，再按责任定位修改。本页只覆盖已声明主流程，不把目录出现过当作完整模块调查。

| 路径 | 职责 | 关键代码 | 与主流程的关系 |
| --- | --- | --- | --- |
| `wasm-page/src/` | 页面外观与游玩控件布局 | `player-controls.css / styles.css` | 由 Angular 构建配置依次载入 |
| `wasm-page/src/app/` | 页面结构、栏目与运行时脚本接线 | `app.html / ppsspp-runtime.ts` | Angular 入口调用 |
| `wasm-page/public/` | 启动、触控、浏览器文件与存档的实际运行逻辑 | `ppsspp-runtime.js / touch-controls.js` | 页面按序载入 |
| `wasm-page/tests/` | 约束启动、栏目切换、触控和存储失败行为 | `runtime.test.mjs / touch-controls.test.mjs` | wasm-page 的 test 命令 |
| `scripts/` | 把配套核心交给静态网页产物 | `scripts/package-player.py` | make pages 或显式打包命令 |
| `server/` | 只暴露打包目录并设置线程所需响应头 | `server/serve-player.py` | 打包后的人工预览 |
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
| [栏目导航](../wasm-page/public/ppsspp-runtime.js) | 切换选中面板、焦点和键盘导航 | `activatePanelTab / onPanelTabKeyDown` | 模板中的栏目按钮 |
| [布局与画布跟踪](../wasm-page/public/ppsspp-runtime.js) | 区分布局与可视区域，向核心通知画布尺寸变化、向手柄通知位置变化 | `syncViewportSize / installCanvasResizeTracking / ppsspp-player-layout` | 浏览器视口、全屏、画布观察器 |
| [屏幕手柄](../wasm-page/public/touch-controls.js) | 每指针输入、方向拖动、摇杆死区与安全释放 | `createState / mount / dpadButtons / stickAxes` | 运行时输入桥采样 |

相关验证：`wasm-page/tests/runtime.test.mjs`、`wasm-page/tests/orientation.test.mjs`、`wasm-page/tests/touch-controls.test.mjs`；模拟器核心仍需单独验收。

## `wasm-page/tests/`

约束启动能力和存储失败行为。范围仅为下表入口及主流程直接使用的契约，其余文件没有逐一审核。

| 重要代码 | 功能 | 关键符号 | 调用方 / 使用方 |
| --- | --- | --- | --- |
| [职责入口](../wasm-page/tests/runtime.test.mjs) | 约束启动能力和存储失败行为 | `partial core / storage maintenance 用例` | wasm-page 的 test 命令 |
| [触控回归](../wasm-page/tests/touch-controls.test.mjs) | 多指并按、短按、方向换向、摇杆落点与失焦释放 | `mounted controls / mounted stick 用例` | wasm-page 的 test 命令 |
| [原生窗口尺寸夹具](../wasm-page/tests/sdl-viewport.cpp) | 为真实生产分支提供窗口数据与断言 | `production-resize.inc / main` | 独立 Python 编译脚本，不属于 npm test |
| [栏目模式夹具](../wasm-page/tests/tabbed-layout.cpp) | 检查宽度边界、平台分支与跨模式重建请求 | `production-tabbed-layout.inc / main` | 独立 Python 编译脚本；视图重建为替身 |

相关验证入口：`wasm-page/package.json`。DOM 替身中的输入断言不替代浏览器命中测试或游戏内响应。

## `scripts/`

把配套核心交给静态网页产物。范围仅为下表入口及主流程直接使用的契约，其余文件没有逐一审核。

| 重要代码 | 功能 | 关键符号 | 调用方 / 使用方 |
| --- | --- | --- | --- |
| [职责入口](../scripts/package-player.py) | 把配套核心交给静态网页产物 | `main / diagnostic_metadata` | make pages 或显式打包命令 |
| [窗口尺寸回归入口](../scripts/test-sdl-viewport.py) | 从当前生产源码提取函数和 resize 分支，编译并执行小型 Wasm 测试 | `body / main` | 显式运行；需要 Emscripten SDK 与 Node.js |
| [栏目模式回归入口](../scripts/test-tabbed-layout.py) | 提取真实布局决策和尺寸回调，分别验证网页与非网页分支 | `main / UseHorizontalTabs / resized` | 显式运行；需要 Emscripten SDK 与 Node.js |
| [构建验证顺序](../scripts/ci/build.sh) | 完整核心构建前先执行窗口尺寸和栏目模式回归 | `test-sdl-viewport.py / test-tabbed-layout.py / make wasm-release` | 构建任务入口；改动脚本不代表任务已执行 |

打包边界的验证入口为 `server/player-tests/`；窗口尺寸分支由独立编译脚本执行，结果分别记录，不能互相替代。

## `server/`

只暴露打包目录并设置线程所需响应头。范围仅为下表入口及主流程直接使用的契约，其余文件没有逐一审核。

| 重要代码 | 功能 | 关键符号 | 调用方 / 使用方 |
| --- | --- | --- | --- |
| [职责入口](../server/serve-player.py) | 只暴露打包目录并设置线程所需响应头 | `PlayerHandler / main` | 打包后的人工预览 |

相关验证：`server/player-tests/`。本轮只检查可读证据，业务测试没有执行。

## `deps/ppsspp-wasm/SDL/`

这里只追踪窗口尺寸与输入坐标直接关联的分支，不把上游目录整体视为已审核。

| 重要代码 | 功能 | 关键符号 | 调用方 / 使用方 |
| --- | --- | --- | --- |
| [窗口事件与 DPI](../deps/ppsspp-wasm/SDL/SDLMain.cpp) | 尺寸变化时先更新 DPI，再更新显示边界，拒绝无效尺寸 | `UpdateScreenDPI / SDL_WINDOWEVENT_SIZE_CHANGED` | SDL 事件循环、原生显示与输入换算 |

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

## 覆盖范围

覆盖 Angular 到浏览器运行时的接线、栏目与触控交互、启动能力检查、本地文件挂载、打包与预览；只追踪这些入口。模拟器 CPU/GPU、FFmpeg、完整在线下载、联机、云同步和移动设备性能未覆盖；deps 仅追踪对话框确认、窗口尺寸与设置栏目相关入口，其余第三方实现不作逐层架构讲解。

生成物、依赖安装目录、临时日志及第三方供应商源码不作为本次第一方模块地图。修改范围外机制前应重新调查，不能从本页推断兼容性。

证据状态：除特别标注外，本页基于当前源码已确认。
