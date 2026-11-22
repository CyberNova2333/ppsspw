# 部署与运行排错 FAQ

本页汇总部署响应头、Service Worker 缓存、HTTP Range 校验以及构建门禁引发的常见运行阻断。

## 1. 页面打开但提示 `SharedArrayBuffer` 不可用（`crossOriginIsolated=false`）

- **典型表现**：控制台打印 `AUDIO: SharedArrayBuffer unavailable (crossOriginIsolated=false). Check COOP/COEP server headers.`，或运行时在能力检测阶段拦截启动。
- **常见成因与排查**：
  1. 静态网关遗漏了 `Cross-Origin-Opener-Policy: same-origin` 或 `Cross-Origin-Embedder-Policy: require-corp`；
  2. 通过局域网 HTTP IP（非 `localhost` / `127.0.0.1`）访问页面，浏览器安全策略直接禁用隔离上下文与 `SharedArrayBuffer`；
  3. 仅首次加载由 `wasm-page/public/sw.js`（当前版本 `ppsspp-player-v22`）补注响应头，尚未完成一次刷新接管。
- **处理方式**：核对 CDN / Nginx 响应头；手机局域网调试改用带有效证书的 HTTPS（可用 `server/serve-player.py --cert ... --key ...`）；查看 `devtools -> Network` 主文档与 worker 脚本响应头是否生效。

## 2. 启动预览服务 `serve-player.py` 报错地址已占用

- **典型表现**：重新执行 `python3 server/serve-player.py` 时提示 `OSError` / 端口被占用并拒绝启动。
- **成因与处理**：`PlayerServer` 刻意禁用多进程共享监听端口，以防止旧版本响应接口抢占请求。请先确认并结束占住 `17881` 端口的旧 `python3` / Docker 容器进程后再重跑预览命令。

## 3. 在线游戏清单（Manifest）下载在中途中断或直接报错拒绝

- **典型表现**：开始安装清单时校验失败、Worker 报错退出，或拒绝从非本地 HTTP 拉取分块。
- **逐项核对**：
  - 源地址是否为 `https://`（仅 `localhost` / `127.0.0.1` / `[::1]` 例外）；
  - 静态 CDN/对象存储是否在 `Access-Control-Allow-Origin` 中允许了当前播放器域名，并在请求 `Range: bytes=...` 时准确返回 `206 Partial Content` 与未压缩字节流（返回 `200 OK`、跳转重定向或携带 `Content-Encoding: gzip` 均会被 `game-download.js` 安全拒绝）；
  - 多个浏览器标签页同时下载同一游戏指纹时，`ppsspp-download-<fingerprint>` 独占 Web Lock 会阻止重复写入，关闭多余标签页即可恢复。

## 4. `scripts/ci/prepare-deploy.mjs` 在发布前失败拦截

- **常见触发规则**：
  1. 构建产物包含了 `WASM_FRAME_TIMING` 或 `WASM_IR_BLOCK_PROFILE` 诊断标记（见 `build-info.json` 与核心元数据）；除非明确执行 `--allow-diagnostics` 测试发布，否则生产发布脚本自动拒绝上传诊断版核心；
  2. `WASM_INITIAL_MEMORY`、`WASM_MAXIMUM_MEMORY`、`WASM_COMPUTE_THREADS` 或 `WASM_PTHREAD_POOL_SIZE` 偏离了核心安全边界校验；
  3. 核心目录下缺少 `ppsspp.js` / `ppsspp.wasm` 或配套核心与前端基线脱节。

## 5. 更新构建后浏览器界面或核心仍停留在旧版本

- **排查方式**：检查 `wasm-page/public/sw.js` 缓存条目及 `/sw.js`、`/build-info.json` 的服务器 `Cache-Control` 是否包含 `no-cache`；开发调试可在浏览器开发者工具勾选 `Bypass for network` 并注销旧 Service Worker 后硬刷新。

## 6. 为什么页面右侧没有联网多人（Netplay）按钮？

- **事实说明**：当前仓库主分支 `wasm-page/public/ppsspp-runtime.js` 设置了 `LOCAL_ONLY = true`，`app.html` 中的 `tabNetwork` 与 `tabDrive` 处于 `hidden` 与 `inert` 禁用态。这不是缺失构建或部署配置错误，而是当前本地优先发行版本的默认边界；相关说明与自托管中继细节见[契约页](/docs/contracts)。
