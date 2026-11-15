# PPSSPW 源码阅读指南

玩家选择自己持有的游戏镜像后，网页需要先确认浏览器能力、配套核心和存档状态，才能把文件交给模拟器。本指南沿本地文件启动说明这条交接，帮助维护者区分页面能打开、核心能启动和游戏能流畅运行。

## 阅读路径

| 读者目标 | 从这里开始 | 读完后获得什么 |
| --- | --- | --- |
| 理解一次真实运行 | [主流程与拒绝边界](walkthroughs/one-real-run.md) | 能解释输入、交接和结果，知道失败在哪里出现 |
| 定位修改入口 | [按职责找代码](code-map.md) | 在已声明范围内找到入口、依赖和验证位置 |
| 深入 ISO 分窗读取与断点下载 | [8 MiB 分窗读取与断点下载恢复](modules/windowed-iso-and-download.md) | 理清 `BrowserFileLoader`、HTTP Range 校验与 OPFS 同步锁 |
| 排查节拍、音频、内存与诊断边界 | [运行时节拍、音频泵与浏览器稳定性边界](modules/runtime-perf-and-stability.md) | 掌握 `WEB_NATIVE_TIMING_CONFIG`、`8 ms` 音频泵、LTO/RAF 约束与采样方法 |
| 查看多人中继协议与开关状态 | [Ad Hoc 多人联机中继协议与前端开关边界](modules/adhoc-relay-protocol.md) | 区分 `LOCAL_ONLY = true` 前端门禁与 `PRO`/`PU1`/`PT1` 中继服务 |
| 排查触控防误触与窄屏布局 | [虚拟触控手柄与多端视口适配](modules/touch-gamepad-and-viewport.md) | 理解 60 ms 轻触保底、SDL DPI 刷新顺序与 720 阈值栏目切换 |
| 统一核心概念与符号含义 | [术语表](glossary.md) | 快速查对 OPFS、MEMFS、COOP/COEP、帧探针与中继术语 |
| 审核解释依据 | [源码证据与两遍调查](references/source-evidence.md) | 区分直接证据、范围限制和未执行验证 |
| 复核文档质量 | [读者模拟与剩余风险](references/quality-review.md) | 看懂本指南能回答什么，哪些问题仍需验证 |
| 查看同步边界 | [指南变更记录](change-log.md) | 找到源码锚点与本轮验证范围 |

## 覆盖范围

本指南覆盖 Angular 页面到浏览器运行时的接线、栏目与触控交互、启动能力检查、8 MiB 本地镜像与分块下载恢复、性能与音频节拍配置、打包预览以及 Ad Hoc WebSocket 中继栈。PPSSPP 核心内部 CPU JIT 指令实现、FFmpeg 音视频编解码内部与全量平台驱动细节不作逐层展开；`deps/` 仅追踪 `BrowserFileLoader`、对话框确认、窗口 DPI 与设置分栏等直接改造点。

本包采用 Standard 模式：主流程先建立端到端交接模型，模块页展开横切机制与协议边界，代码地图用于定位改动入口，证据表和术语表提供可核对依据。旧有散落文档已并入各模块页与公开文档站，源码和构建脚本是实现事实的唯一准绳。

## 运行与验证入口

以下命令在仓库根运行；启动命令会占用开发端口，构建命令可能写业务产物，请先阅读根规则。

```sh
pnpm --dir wasm-page install --frozen-lockfile
# 维护者验证命令，实际执行结果见指南变更记录
pnpm --dir wasm-page test
python -m unittest discover -s server/player-tests -v
# 已有配套核心时的网页重建与预览，会替换业务输出
pnpm --dir wasm-page run build:pages
python scripts/package-player.py
python server/serve-player.py
```

文档站的启动与构建命令见根 README 的文档入口。文档构建只验证说明页面，不证明业务可用或已部署。

## 专题模块与上游来源

- [8 MiB 分窗读取与断点下载恢复](modules/windowed-iso-and-download.md)
- [运行时节拍、音频泵与浏览器稳定性边界](modules/runtime-perf-and-stability.md)
- [Ad Hoc 多人联机中继协议与前端开关边界](modules/adhoc-relay-protocol.md)
- [虚拟触控手柄与多端视口适配](modules/touch-gamepad-and-viewport.md)
- [上游来源与许可](../UPSTREAM.md)

独立网页构建会把文档目录之外的仓库链接显示为精确文件路径，避免产生失效跳转；原始 Markdown 仍保留可核对的源码链接。站点只发布指南，源码和本机资源不会随文档打包。

证据状态：除特别标注外，本页基于当前源码已确认。
