# 8 MiB 分窗、续传与中继契约

PPSSPW 通过三个显式契约隔离浏览器沙盒与原生模拟器的差异：本地镜像的 **8 MiB 分窗读盘代理**、远程镜像的 **HTTP Range + SHA-256 分块续传**，以及 **Ad Hoc WebSocket 二进制中继协议**。

## 1. 本地镜像 8 MiB 滑动窗口读取契约

1.5 GB 的 PSP 镜像若一次性读入 Emscripten `MEMFS`，会直接触发浏览器 32 位线性内存溢出。运行时的读取契约如下：

- **MEMFS 零字节存根守卫**：前端挂载本地文件时仅在 `/browser-games/<name>` 创建零字节只读存根；若任何旧版同步 POSIX `read()` 尝试访问，存根直接抛出 `ErrnoError(29)`（`EIO`）中断错误路径。
- **跨线程同步代理**：原生 `BrowserFileLoader::ReadAt`（`deps/ppsspp-wasm/Core/FileLoaders/BrowserFileLoader.cpp`）通过 `BrowserFileLibrary.js`（`__proxy: 'sync'`、`__async: 'auto'`）切回浏览器 JS 层的 `wasm-page/public/browser-files.js`。
- **主线程安全拒绝**：`BrowserFileLoader::ReadAt` 若检测到当前处于 `emscripten_is_main_runtime_thread()` 直接返回 `0`。因此 `deps/ppsspp-wasm/SDL/SDLMain.cpp` 的 `EmuThreadStart` 会在 `BrowserFileLoaderHasFiles()` 为真时强制把 `EmuThreadFunc` 派发至独立 pthread。
- **窗口与块上限**（`wasm-page/public/browser-files.js`）：

| 常量 | 默认值 | 职责与边界 |
| --- | --- | --- |
| `BLOCK_BYTES` | `256 KiB`（262,144 B） | `Blob.slice` 最小向底层拉取的缓存块 |
| `MAX_READ_BYTES` | `1 MiB`（1,048,576 B） | 单次向原生返回的连续读取切片上限 |
| `CACHE_BYTES` | `8 MiB`（8,388,608 B） | 浏览器端保留热块的 LRU 缓存总上限 |
| `READ_CONCURRENCY` | `4` | 同时在飞的异步 `Blob` 切片请求并发上限 |

## 2. 在线分块清单与 OPFS 断点续传契约

在线游戏来源由 `scripts/create-game-manifest.py` 生成标准 JSON（`schemaVersion: 1`），并由 `wasm-page/public/online-games.js`、`game-download.js` 与 `download-worker.js` 执行严格契约检查：

| 校验维度 | 硬性契约限制 | 违规时处理动作 |
| --- | --- | --- |
| 清单体积与镜像上限 | 清单 `<= 1 MiB`；游戏总大小 `<= 8 GiB` | 拒绝解析并提示清单超限 |
| 分块大小（`--chunk-size`） | `64 KiB` 至 `16 MiB`（默认 `4 MiB`） | 工具与网页校验共同拒绝越界分块 |
| 来源地址协议 | `1` 至 `6` 个来源 URL；仅允许 `https://`（`localhost` / `127.0.0.1` / `[::1]` 例外） | 明文 `http://` 公网源直接被过滤拒绝 |
| HTTP Range 响应 | 必须返回 `206 Partial Content`、空/`identity` 编码、无跨源跳转 | 服务端回退 `200 OK` 或 `gzip` 传输时立即中止 |
| 并发与完整性写盘 | `PpssppGameStorage.withShared` + `ppsspp-download-<fingerprint>` 独占 Web Lock；每块通过 SHA-256 才经 `createSyncAccessHandle()` 写入 `game-downloads/<fingerprint>/game.bin` 并更新 `resume.json` | 同指纹多标签并发写入自动阻塞互斥；哈希不一致不提交断点位图 |

## 3. Ad Hoc 中继协议与当前开关状态

> [!WARNING]
> **前端联机入口当前默认关闭**：在 `wasm-page/public/ppsspp-runtime.js` 第 31 行，`LOCAL_ONLY = true` 隐藏并禁用了 `app.html` 中的 `tabNetwork`（联机）与 `tabDrive`（云驱动）页签。下述协议适用于维护 `server/` 中继栈或自行调整前端开关的自托管构建。

原生开启 `g_Config.bEnableWlan`（编译配置 `PPSSPP_WASM_THREADED_ADHOC`）时，`EmuThreadStart` 同样将仿真核心调度至独立 pthread，由 `wasm-page/public/adhoc-transport.js` 通过 `wss://.../adhoc` 与 `server/relay.py` 交互。消息体以 3 字节 ASCII 魔数区分类型：

- `PRO`：客户端注册、协议版本检查及会话凭据握手；
- `PU1`：PSP Ad Hoc UDP 数据报按房间/端口/源目的地址转发；
- `PT1`：PSP Ad Hoc 虚拟 TCP 连接流式帧转发。

在鉴权模式下（`RELAY_AUTH_MODE=keys`），客户端需携带 `server/relay_admin.py` 生成的 `psp_<16位十六进制>.<43位urlsafe>` 令牌。`server/relay_auth.py` 计算 SHA-256 并以 `secrets.compare_digest` 校验 `/data/relay-auth.sqlite3` 中的有效行（未吊销、未过期）；不开放任何公网 HTTP 管理接口。

## 扩展与联机契约 FAQ

- **对象存储 CDN 可以开启自动 Gzip 压缩 `.iso` 吗？**
  不可以。`game-download.js` 依赖精确字节范围与逐块 SHA-256，检测到非 `identity` 的 `Content-Encoding` 或 `200 OK` 整包返回时会拒绝继续下载，以防范围偏移错位导致镜像损坏。
- **为什么 `BrowserFileLoader::ReadAt` 禁止在主线程调用？**
  JS 的 `File/Blob` 读取是异步 Promise，若仿真主循环运行在浏览器主线程再发起 `__proxy: 'sync'` 同步等待，会立即形成自己等自己的死锁。因此必须确保所有直读或联机运行处于独立 Emscripten pthread。
- **离线如何测试中继弱网重连？**
  运行 `server/tests/test_relay.py`、`wasm-page/tests/adhoc-transport.test.mjs`，或对 `server/relay.py` 注入环境变量 `RELAY_LATENCY_MS` 与 `RELAY_JITTER_MS` 模拟延迟与抖动。
