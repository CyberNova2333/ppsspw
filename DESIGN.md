# 设计系统指南：PPSSPW 掌机硬件触感设计系统

## 1. 视觉主题与设计哲学

PPSSPW 是基于 WebAssembly 构建的非官方 PSP 网页模拟器与存档管理工作台。其设计语言立足于 **GitHub Primer 功能主义架构**，深度汲取经典掌上游戏机硬件工业美学，打造 **复古掌机硬件工业与磨砂触感设计系统（Retro Console Hardware & Matte Tactile Aesthetics）**。

整体设计拒绝廉价光滑的扁平塑料感，强调：
- **磨砂工程塑料微质感底衬（Matte Industrial Plastic Texture）**：以深色画布（`#010409` / `#0d1117`）还原掌机实体外壳的专注沉浸感；在浅色模式下提供舒缓温润的控制台与归档阅读体验。
- **实体导电胶微拟物按键（Tactile Mechanical Click Buttons）**：桌面端控制按钮与移动端虚拟按键具备真实的物理键帽分层、倒角微高光描边与按压下沉反馈（`:active` 时 `scale(0.985)` 与内凹阴影 `inset 0 2px 4px`），带来类似真实掌机按键触碰的物理回弹体验。
- **倒角边缘高光（Chamfered Bezel Highlight）**：模拟器外框、设置抽屉与按键边缘具备细微的定向物理光泽（`inset 0 1px 0 rgba(255, 255, 255, 0.08)`），还原精密模具冲压倒角。
- **掌机视口黄金舞台（16:9 Console Stage）**：中央舞台严格按 `16:9` 黄金比例呈现 PSP 真实画质视口，未载入时呈现清晰的引导说明，载入时周围自动下沉为暗部沉浸防反光暗场。
- **动态呼吸光效与昼夜流体联动（Luminous Aura & DayNightSwitch）**：集成物理弹簧阻尼开关，支持深浅模式自适应与丝滑光影过渡。

---

## 2. 调色板与语义令牌

PPSSPW 采用 GitHub Primer 规范变量体系，并由动态主题系统驱动：

### 2.1 画布层级（Canvas Hierarchy）
| 变量名 | 深色模式（掌机沉浸） | 浅色模式（控制台白） | 物理质感与典型用途 |
| :--- | :--- | :--- | :--- |
| `canvas.inset` / `--bg` | `#010409` | `#f6f8fa` | 页面底层暗场、模拟器舞台防反光边框 |
| `canvas.default` / `--surface` | `#0d1117` | `#ffffff` | 顶部导航栏、功能主卡片、侧面板主背景 |
| `canvas.subtle` / `--surface2` | `#161b22` | `#f6f8fa` | 设置卡片表头、功能悬停底色、辅助面板 |
| `canvas.muted` / `--surface3` | `#21262d` | `#eaeef2` | 默认按键底色、输入框与标签底槽 |

### 2.2 前景与文本（Foreground & Text）
| 变量名 | 深色模式 | 浅色模式 | 典型用途 |
| :--- | :--- | :--- | :--- |
| `--text` / `fg.default` | `#f0f6fc` | `#1f2328` | 主标题、引导正文、按钮文字 |
| `--muted` / `fg.muted` | `#8b949e` | `#656d76` | 副标题、手柄状态提示、帧率统计元数据 |
| `--accent` / `accent.fg` | `#2f81f7` | `#0969da` | 焦点环、高亮选项、手柄键帽激活高光 |
| `--accent2` / `accent.emphasis` | `#1f6feb` | `#0550ae` | 开始游戏实心主操作按键 |

### 2.3 物理边框与双层光影（Tactile Shadows & Borders）
- **结构边框**：深色 `#21262d` / `#30363d` · 浅色 `#d0d7de`（`1px solid`）
- **按键倒角微高光**：
  - 深色：`inset 0 1px 0 rgba(255, 255, 255, 0.08)`
  - 浅色：`inset 0 1px 0 rgba(255, 255, 255, 0.6)`
- **按压下凹阴影（Pressed State）**：`inset 0 2px 4px rgba(0, 0, 0, 0.32)`
- **悬浮投影（Floating Elevation）**：
  - 深色：`0 8px 24px rgba(1, 4, 9, 0.65), 0 0 0 1px rgba(255, 255, 255, 0.04)`
  - 浅色：`0 8px 24px rgba(140, 149, 159, 0.2)`

---

## 3. 核心触感组件规范

### 3.1 实体触感按键（Tactile Hardware Buttons）
- **常规控制按键（`button` / `.btn`）**：
  - 背景：`linear-gradient(180deg, var(--surface3) 0%, var(--surface2) 100%)`
  - 边框：`1px solid var(--btn-border)`，外加微倒角高光。
  - 悬停：`transform: translateY(-0.5px)`，高光稍微加强。
  - 按下反馈：`transform: translateY(0.5px) scale(0.985); box-shadow: inset 0 2px 4px rgba(0, 0, 0, 0.25);`
- **主要执行按键（`button.primary`）**：
  - 掌机绿实心渐变：`linear-gradient(180deg, #2ea043 0%, #238636 100%)`
  - 按下时下沉并呈现物理弹性。

### 3.2 屏幕触摸虚拟按键（Touch Gamepad Keycaps）
- **键帽（Keycap Layer）**：半透明微磨砂双层结构（`--pad-key: linear-gradient(180deg, rgba(33, 38, 45, 0.85), rgba(13, 17, 23, 0.88))`）。
- **十字键与摇杆圆盘**：中间带有圆形微凹陷物理光影指示，边缘带微弱发光光晕。
- **按下动效（`is-pressed`）**：`transform: scale(0.94);` 触发蓝色发光边缘与下凹内阴影。

### 3.3 侧边抽屉面板（Side Drawer）
- **外框与阴影**：右侧平滑滑出，带 `0 8px 32px rgba(1, 4, 9, 0.85)` 深度阴影。
- **卡片槽位**：游戏列表项采用条目化分层，包含 ROM 格式、文件大小与存档时间戳。

---

## 4. 排版与等宽数据对齐

- **主字体栈**：`"IBM Plex Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`
- **等宽数据栈**：`ui-monospace, SFMono-Regular, "SF Mono", monospace`，应用于 FPS 帧率计数、内存占用率与 OPFS 存储容量显示，启用 `font-variant-numeric: tabular-nums`。

---

## 5. 微动效与性能保障

- **零掉帧原则**：所有主交互动效（抽屉滑入、虚拟按键响应、全屏缩放）严格约束在 GPU 合成层（`transform` 与 `opacity`），不得触发主线程重排（reflow），确保 60FPS 游戏画面渲染零卡顿。
