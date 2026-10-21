# GitHub Actions 构建与 EdgeOne Makers 部署

正式产物从本仓库的完整源码在自动化构建任务中构建，再直传 EdgeOne Makers。站点使用 Makers 的直传项目类型，不让静态宿主重新拉取源码或编译模拟器。本地构建、预览服务器和本地 Docker 仅用于开发与验证。

## 流水线

以下区分构建与发布的工作范围；具体触发入口以最新主线的 GitHub Actions 工作流为准：

| 入口 | 工作范围 |
| --- | --- |
| `main` 的 `push` | 安装锁定依赖、行为测试、FFmpeg 与模拟器完整构建、网页构建、静态产物检查；不读取部署凭据，不部署 |
| `main` 的「构建并部署网页客户端」按钮 | 完成同样的测试与构建后，读取对应部署凭据上传静态产物，并验证线上版本与实际响应头 |

工具链由 `scripts/ci/Dockerfile` 固定为 Emscripten 6.0.12、Node.js 24.21.0、npm 11.19.0；该镜像仅提供工具链。FFmpeg 启用，LTO 关闭。核心、网页和递归依赖均来自本仓库，不在流水线中拉取上游源码或应用补丁。`.dockerignore` 排除游戏资源及其他工作区文件，不将其发送到工具链镜像构建上下文。

上传目录仅为 `wasm-page/dist/ppsspp-web/`，发布前检查核心产物和配置，并拒绝混入游戏镜像、压缩包、资源目录、依赖安装目录和符号链接。构建不下载远端游戏清单或游戏文件，也不注入固定下载地址。

## 保密配置与历史参数

旧发布入口的远端配置文件导入规则已移除。下表仅保留原有参数职责；当前发布以最新主线 GitHub Actions 工作流为准，凭据仅在部署或线上验证步骤读取。


| 文件 | 字段 | 作用 |
| --- | --- | --- |
| `build.yml` | `PLAYER_PUBLIC_ORIGIN` | 已绑定的正式站点 HTTPS origin，供部署后的版本和响应头验证使用 |
| `deploy.yml` | `EDGEONE_PROJECT_NAME` | 对应的 Makers 直传项目名称 |
| `deploy.yml` | `EDGEONE_PAGES_API_TOKEN` | Makers 部署凭据，仅传入部署插件参数 |

部署凭据实行**一项目一 Token**：在 Makers 控制台的 API Token 页面为本项目单独创建，描述中标明项目和 CI 用途，并设置过期时间。不得复用其他项目的 Token，也不得把本机 CLI 自动生成或保存的登录 Token 用作本项目部署凭据。创建与轮换流程见 [官方 API Token 文档](https://pages.edgeone.ai/document/api-token)。

独立 Token 便于单独轮换和撤销，但不等于平台已限制其权限到单个项目。当前 [官方 SDK 文档](https://cloud.tencent.com/document/product/1552/138172) 将控制台创建的主 API Token 定义为账号级凭据；若控制台提供项目范围选择，应只选择本项目，不以名称代替权限限制。

部署参数仅由部署任务读取，不进入完整构建与打包阶段；旧平台专属插件与文件导入规则已移除。

发布入口以最新主线 GitHub Actions 的手动工作流为准。实际配置值只存放于受控配置中，不进入源码、文档、构建命令参数或日志。

`PLAYER_PUBLIC_ORIGIN` 只用于从站外检查本次部署，不写入播放器产物。游戏来源由玩家在运行时显式导入本地 JSON 清单，或输入 HTTPS 清单 URL；不需要为更换下载来源重新构建播放器。清单格式见 [游戏下载说明](game-download.md)。

`prepare-deploy.mjs` 无需环境变量或网络访问。它移除旧构建遗留的固定游戏目录与清单，生成通用 `edgeone.json` 和本次部署标识，并检查完整静态产物。现有密钥文件中的其他字段不再参与游戏下载配置，构建也不会修改用户凭据。

## 静态宿主与资源服务

生产站点需要 HTTPS，并正确提供 `Cross-Origin-Opener-Policy: same-origin`、`Cross-Origin-Embedder-Policy: require-corp`、Wasm MIME 类型和 CSP。连接策略固定为 `connect-src 'self' blob: https:`，允许玩家指定的 HTTPS 清单与下载来源，不在构建时列出 CDN 域名；Worker 仍限制为同源与 Blob。开发时的 loopback HTTP 由本地预览服务器单独支持。

Makers 的直传模式支持在上传目录根放置 `edgeone.json`，其 `headers` 可设置静态响应头；参见 [直传文档](https://pages.edgeone.ai/document/direct-upload) 和 [响应头配置](https://pages.edgeone.ai/document/edgeone-json)。配置成功写入产物不代表线上已生效，因此部署末尾还检查线上 `build-info.json` 的核心版本和本次部署唯一标识，并对页面、Worker、核心 JS 和 Wasm 发出 HEAD 请求，核对实际响应头。部署标识每次打包准备时更新，使仅修改网页的发布也能识别仍在提供旧产物的站点。

资源服务还必须提供准确的 Range `206` 响应和 CORS，暴露 `Content-Range` 等需要读取的响应头，禁止对游戏文件进行传输压缩或字节转换。配置站点 COOP/COEP 不能代替资源服务的 CORS；详细请求示例与排错见 [资源响应要求](game-download.md#资源响应要求)。

## 发布前后检查

1. 确认本项目凭据与正式站点 origin 可供对应的部署和线上验证任务读取；无需新增游戏下载配置。
2. 正式发布通过最新主线的 GitHub Actions 手动部署入口进行。完整构建、上传和线上检查均需成功。
3. 通过正式 HTTPS 站点导入自备清单，检查下载暂停与恢复、游戏启动、存档读写，以及目标手机的长期游玩表现。

本地可运行 `node --test scripts/ci/prepare-deploy.test.mjs` 验证离线构建准备、遗留目录清理、产物边界和线上响应头判据。首次实际自动化构建及线上验证的结果应独立记录，不用本地测试通过代替。
