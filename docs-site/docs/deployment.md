# 部署模式与下载清单准备

PPSSPW 把“构建工具链（Emscripten + Node/pnpm）”与“静态站点分发 / 中继服务”明确分离。生产站点只需要托管 `wasm-page/dist/ppsspp-web/` 静态目录并配置跨源隔离响应头，不需要在公网服务器上运行 C++ 编译器。

## 模式一：本地打包预览（推荐调试入口）

在已经具备配套 WASM 核心产物的前提下，最快的本机验证方式是执行标准打包并启动只读预览服务：

```sh
# 1. 构建前端资源并校验/打包 WASM 核心产物至 wasm-page/dist/ppsspp-web
make app-install app-build-pages

# 2. 启动带 COOP/COEP/CORP/CSP 响应头的本地预览服务（默认绑定 127.0.0.1:17881）
python3 server/serve-player.py
```

- **端口与独占监听**：`server/serve-player.py` 中的 `PlayerServer` 默认在 `127.0.0.1:17881` 监听，禁用地址复用以避免多个旧实例同时争抢请求；更新静态构建前务必先终止已有进程。
- **局域网 HTTPS 真机测试**：移动端必须运行在安全上下文。可通过 `--bind 0.0.0.0 --cert cert.pem --key key.pem` 启动内置 TLS，并用 `--connect-origin https://your-cdn.example` 放行额外 `CSP connect-src` 来源。

## 模式二：Docker Compose 静态预览容器

仓库根目录的 `docker-compose.yml` 将打包目录只读挂载到容器内的 `/app/wasm-page/dist/ppsspp-web`。容器内的服务监听 `0.0.0.0:17881`，宿主机通过 `127.0.0.1:17881` 访问。

```sh
# 先保证本地存在已打包的 wasm-page/dist/ppsspp-web，再启动容器
docker compose up -d
```

> [!NOTE]
> `docker-compose.yml` 仅挂载并暴露已生成的 `wasm-page/dist/ppsspp-web` 静态目录，**不会在容器内重新编译 PPSSPP WASM 核心**。

## 模式三：全量工具链构建与 EdgeOne Pages CI 发布

当需要从源码完整编译 FFmpeg + PPSSPP WASM 核心时，仓库通过 `Makefile` 与 `.github/workflows/` 提供统一入口（需 Linux / WSL 环境与已激活的 Emscripten SDK，或直接使用 `scripts/ci/Dockerfile` 镜像，镜像内置 `node:24.21.0`、`pnpm@12.6.0` 与 `emsdk:6.0.12`）：

| 构建与发布步骤 | 执行脚本 / 入口 | 核心校验动作 |
| --- | --- | --- |
| 1. 源码回归与全量构建 | `scripts/ci/build.sh` | 冻结安装依赖后运行 `make test-ci`，再由 `make wasm-release` 编译核心。`make app-build-pages` 构建网页并调用打包器，默认拒绝诊断核心，同时复制「关于」页链接的五份许可文本 |
| 2. 产物门禁与头规则生成 | `scripts/ci/prepare-deploy.mjs` | 确认五份许可文本齐备且非空后清理旧清单、写入响应头配置并更新部署标识，最后检查静态产物 |
| 3. 手动发布与线上验收 | `.github/workflows/deploy.yml` | 手动演练运行到产物校验。正式发布后可运行 `verify-deployment.mjs`，核对本次部署标识、隔离响应头和 Wasm MIME |

发布工具及其依赖由 `scripts/ci/deploy-tool/pnpm-lock.yaml` 固定。流水线使用冻结锁文件安装，干跑也会检查部署子命令能否加载。

在 `.github/workflows/deploy.yml` 中，CI 仅向部署及验收步骤按需读取三个私有 Secrets，不将任何凭据写进构建产物或源码：

- `EDGEONE_PROJECT_NAME`：目标 EdgeOne 项目名
- `EDGEONE_PAGES_API_TOKEN`：EdgeOne Pages 部署凭据
- `PLAYER_PUBLIC_ORIGIN`：部署完成后的线上验收入口地址

