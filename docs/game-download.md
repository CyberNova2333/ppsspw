# 游戏下载与读取机制

玩家从同源目录读取游戏清单，再向显式允许的资源来源下载。分块在 Worker 内校验并写入 OPFS；完整文件下载完成后才可启动游戏，不是边下载边运行。仓库内的默认目录为空，不包含游戏文件、实际分发地址或登录信息。

正式部署由自动化构建任务在完整构建后注入项目专用配置并发布到 EdgeOne Makers，详见 [部署说明](deployment.md)。本页的本地文件路径和示例仅用于生成元数据、开发与验证；忽略本地配置文件不能替代正式部署的凭据管理。

## 生成清单

将本地游戏文件和生成的清单暂存在已忽略的 `resources/` 下。下面的域名仅作格式示例；实际分发地址通过受控发布配置提供，不提交到源码仓库。

```sh
python scripts/create-game-manifest.py resources/game.iso --id game-zh --name game.iso --source https://cdn.example/game.iso --source https://mirror.example/game.iso --output resources/deployment/game-manifests/zh.json
```

脚本逐块读取输入，生成每块 SHA-256 和完整文件 SHA-256；不会复制游戏内容。输出文件必须不存在，以免覆盖既有清单或资源。默认每块 4 MiB，可用 `--chunk-size` 指定 64 KiB 至 16 MiB 的整数值。输入必须非空，最大 8 GiB；清单最大 1 MiB，超过时应增大块尺寸。

清单字段如下：

| 字段 | 约束与用途 |
| --- | --- |
| `schemaVersion` | 固定为 `1` |
| `id` | 最长 64 字符；字母或数字开头，其余可含字母、数字、点、下划线和连字符 |
| `name` | 不含路径、冒号和控制字符的文件名，UTF-8 最长 255 字节，后缀为 ISO、CSO、CHD 或 PBP |
| `size` | 游戏文件的准确字节数 |
| `chunkSize` | 校验与下载块大小，最后一块可以较短 |
| `sha256` | 按文件顺序排列的每块 SHA-256 十六进制值，数量等于 `ceil(size / chunkSize)` |
| `fileSha256` | 可选完整文件哈希，供发布者核对；客户端认证以逐块 `sha256` 为准 |
| `sources` | 1 至 6 个完整文件 URL，所有来源必须提供相同内容 |

下载来源必须使用 HTTPS，仅 `localhost`、`127.0.0.1` 和 `[::1]` 允许 HTTP 本地测试。不允许 URL 登录凭证、片段或重定向；查询参数可以使用，但具有有效期的地址过期后需要更新配置。浏览器不会携带登录凭证。续传内容身份由文件大小、块大小和块哈希确定；更换镜像地址不改变内容身份，更新游戏内容则需要重新生成清单。

## 配置游戏目录

在部署目录提供同源的 `game-catalog.json`：

```json
{
  "schemaVersion": 1,
  "allowedOrigins": ["https://cdn.example", "https://mirror.example"],
  "games": [
    {"title": "中文版", "manifest": "game-manifests/zh.json"}
  ]
}
```

`manifest` 必须解析到同源且不含登录凭证的地址。目录和清单均限制为 1 MiB，不能把游戏内容内嵌进 JSON。`allowedOrigins` 使用协议、主机和可选端口组成的精确 origin，不使用通配符或文件路径；清单中的所有下载来源都必须在此列表中。

网页构建会清理 `wasm-page/dist/ppsspp-web/`。正式部署步骤在构建与模拟器打包后读取 keygens 中的清单地址及 SHA-256，仅获取并校验 JSON 元数据，再生成该目录和同源清单；不修改源码内的空目录。ISO 由独立资源服务提供，不进入网页构建或发布目录。

本地预览时，还需将相同 origin 加入预览服务器的 CSP：

```sh
python server/serve-player.py --cdn-origin https://cdn.example --cdn-origin https://mirror.example
```

`--cdn-origin` 可以重复，只接受无路径、凭证和通配符的 HTTP(S) origin。不配置时仍为 `connect-src 'self' blob:`。此参数只扩展允许的连接来源，不改变服务根目录；`resources/`、仓库源码和点文件仍不对外提供。正式流水线从同一份允许来源列表生成 Makers 的 `edgeone.json`，使站点 CSP 与下载清单保持一致。

## 启动时按需读取

