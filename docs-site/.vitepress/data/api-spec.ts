import type { ApiCatalogSpec } from './api-types';

export const apiSpecZh: ApiCatalogSpec = {
  project: 'PPSSPW · 8 MiB 分窗、OPFS 续传、隔离预览与中继协议参考',
  subtitle:
    '覆盖 BrowserFileLoader 分窗代理、HTTP 206 + SHA-256 分块清单生成与 OPFS 断点续传、COOP/COEP 静态宿主门禁，以及（当前前端默认 LOCAL_ONLY=true 隐藏的）Ad Hoc WebSocket 中继栈。',
  environments: [
    { label: '本地隔离预览服务 (serve-player.py)', value: 'http://127.0.0.1:17881' },
    { label: '自托管 HTTPS + WSS 站点示例', value: 'https://player.example.com' },
  ],
  searchPlaceholder: '搜索 BrowserFileLoader、manifest、206、COOP/COEP、PRO/PU1/PT1、relay_admin…',
  emptyText: '没有找到匹配的 PPSSPW 运行时组件、脚本或协议条目。',
  labels: {
    allGroups: '全部',
    canDo: '✅ 能做到',
    cannotDo: '⛔ 明确限制 / 不做什么',
    params: '常量、CLI 参数与响应头约束',
    paramName: '参数 / 常量 / 响应头',
    paramLocation: '作用域',
    paramType: '类型 / 默认值',
    paramRequired: '要求',
    paramDesc: '边界语义与报错阈值',
    responses: '状态响应与安全拦截',
    examples: '标准调用 / 启动示例',
    responseSample: '协议 / 输出示例',
    copy: '复制',
    copied: '已复制',
    noParams: '无额外参数。',
    required: '必填',
    optional: '可选',
    deepDocs: '查看契约与部署全文',
    totalItems: '组组件/接口',
    envLabel: '部署基址切换',
    mobilePicker: '切换组件或协议',
    defaultLabel: '默认',
    plainIndexToggle: '纯文本检索与打印索引（Ctrl+K 站内搜索定位）',
  },
  groups: [
    { id: 'runtime-storage', title: '8 MiB 分窗、OPFS 下载与性能节拍' },
    { id: 'hosting-preview', title: '跨源隔离预览、打包与 CI 门禁' },
    { id: 'adhoc-relay', title: 'Ad Hoc 中继协议与密钥工具' },
  ],
  items: [
    {
      id: 'browser-file-loader',
      group: 'runtime-storage',
      kind: 'FILE',
      title: '8 MiB 滑动窗口与跨线程读盘代理 (BrowserFileLoader)',
      signature: 'deps/.../BrowserFileLoader::ReadAt <-> wasm-page/public/browser-files.js',
      auth: '独立 Emscripten pthread（主线程调用返回 0）',
      stability: '核心运行时契约',
      summary:
        '仅在 MEMFS 挂载零字节只读存根 /browser-games/<name>，通过 Emscripten 同步代理（__proxy: sync）按 256 KiB 分块和 8 MiB LRU 窗口按需读取本地大镜像。',
      relatedLink: '/docs/contracts',
      relatedLabel: '查看 8 MiB 分窗契约',
      capabilities: [
        '零字节存根防止误走同步 POSIX read()，一旦触发立即抛出 ErrnoError(29) (EIO)',
        '支持 1.5 GiB+ 本地 .iso/.cso/.chd 免整包拷入 32 位 WASM 内存，单次连续切片上限 1 MiB、并发上限 4',
      ],
      limitations: [
        '严禁在 emscripten_is_main_runtime_thread() 主线程调用 ReadAt（会死锁异步 Blob.slice，实装直接返回 0）',
        '仓库、构建产物与已发布站点绝不内置任何 PSP 游戏镜像、BIOS 或下载源 URL',
      ],
      params: [
        {
          name: 'BLOCK_BYTES / MAX_READ_BYTES',
          location: 'config',
          type: '256 KiB / 1 MiB',
          required: true,
          description: '最小 Blob 缓存切片与单次返回原生连续字节上限。',
        },
        {
          name: 'CACHE_BYTES / READ_CONCURRENCY',
          location: 'config',
          type: '8 MiB / 4',
          required: true,
          description: '浏览器端热块 LRU 总上限与并行 Blob 读取数上限。',
        },
      ],
      responses: [
        {
          status: 'Pthread ReadAt -> 字节窗口命中',
          tone: 'ok',
          summary: '按需分页拉取并通过共享/代理缓冲区送入仿真核心。',
        },
        {
          status: '主线程 ReadAt -> 0 / MEMFS read() -> EIO (29)',
          tone: 'err',
          summary: '直接拦截主线程死锁及旧版整盘 MEMFS 读取路径。',
        },
      ],
      examples: [
        {
          label: '运行浏览器运行时与分窗离线单元测试',
          lang: 'sh',
          code: `pnpm --dir wasm-page test`,
        },
      ],
    },
    {
      id: 'manifest-and-opfs-resume',
      group: 'runtime-storage',
      kind: 'CLI',
      title: '分块下载清单生成与 OPFS 断点续传',
      signature: 'python3 scripts/create-game-manifest.py <image> --url https://... --out game.manifest.json',
      auth: 'HTTPS (localhost 例外) + HTTP 206 + SHA-256 + Web Locks',
      stability: '在线游戏分发契约',
      summary:
        '在不加载整镜像进内存的前提下切分生成 schemaVersion: 1 下载清单，并由专用 download-worker.js 经 Web Locks、Range 206 与逐块 SHA-256 校验落盘至 OPFS。',
      relatedLink: '/docs/deployment',
      relatedLabel: '查看清单生成参数与约束',
      capabilities: [
        '支持 .iso/.cso/.chd/.pbp（游戏镜像 <= 8 GiB，清单 JSON <= 1 MiB，1 至 6 个下载来源）',
        'OPFS 通过 PpssppGameStorage.withShared + ppsspp-download-<fingerprint> 互斥，多标签并发不损坏断点位图；每 30 秒 (PERSIST_SYNC_MS) 同步运行存档并用 1 MiB ZSTD 分块流式读档',
      ],
      limitations: [
        '分块大小必须落在 64 KiB 至 16 MiB（默认 4 MiB）；文件名禁止含路径分隔符、控制字符且 <= 255 字节',
        '严禁对象存储或 CDN 返回 HTTP 200 整包、非 identity Content-Encoding（如 gzip）或跨源重定向；除本机回环外一律拒绝明文 http://',
      ],
      params: [
        {
          name: '--url',
          location: 'flag',
          type: 'HTTPS URL (1..6 sources)',
          required: true,
          description: '无凭证、无 # fragment 的 HTTPS URL；明文 http 仅限 localhost / 127.0.0.1 / ::1。',
        },
        {
          name: '--chunk-size',
          location: 'flag',
          type: 'int (65536..16777216, def 4 MiB)',
          required: false,
          description: '分块尺寸（须匹配网页校验区间）。',
        },
        {
          name: '--out',
          location: 'flag',
          type: 'Path (.manifest.json)',
          required: true,
          description: '输出给「在线游戏」面板读取的分块 JSON 文件路径。',
        },
      ],
      responses: [
        {
          status: 'HTTP 206 Partial Content -> 校验落盘 OPFS',
          tone: 'ok',
          summary: '每块核验 SHA-256 后经 createSyncAccessHandle() 写入 game-downloads/<fp>/game.bin 并更新 resume.json。',
        },
        {
          status: '200 OK / gzip / 跨源跳转 -> 中止',
          tone: 'err',
          summary: '立即拒收并阻止写入断点位图，防止偏移错位损坏镜像。',
        },
      ],
      examples: [
        {
          label: '生成 4 MiB 分块清单 JSON',
          lang: 'sh',
          code: `python3 scripts/create-game-manifest.py /path/to/game.iso \\\n  --url https://static.example.com/psp/game.iso \\\n  --chunk-size 4194304 \\\n  --out ./game.manifest.json`,
        },
      ],
    },
    {
      id: 'runtime-perf-controls',
      group: 'runtime-storage',
      kind: 'EVENT',
      title: '渲染倍率、8 ms 音频泵与脱敏性能采样 (performance.js)',
      signature: 'WEB_NATIVE_TIMING_CONFIG + SP-shim AudioWorklet + info 面板 JSON 导出',
      auth: '跨源隔离下解锁 SAB / 否则退回 ScriptProcessor',
      stability: '运行时性能边界',
      summary:
        '锁定 512 MiB/4 GiB 线性内存、2 计算线程、mimalloc/USE_NO_MMAP 与 60 FPS RAF 节拍；支持 1x–3x 内部渲染倍率、60 ms 触控防粘连及按需脱敏性能 JSON 导出。',
      relatedLink: '/docs/performance',
      relatedLabel: '查看画质与性能调优文档',
      capabilities: [
        'SP-shim AudioWorklet 使用 16384 帧 SharedArrayBuffer 环形缓冲与 8 ms 定时校准（>= 70 ms 前瞻，欠载自适应扩展并在稳定 3 秒后回落）',
        'info 面板仅采样耗时/帧率原子快照，导出报告严格剔除游戏名称、访问 URL 与控制台日志；UI 按 720 阈值切换响应式分栏',
      ],
      limitations: [
        '1x–3x InternalResolution 仅放大 3D 几何渲染内部分辨率，不能超分或增强原始低分辨率 2D 贴图/UI',
        'scripts/ci/prepare-deploy.mjs 默认拒绝含 WASM_FRAME_TIMING 或 WASM_IR_BLOCK_PROFILE 的诊断核心进入生产构建（除非显式 --allow-diagnostics）',
        'Android 模拟器或受限软渲染器上曾测得的 3D 物体缺失数值仅作故障排查，不作为有效桌面/真机基线',
      ],
      params: [
        {
          name: 'InternalResolution',
          location: 'config',
          type: '1 | 2 | 3 (1x–3x)',
          required: false,
          description: '在设置面板调节 3D 内部分辨率倍率。',
        },
        {
          name: 'WASM_INITIAL_MEMORY / MAXIMUM',
          location: 'config',
          type: '512 MiB / 4 GiB',
          required: true,
          description: 'CMake 编译期锁定的浏览器 32 位线性寻址上下限（WASM_ENABLE_LTO=OFF）。',
        },
      ],
      responses: [
        {
          status: 'crossOriginIsolated === true -> 16384 SAB AudioWorklet',
          tone: 'ok',
          summary: '启用多线程 pthreads 与低拷贝音频泵。',
        },
        {
          status: '无隔离环境 -> 回退 32768 帧 ScriptProcessor / pthreads 阻塞',
          tone: 'warn',
          summary: '完整运行必须具备 COOP/COEP 响应头及安全上下文。',
        },
      ],
      examples: [
        {
          label: '使用诊断构建对比浏览器性能（仅开发机）',
          lang: 'sh',
          code: `node scripts/profile-browser.mjs --help\nnode scripts/compare-browser-performance.mjs --help`,
        },
      ],
    },
    {
      id: 'serve-player-headers',
      group: 'hosting-preview',
      kind: 'GET',
      title: 'COOP/COEP 预览服务、打包门禁与 EdgeOne 发布',
      signature: 'python3 server/serve-player.py [--bind ...] [--connect-origin ...]',
      auth: 'HTTPS (localhost/127.0.0.1 例外) + COOP + COEP + CORP',
      stability: '静态托管契约',
      summary:
        '为 wasm-page/dist/ppsspp-web/ 注入必需跨源隔离头、.wasm 流式编译 MIME 与 v16 Service Worker 无缓存策略；配套 Docker Compose 挂载容器与 CI 部署验签。',
      relatedLink: '/docs/deployment',
      relatedLabel: '查看预览、Docker 与 CI 规则',
      capabilities: [
        '默认在 127.0.0.1:17881 独占监听（禁用地址复用防旧进程抢端口），支持 --bind/--cert/--key 开启局域网 TLS 与 --connect-origin 放行特定 HTTPS 来源',
        '强制返回 COOP: same-origin、COEP: require-corp、CORP: same-origin、application/wasm 与 /sw.js / /build-info.json Cache-Control: no-cache',
      ],
      limitations: [
        'docker-compose.yml 仅静态挂载暴露已生成的 dist 目录，绝不在容器内重编译 C++/WASM 核心；源码编译须走 emsdk:6.0.12 或 scripts/ci/Dockerfile',
        '移动真机通过局域网明文 HTTP 无法解锁 SharedArrayBuffer 与 OPFS 同步写句柄（必须走 TLS HTTPS）',
      ],
      params: [
        {
          name: '--bind / --cert / --key',
          location: 'flag',
          type: 'host / PEM files',
          required: false,
          description: '局域网真机 HTTPS 验证参数。',
        },
        {
          name: '--connect-origin',
          location: 'flag',
          type: 'exact http(s) origin',
          required: false,
          description: '追加至 CSP connect-src，严禁通配符、路径、查询串或凭证。',
        },
      ],
      responses: [
        {
          status: '200 OK (window.crossOriginIsolated === true)',
          tone: 'ok',
          summary: '满足浏览器解锁 Emscripten pthreads 与 SharedArrayBuffer 条件。',
        },
      ],
      examples: [
        {
          label: '打包前端资源并启动本地隔离预览服务',
          lang: 'sh',
          code: `make app-build && python3 scripts/package-player.py\npython3 server/serve-player.py`,
        },
      ],
    },
    {
      id: 'adhoc-relay-protocol',
      group: 'adhoc-relay',
      kind: 'WS',
      title: 'Ad Hoc WebSocket 二进制中继协议 (PRO / PU1 / PT1)',
      signature: 'wss://.../adhoc · /healthz (默认 UI LOCAL_ONLY = true 隐藏)',
      auth: 'RELAY_AUTH_MODE=open 或 keys (psp_<16hex>.<43urlsafe>)',
      stability: '自托管中继组件',
      summary:
        '在独立 pthread 启用 bEnableWlan 时通过 WebSocket 转发 PSP 联机房间注册、UDP 数据报与虚拟 TCP 流；默认前端发行版第 31 行 LOCAL_ONLY = true 隐藏了网络与云盘面板。',
      relatedLink: '/docs/contracts',
      relatedLabel: '查看二进制帧格式细节',
      capabilities: [
        '以 3 字节 ASCII 魔数区分控制握手（PRO）、UDP 数据报转发（PU1）与虚拟 TCP 流转发（PT1）',
        '支持 open 匿名房间与 keys SQLite SHA-256 鉴权（secrets.compare_digest）；支持 RELAY_LATENCY_MS / JITTER_MS 弱网压测注入',
      ],
      limitations: [
        '默认网页构建（wasm-page/public/ppsspp-runtime.js:31）强制 LOCAL_ONLY = true，把 app.html 中的 tabNetwork 与 tabDrive 置于 hidden + inert 状态；公网免配联机默认关闭',
        '中继服务独立于静态播放器与文档站运行，单实例默认并发上限 RELAY_MAX_CONNECTIONS=512、心跳 RELAY_TIMEOUT=60s',
      ],
      params: [
        {
          name: 'RELAY_AUTH_MODE / RELAY_AUTH_DB',
          location: 'env',
          type: 'open | keys / /data/relay-auth.sqlite3',
          required: true,
          description: '决定匿名房间或强制校验用户会话密钥。',
        },
        {
          name: 'RELAY_LATENCY_MS / RELAY_JITTER_MS',
          location: 'env',
          type: 'int (default 0 / 0)',
          required: false,
          description: '弱网故障注入测试环境变量。',
        },
      ],
      responses: [
        {
          status: 'WSS Connected / /healthz 200 OK',
          tone: 'ok',
          summary: '正常转发房间内 PRO/PU1/PT1 二进制帧。',
        },
      ],
      examples: [
        {
          label: '启动中继容器与离线中继单元测试',
          lang: 'sh',
          code: `python3 -m unittest discover -s server/tests -p "test_*.py" -v\npnpm --dir wasm-page test`,
        },
      ],
    },
    {
      id: 'relay-admin-cli',
      group: 'adhoc-relay',
      kind: 'CLI',
      title: '本地 SQLite 中继密钥签发与吊销 (server/relay_admin.py)',
      signature: 'python3 server/relay_admin.py [--db /data/relay-auth.sqlite3] issue|list|revoke',
      auth: '容器 / 本机终端本地 CLI（无公网 HTTP 管理接口）',
      stability: '安全运维 CLI',
      summary:
        '仅通过本机命令行管理 RELAY_AUTH_MODE=keys 所用用户密钥，签发时明文仅显示一次，库内仅存 SHA-256 摘要，并支持按 ID 即时吊销与踢下线。',
      relatedLink: '/docs/deployment',
      relatedLabel: '查看中继部署与签发命令',
      capabilities: [
        'issue --user <u > [--ttl-hours <h>] 签发 psp_<16位hex>.<43位urlsafe> 密钥，明文只在响应打印一次',
        'list 仅输出 ID、用户、状态与过期时间（绝不回显明文或摘要）；revoke <id> 标记吊销并断开活跃连接',
      ],
      limitations: [
        '刻意不提供任何公网或局域网 HTTP 密钥管理端点，仅可通过服务端本机或 docker compose exec 调用',
      ],
      params: [
        {
          name: 'issue --user / --ttl-hours',
          location: 'flag',
          type: 'string / float',
          required: true,
          description: '指定所属玩家标识及可选有效小时数。',
        },
        {
          name: '--db',
          location: 'flag',
          type: 'Path (default RELAY_AUTH_DB)',
          required: false,
          description: 'SQLite 密钥数据库文件路径，默认 /data/relay-auth.sqlite3。',
        },
      ],
      responses: [
        {
          status: 'JSON Key Output (仅 issue 显示一次)',
          tone: 'ok',
          summary: '输出 key id、user 与 session_key。',
          example: `{ "id": "0123456789abcdef", "user": "player1", "session_key": "psp_0123456789abcdef.<43-urlsafe-chars>" }`,
        },
      ],
      examples: [
        {
          label: '容器内签发 72 小时会话密钥与查看列表',
          lang: 'sh',
          code: `docker compose exec relay python3 /app/server/relay_admin.py issue --user player1 --ttl-hours 72\ndocker compose exec relay python3 /app/server/relay_admin.py list`,
        },
      ],
    },
  ],
};

