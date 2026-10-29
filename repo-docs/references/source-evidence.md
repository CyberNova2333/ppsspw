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
| 通过受限预览入口提供运行条件 | [源码定位](../../server/serve-player.py)：`PlayerHandler、root；打包脚本 scripts/package-player.py` | Confirmed | 源码静态确认；本轮未运行业务路径 | [主流程](../walkthroughs/one-real-run.md)、[代码地图](../code-map.md) |

## 反证与后续问题

反证检查（Falsifying check）：若缺少共享内存仍进入核心启动，或部分核心文件能绕过配套检查，本指南的启动边界便不成立。

下一位读者可能问（Next reader question）：在线下载如何恢复分块？既有 docs/game-download.md 解释协议，当前 walkthrough 不展开该路径。

## 范围与未验证事项

覆盖 Angular 到浏览器运行时的接线、启动能力检查、本地文件挂载、打包与预览；只追踪这些入口。模拟器 CPU/GPU、FFmpeg、完整在线下载、联机、云同步和移动设备性能未覆盖；deps 中的第三方实现不作逐层架构讲解。

运行时测试会提取真实 public 脚本函数并用替身验证边界；这与真实核心和真实游戏验收不同。本轮不运行核心构建、网页构建或业务测试，也不替换现有 wasm-page/dist。完整核心构建仍按根 README 的 Emscripten/Linux 或 WSL 要求执行。

本轮文档结构校验与站点构建结果记在[同步记录](../change-log.md)。源码链接在仓库阅读时指向真实文件；独立站点只发布指南；文档目录之外的仓库源码链接在网页中显示为精确路径，源码不随站点打包。原始 Markdown 保留本地可核对链接。已有 VitePress 使用原文包含，正文只维护一份。
