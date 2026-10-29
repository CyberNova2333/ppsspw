# PPSSPW 代码地图

先读[主流程的输入与交接](walkthroughs/one-real-run.md)，再按责任定位修改。本页只覆盖已声明主流程，不把目录出现过当作完整模块调查。

| 路径 | 职责 | 关键代码 | 与主流程的关系 |
| --- | --- | --- | --- |
| `wasm-page/src/app/` | 页面启动与运行时脚本接线 | `wasm-page/src/app/ppsspp-runtime.ts` | Angular 入口调用 |
| `wasm-page/public/` | 启动、浏览器文件与存档的实际运行逻辑 | `wasm-page/public/ppsspp-runtime.js` | 页面按序载入 |
| `wasm-page/tests/` | 约束启动能力和存储失败行为 | `wasm-page/tests/runtime.test.mjs` | wasm-page 的 test 命令 |
| `scripts/` | 把配套核心交给静态网页产物 | `scripts/package-player.py` | make pages 或显式打包命令 |
| `server/` | 只暴露打包目录并设置线程所需响应头 | `server/serve-player.py` | 打包后的人工预览 |

## `wasm-page/src/app/`

页面启动与运行时脚本接线。范围仅为下表入口及主流程直接使用的契约，其余文件没有逐一审核。

| 重要代码 | 功能 | 关键符号 | 调用方 / 使用方 |
| --- | --- | --- | --- |
| [职责入口](../wasm-page/src/app/ppsspp-runtime.ts) | 页面启动与运行时脚本接线 | `PpssppRuntime.bootstrap` | Angular 入口调用 |

相关验证：`wasm-page/tests/runtime.test.mjs`。本轮只检查可读证据，业务测试没有执行。

## `wasm-page/public/`

启动、浏览器文件与存档的实际运行逻辑。范围仅为下表入口及主流程直接使用的契约，其余文件没有逐一审核。

| 重要代码 | 功能 | 关键符号 | 调用方 / 使用方 |
| --- | --- | --- | --- |
| [职责入口](../wasm-page/public/ppsspp-runtime.js) | 启动、浏览器文件与存档的实际运行逻辑 | `start / loadPersistedFiles / mountBrowserGame` | 页面按序载入 |

相关验证：`wasm-page/tests/runtime.test.mjs`。本轮只检查可读证据，业务测试没有执行。

## `wasm-page/tests/`

约束启动能力和存储失败行为。范围仅为下表入口及主流程直接使用的契约，其余文件没有逐一审核。

| 重要代码 | 功能 | 关键符号 | 调用方 / 使用方 |
| --- | --- | --- | --- |
| [职责入口](../wasm-page/tests/runtime.test.mjs) | 约束启动能力和存储失败行为 | `partial core / storage maintenance 用例` | wasm-page 的 test 命令 |

相关验证：`wasm-page/package.json`。本轮只检查可读证据，业务测试没有执行。

## `scripts/`

把配套核心交给静态网页产物。范围仅为下表入口及主流程直接使用的契约，其余文件没有逐一审核。

| 重要代码 | 功能 | 关键符号 | 调用方 / 使用方 |
| --- | --- | --- | --- |
| [职责入口](../scripts/package-player.py) | 把配套核心交给静态网页产物 | `main / diagnostic_metadata` | make pages 或显式打包命令 |

相关验证：`server/player-tests/`。本轮只检查可读证据，业务测试没有执行。

## `server/`

只暴露打包目录并设置线程所需响应头。范围仅为下表入口及主流程直接使用的契约，其余文件没有逐一审核。

| 重要代码 | 功能 | 关键符号 | 调用方 / 使用方 |
| --- | --- | --- | --- |
| [职责入口](../server/serve-player.py) | 只暴露打包目录并设置线程所需响应头 | `PlayerHandler / main` | 打包后的人工预览 |

相关验证：`server/player-tests/`。本轮只检查可读证据，业务测试没有执行。

## 覆盖范围

覆盖 Angular 到浏览器运行时的接线、启动能力检查、本地文件挂载、打包与预览；只追踪这些入口。模拟器 CPU/GPU、FFmpeg、完整在线下载、联机、云同步和移动设备性能未覆盖；deps 中的第三方实现不作逐层架构讲解。

生成物、依赖安装目录、临时日志及第三方供应商源码不作为本次第一方模块地图。修改范围外机制前应重新调查，不能从本页推断兼容性。

证据状态：除特别标注外，本页基于当前源码已确认。
