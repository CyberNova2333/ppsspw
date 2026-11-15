# Ad Hoc 多人联机中继协议与前端开关边界

PSP 原生 Ad Hoc 局域网联机在浏览器沙盒里无法直接发送原始 UDP/TCP 套接字报文，因此本仓库保留了完整的 WebSocket 二进制中继栈与口令鉴权服务；但在当前默认前端构建中，网页运行入口以本地离线优先为前提，显式关闭了联机面板与云端驱动入口。阅读或维护多人功能时，必须先分清“前端开关当前状态”与“底层中继协议实现”。

## 当前前端开关与多线程启用条件

在 `wasm-page/public/ppsspp-runtime.js` 第 31 行，常量 `LOCAL_ONLY = true` 控制着外部网络与云集成功能的总闸。相应地，`wasm-page/src/app/app.html` 将 `tabNetwork`（联机页签）和 `tabDrive`（云存档页签）整体包裹在带有 `hidden`、`inert` 与 `aria-hidden="true"` 属性的 `.legacy-integrations` 容器内，防止未配置外部后端时向玩家暴露不可用按钮。

与此同时，底层 WASM 编译选项默认保留联机桥接与多线程派发逻辑：当原生核心开启 `g_Config.bEnableWlan`（或存在浏览器镜像文件）时，`deps/ppsspp-wasm/SDL/SDLMain.cpp` 的 `EmuThreadStart` 会把 `EmuThreadFunc` 调度到独立 pthread（`PPSSPP_WASM_THREADED_ADHOC`），前端 `wasm-page/public/adhoc-transport.js` 负责按二进制帧把原生套接字调用转发给 `wss://.../adhoc` 中继服务。

## WebSocket 二进制帧与 SQLite 鉴权契约

中继服务端由 `server/relay.py`、`server/relay_auth.py` 与 `server/relay_admin.py` 组成，并通过 `deploy/relay/` 下的 Caddy 反向代理提供 `/healthz` 与 `/adhoc` 端点。所有中继流量采用 3 字节帧头魔数区分连接阶段与载荷类型：

| 帧头魔数 | 用途 | 核心校验与处理规则 |
| --- | --- | --- |
| `PRO` | 客户端注册 / 鉴权握手 | 校验协议版本与房间标识；在 `RELAY_AUTH_MODE=keys` 下校验会话令牌 |
| `PU1` | PSP Ad Hoc UDP 报文转发 | 按房间、端口与源/目的 MAC 映射转发，受单连接限额约束 |
| `PT1` | PSP Ad Hoc TCP 流式转发 | 维护房间内点对点虚拟会话帧序与断开清理 |

访问控制由环境变量 `RELAY_AUTH_MODE`（`open` 或 `keys`）决定：当切换为 `keys` 模式时，用户密钥遵循 `psp_<16位十六进制>.<43位urlsafe>` 格式，服务端按唯一 ID 查找 `/data/relay-auth.sqlite3` 中存储的 SHA-256 摘要，并结合 `secrets.compare_digest`、`expires` 与 `revoked` 字段做常时间校验。密钥签发与吊销只能通过容器/本机 CLI `server/relay_admin.py` 执行，服务端刻意不暴露 HTTP 管理接口，避免公网误触管理端点。

- **正常与拒绝示例**：
  - **允许连接**：客户端携带有效密钥完成 `PRO` 握手，且当前并发连接未超过 `RELAY_MAX_CONNECTIONS=512` -> 加入目标房间并按 `PU1`/`PT1` 互通报文。
  - **拒绝并断开**：`RELAY_AUTH_MODE=keys` 下密钥格式非法、数据库行已标记 `revoked` 或已过有效期 -> 抛出 `AuthError('relay authentication required')` 并立即关闭 WebSocket 连接。

```sh
# 在自托管中继容器内通过本地 CLI 签发与吊销用户会话密钥
python3 server/relay_admin.py issue --user alice --ttl-hours 24
python3 server/relay_admin.py list
python3 server/relay_admin.py revoke <key_id>
```

## 验证工具与环境注入

虽然当前生产构建的页面 UI 默认处于 `LOCAL_ONLY = true` 状态，中继服务栈本身配有独立单元测试与故障注入手段：环境变量 `RELAY_LATENCY_MS` 与 `RELAY_JITTER_MS` 可人为模拟高延迟与抖动，配合 `server/tests/test_relay.py`、`server/tests/test_relay_auth.py`、`wasm-page/tests/adhoc-transport.test.mjs` 以及浏览器双端测试脚本 `scripts/test-multiplayer-browser.mjs` 验证断线重连和权限边界。若要排查部署与容器启停入口，继续查看[按职责定位源码](../code-map.md)与[运行时节拍与浏览器稳定性边界](runtime-perf-and-stability.md)。

证据状态：除特别标注外，本页基于当前源码已确认。