## 自托管任意静态网关必备 HTTP 响应头

如果将 `wasm-page/dist/ppsspp-web/` 部署到 Nginx、Caddy 或自定义 CDN，请严格对齐 `scripts/ci/prepare-deploy.mjs` 与 `server/serve-player.py` 的响应头契约：

| 路径匹配 | 必需响应头 | 作用与约束 |
| --- | --- | --- |
| `/*` | `Cross-Origin-Opener-Policy: same-origin` | 与 COEP 共同触发浏览器跨源隔离 |
| `/*` | `Cross-Origin-Embedder-Policy: require-corp` | 解锁 `SharedArrayBuffer` 与 WASM `pthreads` |
| `/*` | `Cross-Origin-Resource-Policy: same-origin` | 防止跨站内嵌未授权资源 |
| `/*` | `Content-Security-Policy: ... worker-src 'self' blob:; connect-src 'self' blob: https:` | 允许 Dedicated Worker 与 HTTPS 分块下载源 |
| `/build-wasm/*.wasm` | `Content-Type: application/wasm` | 支持浏览器流式编译 `WebAssembly.instantiateStreaming` |
| `/sw.js`、`/build-info.json` | `Cache-Control: no-cache` | 确保核心清单与 Service Worker（`v16`）及时刷新 |

## 准备在线分块下载清单（Game Manifest）

仓库提供 `scripts/create-game-manifest.py` 为合法自持游戏镜像生成 `.manifest.json` 描述文件，供网页「在线游戏」面板流式拉取与 OPFS 断点续传：

```sh
python3 scripts/create-game-manifest.py /path/to/my-game.iso \
  --url https://static.example.com/psp/my-game.iso \
  --chunk-size 4194304 \
  --out ./my-game.manifest.json
```

生成规则与上限（写死在清单生成器与网页校验器内）：
- `--chunk-size` 必须落在 `64 KiB` 至 `16 MiB` 之间（默认 `4 MiB`），且为 2 的幂次或合法分块大小；
- 单游戏镜像体积不超过 `8 GiB`，生成的 manifest JSON 不超过 `1 MiB`；
- 每个清单可绑定 `1` 到 `6` 个下载地址，除 `localhost` / `127.0.0.1` / `[::1]` 外一律拒绝明文 `http://`；
- 镜像托管服务器必须支持字节范围请求并返回 `HTTP 206 Partial Content`，不能自动降级为 `200 OK` 或返回压缩后的 `Content-Encoding`（仅允许无压缩/`identity`）。

## 可选：部署 Ad Hoc 多人中继服务

仓库在 `deploy/relay/` 保留了基于 Docker Compose + Caddy 的 WebSocket 中继栈。注意它**独立于静态播放器与文档站**部署，且当前页面中 `LOCAL_ONLY = true` 默认屏蔽了前端联机 UI：

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `RELAY_AUTH_MODE` | `open`（见 `.env.example`） | 设为 `open` 开放匿名房间；设为 `keys` 时强制检验 SQLite 中的用户会话密钥 |
| `RELAY_AUTH_DB` | `/data/relay-auth.sqlite3` | 容器持久化 SQLite 数据库路径，由 `server/relay_admin.py` 本地管理 |
| `RELAY_MAX_CONNECTIONS` | `512` | 单实例并发 WebSocket 上限 |
| `RELAY_TIMEOUT` | `60` | 心跳超时（秒） |
| `RELAY_LATENCY_MS` / `RELAY_JITTER_MS` | `0` / `0` | 压测时注入的人为往返延迟与抖动毫秒数 |

```sh
# 进入 deploy/relay 使用 Caddy 反代（暴露 /healthz 与 /adhoc）启动中继
cd deploy/relay && ./deploy.sh
# 当 RELAY_AUTH_MODE=keys 时在服务端本机签发密钥（无公网 HTTP 管理端）
docker compose exec relay python3 /app/server/relay_admin.py issue --user player1 --ttl-hours 72
```
