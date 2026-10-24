# PPSSPP Web · PSP 网页模拟器

基于 PPSSPP WebAssembly 的中文浏览器客户端。网页、模拟器核心及其递归依赖的源码直接保存在本仓库，便于独立维护；不需要拉取上游或应用补丁才能构建。

目前实现本地游戏选择与游戏库、通用分块下载与暂停续传、中文网页和模拟器界面、移动布局、触控开关、1×/2×/3×内部渲染分辨率、帧率显示，以及存档导入、导出和本机同步。运行中调整画质或触控设置会在下次启动生效。

下载地址由运行时导入的清单提供，可以选择本地 JSON 清单或输入清单链接。客户端不内置游戏目录或 CDN 地址，换来源不需要重新构建。

游戏文件按需读取，读取缓存上限为 8 MiB，启动时不再将整个 ISO 复制到模拟器内存。图像超分和进一步的浏览器性能优化仍待实现；提高内部渲染分辨率不会自动补齐原始纹理和二维素材的细节。

「系统诊断」支持按需记录核心实际帧率、仿真速度、启动阶段、ISO 读取延迟和音频欠载，并导出不含游戏名、网址或日志的性能 JSON。手机采样方法、桌面对照结果及指标边界见 [性能测量](docs/browser-performance.md)。

## 源码布局

| 路径 | 内容 |
| --- | --- |
| `wasm-page/` | Angular 网页入口、运行时和行为测试 |
| `deps/ppsspp-wasm/` | 模拟器核心及展开后的第三方源码 |
| `scripts/build-ffmpeg-wasm.sh` | 浏览器电影与音频解码依赖构建 |
| `scripts/package-player.py` | 配套核心产物与网页打包 |
| `server/serve-player.py` | 只提供打包目录的本地预览服务器 |
| `scripts/ci/` | 固定工具链、源码构建与发布验证脚本 |
| `scripts/ci/` | 完整构建、静态产物准备与线上响应头验证 |
| `upstream/source-lock.json` | 所有上游提交、导入规则和排除清单 |
| `upstream/web/` | 上游原始工程元数据和构建入口备份 |

历史上游文档、服务器、部署模板和补丁保留用于阅读；本客户端以这里的构建命令为准。`patches/` 不参与当前构建。更新上游应作为显式的源码合并和评审进行，不跟踪浮动版本。

## 正式构建与部署

正式发布走 **完整源码构建 → 任务级注入保密配置 → EdgeOne Makers 直传**。构建与正式发布分开执行；发布入口以最新主线的 GitHub Actions 手动工作流为准，并检查线上构建版本、COOP/COEP/CSP 和 Wasm 响应类型。

部署和线上验证分别只读取本项目所需的保密配置，完整构建阶段不读取部署凭据。配置仅提供目标项目、部署凭据和线上验证地址；构建无需游戏下载来源或清单。真实配置地址和凭据不写入源码。配置格式与权限范围见 [部署说明](docs/deployment.md)，游戏下载协议见 [下载说明](docs/game-download.md)。

## 本地开发与验证

需要 Node.js 24.21 或满足 `wasm-page/package.json` 的版本、npm 11.19、Python 3.9+、GNU Make、CMake、Ninja，以及已激活的 Emscripten **6.0.12**。核心构建使用 Linux；Windows 使用 WSL。工具链和 npm 包通过锁定版本安装，不把它们的安装目录入库。

在已激活 Emscripten 的 shell 中运行：

```sh
npm --prefix wasm-page ci
make wasm-release WASM_JOBS=-j8 WASM_FFMPEG_JOBS=8
npm --prefix wasm-page run build:pages
python3 scripts/package-player.py
python3 server/serve-player.py
```

访问 <http://127.0.0.1:17881/>。也可用 `make pages` 执行核心、网页和打包步骤。核心启用 FFmpeg，以支持游戏中的视频和音频；默认关闭 LTO。完整构建可能耗时较长。

只修改网页时，重新执行网页构建和打包两条命令。Angular 构建会清空输出目录，因此每次都需要重新打包核心。`npm --prefix wasm-page start` 可开发网页，但启动真实游戏仍需配套核心产物。

本地构建仅用于开发和验证。预览服务器只暴露 `wasm-page/dist/ppsspp-web/`，不会提供 `resources/` 或仓库源码，并设置 WebAssembly 线程所需的 COOP/COEP 响应头。手机通过局域网访问需要受信任的 HTTPS，可使用 `--bind`、`--cert` 和 `--key` 参数。`docker compose up` 仅预览已打包目录。

## 使用说明

- 自备游戏镜像，选择 ISO、CSO、CHD 等支持的格式。ZIP / 7z 需先解压。此仓库不含游戏本体。
- 选择本地文件并启动不会自动将游戏复制到浏览器存储；需要保存到游戏库时，使用游戏库的添加操作。在线下载会直接保存在独立的下载缓存中。
- 在下载页导入清单，确认游戏文件后点击下载；必须下载完成后才能启动。刷新后重新导入对应清单即可继续，恢复依据已落盘的校验记录跳过完成块，不会每次重新计算整个游戏的哈希。
- 手机推荐横屏；在「画质与操作」开启触控。键盘方向键移动，`X` 对应圆圈，`Z` 对应叉，空格对应 START，`Esc` 打开模拟器菜单。
- 启动时游戏嵌入网页显示，需要全屏时使用网页工具栏按钮；导入配置中的原生全屏设置不会在启动时自动生效。
- 「同步到本机」保存游戏已经生成的存档文件，不能替代游戏内存档。离开前在游戏中保存，再同步或导出备份。
- 浏览器存储与网站地址和浏览器配置绑定；清理网站数据、隐私模式或存储空间回收可能影响本地文件。重要进度请导出备份。
- 当前仍运行 PSP 模拟器。低端移动设备的速度、内存占用和耗电需要真机验证，不能由桌面运行结果推断。

## 检查

```sh
npm --prefix wasm-page test
python3 -m unittest discover -s server/player-tests -v
node --test scripts/ci/prepare-deploy.test.mjs
node --test scripts/profile-browser.test.mjs
```

游戏镜像及提取文件统一放在被忽略的 `resources/` 中；本地截图和验证日志可放在被忽略的 `.local/` 中。不要将这些内容、依赖安装目录或构建输出添加到版本控制。

## 许可

本项目按 [GPLv3](LICENSE) 发布。引入的 PPSSPP 核心和网页运行时声明为 GPL-2.0-or-later，可选择 GPLv3 条款分发；所有第三方源码保留原有版权与许可声明，详见 [UPSTREAM.md](UPSTREAM.md) 和各组件的许可文件。游戏本体与素材不由本项目许可证授权。