export const apiSpecEn: ApiCatalogSpec = {
  project: 'PPSSPW · Windowed Reader, OPFS Resume, COOP/COEP & Relay Reference',
  subtitle:
    'Verified runtime contracts for BrowserFileLoader (8 MiB LRU), HTTP 206 + SHA-256 game manifests, COOP/COEP preview servers, performance budgets, and the optional PRO/PU1/PT1 Ad Hoc relay.',
  environments: [
    { label: 'Local Isolated Preview (serve-player.py)', value: 'http://127.0.0.1:17881' },
    { label: 'Self-Hosted HTTPS + WSS Origin', value: 'https://player.example.com' },
  ],
  searchPlaceholder: 'Search BrowserFileLoader, manifest, 206, COOP/COEP, PRO/PU1/PT1, relay_admin…',
  emptyText: 'No matching PPSSPW component, CLI tool, or protocol item found.',
  labels: {
    allGroups: 'All',
    canDo: '✅ Supported Capabilities',
    cannotDo: '⛔ Explicit Limits / Non-Goals',
    params: 'Constants, CLI Flags & Header Gates',
    paramName: 'Name / Header',
    paramLocation: 'Scope',
    paramType: 'Type / Default',
    paramRequired: 'Required',
    paramDesc: 'Constraint & Failure Behavior',
    responses: 'Outcomes & Enforcement Rules',
    examples: 'Standard Usage Examples',
    responseSample: 'Sample Payload / Output',
    copy: 'Copy',
    copied: 'Copied',
    noParams: 'No additional parameters required.',
    required: 'Required',
    optional: 'Optional',
    deepDocs: 'Open Full Contracts & Deployment Docs',
    totalItems: 'components documented',
    envLabel: 'Origin Base',
    mobilePicker: 'Select component or protocol',
    defaultLabel: 'Default',
    plainIndexToggle: 'Plain-Text Index & Search Anchors (Ctrl+K searchable)',
  },
  groups: [
    { id: 'runtime-storage', title: '8 MiB Reader, OPFS Resume & Perf' },
    { id: 'hosting-preview', title: 'COOP/COEP Preview & Release Gates' },
    { id: 'adhoc-relay', title: 'Ad Hoc Relay & Local Admin CLI' },
  ],
  items: [
    {
      id: 'browser-file-loader',
      group: 'runtime-storage',
      kind: 'FILE',
      title: '8 MiB Windowed ISO Proxy (BrowserFileLoader)',
      signature: 'BrowserFileLoader::ReadAt <-> wasm-page/public/browser-files.js',
      auth: 'Dedicated Emscripten pthread only (main thread returns 0)',
      stability: 'Core Runtime Contract',
      summary:
        'Mounts zero-byte read-only MEMFS stubs at /browser-games/<name> (POSIX read() throws EIO 29) and proxies native ReadAt calls into 256 KiB slices capped by an 8 MiB LRU cache.',
      relatedLink: '/en/docs/contracts',
      relatedLabel: 'See 8 MiB Window Contract',
      capabilities: [
        'Streams 1.5 GB+ local .iso/.cso/.chd images lazily with MAX_READ_BYTES=1 MiB and READ_CONCURRENCY=4',
        'Fails loudly with ErrnoError(29) if legacy MEMFS read() paths execute instead of BrowserFileLoader::ReadAt',
      ],
      limitations: [
        'ReadAt returns 0 on emscripten_is_main_runtime_thread() to prevent deadlocking async Blob.slice calls',
        'Repository ships ZERO PSP ROMs, BIOS images, or manifest URLs; users must load their own legal images',
      ],
      params: [
        {
          name: 'BLOCK_BYTES / MAX_READ_BYTES',
          location: 'config',
          type: '256 KiB / 1 MiB',
          required: true,
          description: 'Slice fetch granularity and single native read upper bound.',
        },
        {
          name: 'CACHE_BYTES / READ_CONCURRENCY',
          location: 'config',
          type: '8 MiB / 4',
          required: true,
          description: 'In-browser hot-block LRU budget and max concurrent Blob slice reads.',
        },
      ],
      responses: [
        {
          status: 'pthread ReadAt -> 256 KiB Slice',
          tone: 'ok',
          summary: 'Serves requested offset ranges without exhausting 32-bit WASM linear RAM.',
        },
      ],
      examples: [
        {
          label: 'Run JS runtime and loader tests offline',
          lang: 'sh',
          code: `pnpm --dir wasm-page test`,
        },
      ],
    },
    {
      id: 'manifest-and-opfs-resume',
      group: 'runtime-storage',
      kind: 'CLI',
      title: 'Chunked Game Manifest Generator & OPFS Resumable Downloader',
      signature: 'python3 scripts/create-game-manifest.py <image> --url https://... --out game.manifest.json',
      auth: 'HTTPS (localhost excepted) + HTTP 206 + SHA-256 + Web Locks',
      stability: 'Manifest v1 Contract',
      summary:
        'Generates schemaVersion: 1 download manifests with per-chunk SHA-256 hashes verified by download-worker.js before flushing OPFS sync handles under Web Locks.',
      relatedLink: '/en/docs/contracts',
      relatedLabel: 'See Manifest & Range Rules',
      capabilities: [
        'Supports .iso/.cso/.chd/.pbp up to 8 GiB, manifest <= 1 MiB, 1..6 HTTPS URLs, and 30s PERSIST_SYNC_MS + 1 MiB ZSTD streaming savestates',
        'Serializes concurrent downloads per fingerprint via ppsspp-download-<fingerprint> Web Lock',
      ],
      limitations: [
        'Chunk sizes outside 64 KiB–16 MiB (default 4 MiB) and filenames > 255 bytes or with paths are rejected',
        'Rejects non-localhost http://, 200 OK full responses, compressed Content-Encoding (gzip/br), and cross-origin redirects',
      ],
      params: [
        {
          name: '--url / --chunk-size / --out',
          location: 'flag',
          type: 'HTTPS URL / 64KiB..16MiB / Path',
          required: true,
          description: 'Origin URL (up to 6), chunk size (default 4 MiB), and output manifest path.',
        },
      ],
      responses: [
        {
          status: 'HTTP 206 + SHA-256 Verified -> OPFS',
          tone: 'ok',
          summary: 'Persists chunks to game-downloads/<fingerprint>/game.bin and resume.json.',
        },
      ],
      examples: [
        {
          label: 'Generate a 4 MiB chunked manifest',
          lang: 'sh',
          code: `python3 scripts/create-game-manifest.py /path/to/game.iso --url https://static.example.com/psp/game.iso --chunk-size 4194304 --out ./game.manifest.json`,
        },
      ],
    },
    {
      id: 'runtime-perf-controls',
      group: 'runtime-storage',
      kind: 'EVENT',
      title: '1x–3x Scaling, 8 ms AudioWorklet & Sanitized Telemetry',
      signature: 'WEB_NATIVE_TIMING_CONFIG + SP-shim + performance.js',
      auth: 'crossOriginIsolated unlocks SAB; falls back to ScriptProcessor',
      stability: 'Runtime Tuning',
      summary:
        'Locks 512 MiB/4 GiB WASM memory, mimalloc/USE_NO_MMAP, and 60 FPS RAF sync; provides 1x–3x 3D internal scaling, 8 ms SP-shim audio pump, and sanitized Info JSON exports.',
      relatedLink: '/en/docs/contracts',
      relatedLabel: 'Open Contracts & Tuning',
      capabilities: [
        'SP-shim maintains a 16384-frame SharedArrayBuffer ring at 8 ms intervals with >= 70 ms lookahead',
        'Exports FPS, speed, ISO read latency, and audio underrun telemetry stripped of titles, URLs, and logs',
      ],
      limitations: [
        '1x–3x InternalResolution scales 3D geometry only — it does NOT upscale low-resolution 2D textures/sprites',
        'CI gate prepare-deploy.mjs rejects diagnostic WASM_FRAME_TIMING / WASM_IR_BLOCK_PROFILE builds from production unless --allow-diagnostics is passed',
      ],
      params: [
        {
          name: 'InternalResolution',
          location: 'config',
          type: '1 | 2 | 3 (1x–3x)',
          required: false,
          description: 'Adjusts 3D rendering multiplier inside the Settings tab.',
        },
      ],
      responses: [
        {
          status: 'Sanitized JSON / 60ms Touch Floor',
          tone: 'ok',
          summary: 'Keeps responsive 720-threshold tabs and deterministic touch input timing.',
        },
      ],
      examples: [
        {
          label: 'Run browser performance diagnostic helper (dev machine)',
          lang: 'sh',
          code: `node scripts/profile-browser.mjs --help`,
        },
      ],
    },
    {
      id: 'serve-player-headers',
      group: 'hosting-preview',
      kind: 'GET',
      title: 'COOP/COEP Preview Server & Deployment Header Gates',
      signature: 'python3 server/serve-player.py [--bind ...] [--connect-origin ...]',
      auth: 'HTTPS (localhost/127.0.0.1 excepted) + COOP + COEP + CORP',
      stability: 'Hosting Prerequisite',
      summary:
        'Serves wasm-page/dist/ppsspp-web/ on 127.0.0.1:17881 (exclusive bind) with mandatory COOP/COEP/CORP headers, application/wasm MIME, and no-cache for /sw.js (v16).',
      relatedLink: '/en/docs/deployment',
      relatedLabel: 'See Deployment & Headers Guide',
      capabilities: [
        'Supports --bind/--cert/--key for mobile LAN TLS debugging and --connect-origin for strict CSP connect-src allowlisting',
        'Companion docker-compose.yml mounts prebuilt dist without invoking emsdk in runtime containers',
      ],
      limitations: [
        'Mobile devices fail SharedArrayBuffer and OPFS sync handles over plaintext LAN HTTP — HTTPS is mandatory outside localhost',
        'Full WASM rebuilds require Linux/WSL + emsdk:6.0.12 (scripts/ci/Dockerfile)',
      ],
      params: [
        {
          name: '--bind / --cert / --key / --connect-origin',
          location: 'flag',
          type: 'CLI flags (exact origins only)',
          required: false,
          description: 'Configures TLS binding and strict wildcard-free CSP origins.',
        },
      ],
      responses: [
        {
          status: 'window.crossOriginIsolated === true',
          tone: 'ok',
          summary: 'Unlocks multi-threaded Emscripten pthreads and AudioWorklet SAB.',
        },
      ],
      examples: [
        {
          label: 'Package player artifacts and launch isolated preview',
          lang: 'sh',
          code: `make app-build && python3 scripts/package-player.py\npython3 server/serve-player.py`,
        },
      ],
    },
    {
      id: 'adhoc-relay-protocol',
      group: 'adhoc-relay',
      kind: 'WS',
      title: 'Ad Hoc WebSocket Relay Framing (PRO / PU1 / PT1)',
      signature: 'wss://.../adhoc · /healthz (Hidden behind LOCAL_ONLY = true in UI)',
      auth: 'RELAY_AUTH_MODE=open | keys (psp_<16hex>.<43urlsafe>)',
      stability: 'Optional Self-Hosted Stack',
      summary:
        'Proxies PSP multiplayer rooms (PRO), UDP frames (PU1), and TCP streams (PT1) over WebSockets with open or SQLite-backed keys auth; hidden by default in UI via LOCAL_ONLY = true.',
      relatedLink: '/en/docs/contracts',
      relatedLabel: 'See Relay Protocol Details',
      capabilities: [
        'Enforces configurable RELAY_MAX_CONNECTIONS (512), RELAY_TIMEOUT (60s), and RELAY_LATENCY_MS / RELAY_JITTER_MS test injection',
      ],
      limitations: [
        'wasm-page/public/ppsspp-runtime.js:31 sets LOCAL_ONLY = true, keeping tabNetwork and tabDrive hidden+inert in default releases',
      ],
      params: [
        {
          name: 'RELAY_AUTH_MODE / RELAY_MAX_CONNECTIONS',
          location: 'env',
          type: 'open|keys / 512',
          required: true,
          description: 'Controls key enforcement and single-instance concurrent WebSocket capacity.',
        },
      ],
      responses: [
        {
          status: 'WSS Frame Relay / /healthz 200',
          tone: 'ok',
          summary: 'Routes PRO/PU1/PT1 room traffic when enabled on self-hosted builds.',
        },
      ],
      examples: [
        {
          label: 'Run relay unit tests',
          lang: 'sh',
          code: `python3 -m unittest discover -s server/tests -p "test_*.py" -v`,
        },
      ],
    },
    {
      id: 'relay-admin-cli',
      group: 'adhoc-relay',
      kind: 'CLI',
      title: 'Local SQLite Relay Credential CLI (server/relay_admin.py)',
      signature: 'python3 server/relay_admin.py [--db /data/relay-auth.sqlite3] issue|list|revoke',
      auth: 'Local CLI only (Zero public HTTP admin endpoints)',
      stability: 'Admin CLI',
      summary:
        'Issues psp_<16hex>.<43urlsafe> session tokens once to stdout, stores SHA-256 digests in SQLite for constant-time secrets.compare_digest checks, and revokes keys locally.',
      relatedLink: '/en/docs/deployment',
      relatedLabel: 'See Relay Deployment Steps',
      capabilities: [
        'issue (--user, --ttl-hours), list (never prints secrets), and revoke <id> with live socket disconnect',
      ],
      limitations: [
        'Intentionally exposes zero HTTP key-management endpoints; requires container or host shell access',
      ],
      params: [
        {
          name: '--db / issue --user / --ttl-hours',
          location: 'flag',
          type: 'Path / string / float',
          required: true,
          description: 'SQLite store path and user token expiry parameters.',
        },
      ],
      responses: [
        {
          status: 'JSON Key (printed once) / Revoked',
          tone: 'ok',
          summary: 'Issues or revokes hashed tokens safely without plaintext storage.',
        },
      ],
      examples: [
        {
          label: 'Issue a 72-hour key inside the relay container',
          lang: 'sh',
          code: `docker compose exec relay python3 /app/server/relay_admin.py issue --user player1 --ttl-hours 72`,
        },
      ],
    },
  ],
};
