# 8 MiB 分窗读取与断点下载恢复

浏览器的 `File` 与原生随机 `ReadAt` 接口在内存和线程模型上并不兼容：1.5 GB 的 PSP 镜像不能一次读入 `MEMFS` 堆内存，也不能在主线程同步阻塞等待网络或磁盘读取。因此本仓库把游戏来源拆成“8 MiB 滑动窗口按需读取”和“SHA-256 分块校验写入 OPFS 缓存”两条并列机制，分别服务本地直选镜像与在线分块清单。

## 本地 8 MiB 窗口与跨线程代理边界

当玩家选择本地 `.iso`/`.cso`/`.chd` 文件时，运行脚本先在 `MEMFS` 的 `/browser-games/` 下挂载一个仅暴露文件尺寸、没有真实载荷的零字节存根文件；若任何原生旧路径尝试用传统 POSIX `read()` 直接读取，存根立即抛出 `ErrnoError(29)`（`EIO`）中断错误路径，迫使全部镜像读取改走 `BrowserFileLoader`。

原生核心调用 `BrowserFileLoader::ReadAt` 后，请求经 Emscripten `BrowserFileLibrary.js`（`__proxy: 'sync'`、`__async: 'auto'`）切回浏览器层 `wasm-page/public/browser-files.js`。浏览器侧用 256 KiB（`BLOCK_BYTES`）为缓存块粒度，最多同时维持 4 路并发读取（`READ_CONCURRENCY = 4`），按单次不超过 1 MiB（`MAX_READ_BYTES`）的上限拼装并返回给核心；近期热点块留在最大 8 MiB（`CACHE_BYTES`）的 LRU 窗口中，避免整盘拷贝撑爆 32 位 WASM 地址空间。

- **正常路径**：`SDLMain.cpp` 中的 `EmuThreadStart` 检测到 `BrowserFileLoaderHasFiles()` 为真后，将 `EmuThreadFunc` 放进独立 pthread 执行。`ReadAt` 在工作线程发起后挂起等待主线程完成异步 `Blob.slice().arrayBuffer()`，再复制结果返回。
- **拒绝边界**：若 `BrowserFileLoader::ReadAt` 在 Emscripten 主运行时线程（`emscripten_is_main_runtime_thread()`）中被直接调用，C++ 侧会立即返回 `0`，防止主线程阻塞引发代理死锁；单次读取请求若跨越无效偏移或超出 `8 MiB` 安全范围，ISO 元数据预读逻辑同样直接抛错拒绝。

```cpp
// deps/ppsspp-wasm/Core/FileLoaders/BrowserFileLoader.cpp
// 主线程禁止同步等待异步文件读取；仿真核心必须运行在独立 pthread（EmuThreadStart）
if (emscripten_is_main_runtime_thread()) {
  return 0;
}
```

## 在线分块清单、HTTP Range 校验与 OPFS 断点续传

当游戏来自远程清单文件时，构建工具 `scripts/create-game-manifest.py` 会把原始镜像按 64 KiB 至 16 MiB（默认 4 MiB）切分并生成每块 SHA-256 摘要，限制单游不超过 8 GiB、清单 JSON 不超过 1 MiB，以及 1 到 6 个来源 URL（除 `localhost` / `127.0.0.1` / `[::1]` 外一律要求 `HTTPS`）。

玩家触发下载后，前端通过 `PpssppGameStorage.withShared` 获取共享读锁，并在独立下载锁 `ppsspp-download-<fingerprint>` 保护下把写入权交给 Dedicated Worker（`wasm-page/public/download-worker.js`）。Worker 仅针对进度文件 `resume.bin` 中尚未标记完成的块发起 HTTP `Range` 请求，每次拿到分块先算 SHA-256 并比对清单摘要，确认一致后才通过 OPFS 的 `createSyncAccessHandle()` 顺序刷入 `game-downloads/<fingerprint>/game.bin` 并更新位图；全部完成并核验文件总大小后，正式镜像仍交回 `BrowserFileLoader` 按 8 MiB 窗口挂载启动。

- **正常与边界示例**：
  - **允许路径**：服务端返回 `206 Partial Content`、`Content-Encoding` 为空或 `identity`、未发生跨来源跳转且分块 SHA-256 与清单一致 -> 写入 `game.bin` 并刷盘，随后在 `resume.bin` 中写入该块对应的一个字节。新版日志发布中断后，仍可从与镜像指纹、块数及载荷尺寸相符的旧版 `resume.json` 恢复。单块不超过 1 MiB 时，工作线程直接在有界缓冲区内校验。更大的块流入临时文件，完整性校验通过后再提交。续传会先清除本次下载遗留的临时块，再按实际缺块的长度和并发数估算临时空间。只剩一个小尾块时，只需为载荷增长和固定余量预留磁盘空间。已完成的镜像只读打开。
  - **拒绝路径**：服务端退回 `200 OK` 整包响应、返回 `gzip` 压缩传输、发生非预期重定向，或浏览器标签页并发写入同一指纹目录（Web Lock 冲突）-> 立即中止当前块提交，保留已校验前缀等待重试。

```sh
# 为本地镜像生成默认 4 MiB 分块的部署清单（默认约束 1~6 个 HTTPS 源）
python3 scripts/create-game-manifest.py path/to/game.iso \
  --url https://cdn.example.com/games/game.iso \
  --out wasm-page/public/assets/game.manifest.json
```

## 源码职责与验证归口

本机制跨越 Emscripten 文件加载器与前端 OPFS/Worker 两层边界，各自职责集中在四个关键区域：原生边界见 `deps/ppsspp-wasm/Core/FileLoaders/BrowserFileLoader.cpp` 与 `deps/ppsspp-wasm/SDL/SDLMain.cpp`，滑动缓存见 `wasm-page/public/browser-files.js`，在线清单与断点续传见 `wasm-page/public/online-games.js`、`wasm-page/public/game-download.js` 与 `wasm-page/public/download-worker.js`，清单生成器见 `scripts/create-game-manifest.py`。

打开「本机存储」时才会统计分块下载文件。游玩期间关闭面板会跳过逐文件枚举。清空本机数据会在游戏库独占锁内一起清理这些文件。

对应的离线与合约回归分别由 `wasm-page/tests/browser-files.test.mjs`、`wasm-page/tests/game-download.test.mjs`、`wasm-page/tests/online-games.test.mjs` 与 `server/player-tests/test_game_manifest.py` 覆盖。如需追溯代码目录或观察一次完整启动如何衔接挂载流程，继续阅读[按职责定位源码](../code-map.md)与[本地文件启动主流程](../walkthroughs/one-real-run.md)。

证据状态：除特别标注外，本页基于当前源码已确认。
