# PPSSPW 源码证据

这是调查台账：解释主流程的依据与边界，不能替代运行日志。源码锚点为 `6011ff1ec1f774a656e6a8f1feac1410fb2f7a9a`；本轮还读取了当前工作树，未提交内容不等于已交付版本。

## Evidence Traversal Log

| Pass | Purpose | Inspected evidence | What changed in the model |
| --- | --- | --- | --- |
| Pass 1 | 建立输入、状态和输出路径 | `wasm-page/src/app/ppsspp-runtime.ts`, `wasm-page/public/ppsspp-runtime.js`, `wasm-page/public/ppsspp-runtime.js`；根 README、package 或构建入口、Agent 规则 | 固定 walkthrough 的代表性行为，并列出交接位置。 |
| Pass 2 | 反查失败与遗漏依赖 | `wasm-page/tests/runtime.test.mjs`, `wasm-page/tests/runtime.test.mjs`, `wasm-page/package.json`；配置、已有文档与范围内目录 | 检查能力不足、存储租约失败、配套核心缺失与恢复失败测试；确认测试用替身约束浏览器运行时，不能据此声称模拟器真机性能。 |

## 证据表

| Claim | Evidence | Confidence | Caveat | Used by |
| --- | --- | --- | --- | --- |
| 网页按顺序接上运行时 | [源码定位](../../wasm-page/src/app/ppsspp-runtime.ts)：`PpssppRuntime.bootstrap / start / loadScript` | Confirmed | 源码静态确认；本轮未运行业务路径 | [主流程](../walkthroughs/one-real-run.md)、[代码地图](../code-map.md) |
| 用户启动前核对浏览器能力 | [源码定位](../../wasm-page/public/ppsspp-runtime.js)：`start、probeWebGLFeaturesWithPref、reloadForCrossOriginIsolation` | Confirmed | 源码静态确认；本轮未运行业务路径 | [主流程](../walkthroughs/one-real-run.md)、[代码地图](../code-map.md) |
| 锁定存储并选择配套核心 | [源码定位](../../wasm-page/public/ppsspp-runtime.js)：`PpssppGameStorage.acquireShared、selectBuildDir、startupWatchdog` | Confirmed | 源码静态确认；本轮未运行业务路径 | [主流程](../walkthroughs/one-real-run.md)、[代码地图](../code-map.md) |
| 恢复存档并按需挂载镜像 | [源码定位](../../wasm-page/public/browser-files.js)：`CACHE_BYTES；在运行时搜索 mountBrowserGame / loadPersistedFiles` | Confirmed | 源码静态确认；本轮未运行业务路径 | [主流程](../walkthroughs/one-real-run.md)、[代码地图](../code-map.md) |
| 核心文件写入与浏览器持久化是先后两个阶段 | [运行时](../../wasm-page/public/ppsspp-runtime.js)：`OPFS_ROOT_DIR / OPFS_PERSIST_DIR / opfsParent / persistFilesNow / startAutoPersist / PERSIST_SYNC_MS` | Confirmed | 自动同步间隔为 30 秒；核心目录和站点 OPFS 需分别核对；仅空目录无法确定某次游戏提示的根因 | [主流程](../walkthroughs/one-real-run.md) |
| 确认／取消语义不能从网页按钮位置推定 | [工具对话框](../../deps/ppsspp-wasm/Core/Dialog/PSPDialog.cpp)：`UpdateCommon / IsButtonPressed`；[存档确认分支](../../deps/ppsspp-wasm/Core/Dialog/PSPSaveDialog.cpp)：`DS_SAVE_CONFIRM / yesnoChoice / ExecuteIOAction` | Confirmed | `buttonSwap` 只说明 PSP 工具对话框规则；游戏自己的提示仍需观察；淡入、取消与选择“否”不能当作文件写入失败 | [主流程](../walkthroughs/one-real-run.md) |
| 三层 JavaScript 输入抵达属于中间证据 | [屏幕手柄](../../wasm-page/public/touch-controls.js)：`BUTTONS / mount`；[输入桥](../../wasm-page/public/ppsspp-runtime.js)：`getSDLGamepads` | Confirmed | 需再核对游戏画面或原生状态与文件变化，不能凭输入采样断言保存成功 | [主流程](../walkthroughs/one-real-run.md) |
| 栏目通过可见图标文字按钮直接切换 | [模板](../../wasm-page/src/app/app.html)：`panelTabList`；[运行时](../../wasm-page/public/ppsspp-runtime.js)：`activatePanelTab / onPanelTabKeyDown`；[控件样式](../../wasm-page/src/player-controls.css)：`.panel-navigation` | Confirmed | 窄横屏使用横向滚动；设备等动态设置仍用原生选择框 | [主流程](../walkthroughs/one-real-run.md)、[代码地图](../code-map.md) |
| 摇杆落点与方向换向分别处理，取消操作清空输入 | [触控控制器](../../wasm-page/public/touch-controls.js)：`stickAxes / dpadButtons / setButtons / mount`；[行为测试](../../wasm-page/tests/touch-controls.test.mjs) | Confirmed | 每次摇杆按下建立零点；方向替换仅释放当前指针旧方向；脚本断言不能证明手机手感或游戏内响应 | [主流程](../walkthroughs/one-real-run.md)、[代码地图](../code-map.md) |
| 布局变化重算尺寸并取消旧手势 | [运行时](../../wasm-page/public/ppsspp-runtime.js)：`syncViewportSize / installCanvasResizeTracking`；[触控控制器](../../wasm-page/public/touch-controls.js)：`refreshGeometry / ppsspp-player-layout`；[控件样式](../../wasm-page/src/player-controls.css) | Confirmed | 捏合缩放不改变应用布局宽度；新落指重新测量；网页通知不替代核心触点或真实折叠设备验收 | [主流程](../walkthroughs/one-real-run.md)、[代码地图](../code-map.md) |
| 控件反馈保持位置，狭窄、矮窗口重排并保留画布面积 | [控件样式](../../wasm-page/src/player-controls.css)：`.touch-gamepad button / .touch-pad-shoulder / .touch-pad-system` 与宽高媒体查询 | Confirmed | 紧凑模式覆盖部分游戏画面；已测尺寸与命中边界见[变更记录](../change-log.md)，不推定所有设备均已验收 | [主流程](../walkthroughs/one-real-run.md) |
| 原生尺寸变化先刷新 DPI，再更新显示边界 | [窗口事件](../../deps/ppsspp-wasm/SDL/SDLMain.cpp)：`UpdateScreenDPI / SDL_WINDOWEVENT_SIZE_CHANGED`；[独立回归](../../scripts/test-sdl-viewport.py)与[测试夹具](../../wasm-page/tests/sdl-viewport.cpp) | Confirmed | 独立回归的 SDL 数据为替身；完整重建后的浏览器菜单点击结果另记于[变更记录](../change-log.md)，不替代游戏或真实设备验收 | [主流程](../walkthroughs/one-real-run.md)、[代码地图](../code-map.md) |
| 通过受限预览入口提供运行条件 | [源码定位](../../server/serve-player.py)：`PlayerHandler、root；打包脚本 scripts/package-player.py` | Confirmed | 源码静态确认；本轮未运行业务路径 | [主流程](../walkthroughs/one-real-run.md)、[代码地图](../code-map.md) |