本地选择的文件、游戏库中的 OPFS 文件、已完成下载的 OPFS 文件都通过同一只读接口挂载。核心需要某个范围时才读取相应 `File` 切片；读取块为 256 KiB，单次请求最大 1 MiB，最多同时处理 4 次读取，共享读取缓存上限为 8 MiB。此上限仅指游戏读取缓存，不是模拟器的总内存上限；Wasm、图形资源、音频及临时读取结果仍占用内存。

选择本地文件并启动不会自动保存一份游戏副本。只有用户明确执行游戏库的添加操作时才复制到游戏库。在线下载的文件保留在独立下载缓存，启动不会再复制到游戏库或将整包放入 MEMFS。

下载过程也按块限制内存：默认 2 个下载任务，最多 4 个；每个校验块不超过 16 MiB。下载流先写入临时块文件，验证该块后再写入最终文件，不在内存拼接整个 ISO。

## 资源响应要求

资源服务必须支持单段字节 Range，返回准确的 `206 Partial Content`、`Content-Range` 和块长度。返回整个文件的 `200` 会被拒绝，避免一次性下载整个游戏；`416` 通常表示清单大小与资源不同。Range 的状态和范围规则见 [MDN Range 文档](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Range)。

例如请求第一块 `Range: bytes=0-4194303` 时，响应应类似以下格式，其中总大小必须来自实际文件：

```http
HTTP/1.1 206 Partial Content
Content-Type: application/octet-stream
Accept-Ranges: bytes
Content-Range: bytes 0-4194303/8388608
Content-Length: 4194304
Access-Control-Allow-Origin: https://player.example
Access-Control-Expose-Headers: Content-Range, Content-Length, Accept-Ranges, Content-Encoding
```

为游戏资源关闭 gzip、Brotli 等传输编码和内容转换；响应不应携带非 identity 的 `Content-Encoding`。范围、长度和哈希必须对应原始文件字节。客户端不能设置浏览器的 `Accept-Encoding`，因此需要在资源服务端配置。

跨域请求必须通过 CORS，响应允许玩家站点的准确 origin，或对无凭证公开资源使用 `*`。如果按请求 origin 动态返回允许来源，应同时发送 `Vary: Origin`。如服务触发预检，应允许 `GET`、`HEAD`、`OPTIONS` 和 `Range`。`Content-Range`、`Accept-Ranges`、`Content-Encoding` 需显式暴露；`Content-Length` 已属于可读取响应头，这里仍列出以便检查。详见 [MDN 响应头暴露说明](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Access-Control-Expose-Headers)。

玩家页面必须通过 HTTPS 提供，并保留 `Cross-Origin-Opener-Policy: same-origin` 和 `Cross-Origin-Embedder-Policy: require-corp`，以支持 Wasm 线程。下载使用 CORS 模式；正确的 CORS 响应可以在此隔离模式下读取。单独添加 `Cross-Origin-Resource-Policy: cross-origin` 不会代替 CORS 或暴露响应头，见 [MDN CORP 说明](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Cross-Origin_Resource_Policy)。

## 续传与故障处理

每块通过哈希校验并落盘后才计为完成。暂停、断网或关闭页面后，可以在同一浏览器、同一站点继续；恢复时检查内容身份、文件长度与已持久化的完成记录，跳过已校验块并继续下载未完成部分。恢复不会重新读取整个游戏计算哈希；完全下载好的缓存以只读方式复用。浏览器清理站点数据会删除下载缓存与本地存档，应先导出需要保留的存档。

| 现象 | 检查与处理 |
| --- | --- |
| 来源不被允许 | 同时检查目录 `allowedOrigins` 和站点 CSP；协议、主机、端口均需一致 |
| CORS 错误或读不到范围 | 检查允许来源与暴露响应头，包含错误响应也应正确返回 CORS 头 |
| 范围不匹配、整文件响应或重定向 | 修复资源服务的 Range 配置，清单指向最终文件地址 |
| 校验失败 | 确认镜像内容相同、禁用传输压缩或转换、重新生成对应版本清单 |
| 存储空间不足 | 清理不需要的数据并重试；浏览器配额与设备空闲空间不同，下载仍可能被配额阻止 |
| 另一个页面正在下载 | 返回持有下载任务的标签页，或结束其任务后重试，避免并发写同一文件 |
| 浏览器不支持低内存下载 | 需要 OPFS、Worker 同步文件访问和 Web Locks；可以改用本地游戏文件 |

下载完成不代表设备足以稳定运行模拟器。启动时的 Wasm 内存、图形资源和音频仍会占用设备内存；移动设备应单独验证长时间游玩表现。