## 反证与后续问题

反证检查（Falsifying check）：若缺少共享内存仍进入核心启动，或部分核心文件能绕过配套检查，本指南的启动边界便不成立。

下一位读者可能问（Next reader question）：在线下载如何恢复分块？既有 docs/game-download.md 解释协议，当前 walkthrough 不展开该路径。

## 范围与未验证事项

覆盖 Angular 到浏览器运行时的接线、栏目与触控交互、启动能力检查、本地文件挂载、打包与预览；只追踪这些入口。模拟器 CPU/GPU、FFmpeg、完整在线下载、联机、云同步和移动设备性能未覆盖；deps 仅追踪对话框确认与窗口尺寸相关入口，其余第三方实现不作逐层架构讲解。

运行时与触控测试执行真实 public 脚本函数并用替身验证边界，与真实核心和真实游戏验收分别记录。完整核心构建按根 README 的 Emscripten/Linux 或 WSL 要求执行；每次调查实际运行的验证见下方同步记录。

本轮文档结构校验与站点构建结果记在[同步记录](../change-log.md)。源码链接在仓库阅读时指向真实文件；独立站点只发布指南；文档目录之外的仓库源码链接在网页中显示为精确路径，源码不随站点打包。原始 Markdown 保留本地可核对链接。已有 VitePress 使用原文包含，正文只维护一份。
