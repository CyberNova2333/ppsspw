# 虚拟触控手柄与多端视口适配

移动端与窄屏浏览器既不能把全部操作挤在原生设置侧栏，也不能因为视口旋转或捏合缩放而锁死按键按下状态。这一模块通过三层协作解决触控防误触与自适应排版：网页触控层负责指针防抖和虚拟摇杆零点重置，CSS 控制紧凑重排，原生 SDL 与 `TabbedDialogScreen` 负责在画布尺寸变化时同步 DPI 与原生设置栏布局。

## 编辑屏幕手柄

「画质与操作 → 编辑键位」和全屏游玩菜单中的「编辑键位」打开同一个编辑器。内置布局按设备尺寸排布，首次编辑会以当前设备的键位为起点。选中预览中的控件后可以拖动，或输入水平、垂直百分比；尺寸以 CSS 像素计。新增按钮可绑定 PSP 动作或键盘键。十字键可以整组移动和缩放，也可拆开单独编辑四个方向。键盘绑定沿用模拟器当前的键盘映射。

「保存并使用」会把命名预设及当前选项写入本网站的本机存储，立即用于游玩。编辑已有预设时可用「另存为」保留两套布局；取消会丢弃当前草稿。切回「内置布局」可恢复自适应排布。清除网站数据会移除预设。复验保存、切换、移除和写入失败可对本地预览运行 `uv run --script scripts/test-pad-presets-browser.py "$player_url" --chromium "$chromium"`。[编辑器与存储](../../wasm-page/public/pad-presets.js) · [浏览器回归](../../scripts/test-pad-presets-browser.py)

## 触控输入防误触、摇杆零点与取消保护

`wasm-page/public/touch-controls.js` 独立管理屏幕十字键（D-pad）、动作键肩键与模拟摇杆，并把实时状态经 `getSDLGamepads` 暴露给运行时注入原生 SDL 输入轮询。与常见直接透传 `pointerdown/pointerup` 的做法不同，虚拟手柄刻意保留两类输入约束：

- **最小时长保底**：普通点按操作会维持至少 `60 ms` 的有效按下窗口，避免高频轻触被模拟器的单帧轮询周期直接吞掉。
- **独立指针与换向释放**：摇杆在每次重新按下时以落点位置作为当次运动零点；十字键在同一指针滑动换向时，只释放该指针此前占用的旧方向键，不影响另一根手指同时按住的组合键。

```js
// wasm-page/public/touch-controls.js：尺寸重算前先取消悬挂手势，防止按键卡死
window.addEventListener('resize', () => {
  controller.cancelAll();
  controller.refreshGeometry();
});
```

- **正常与边界示例**：
  - **正常手势**：左手在摇杆区滑动、右手点击 `Cross` 键 -> 摇杆按相对位移输出归一化坐标，动作键在松手时确保至少经历 `60 ms` 后释放。
  - **中断边界**：浏览器触发 `blur`、切后台或横竖屏切换派发 `ppsspp-player-layout` -> 立即调用 `cancelAll()` 清空所有活跃指针与按键，并重新测量按钮与摇杆命中区域，杜绝“长按漂移卡键”。

## 画布通知、SDL DPI 刷新与 720 阈值栏目切换

桌面缩放、移动横竖屏切换或侧栏开合时，页面通过 `wasm-page/public/ppsspp-runtime.js` 中的 `syncViewportSize` 与 `installCanvasResizeTracking` 把真实画布像素边界送达原生层。这一步必须在顺序上严格把关：

1. `deps/ppsspp-wasm/SDL/SDLMain.cpp` 收到 `SDL_WINDOWEVENT_SIZE_CHANGED` 时，必须先执行 `UpdateScreenDPI`，再去刷新显示边界；若颠倒顺序，原生 UI 缩放比例会在高分屏上按旧 DPI 计算。
2. 网页侧边栏及面板按钮在 `wasm-page/src/player-controls.css` 下响应宽高媒体查询并调整触控键帽布局；原生设置菜单则由 `deps/ppsspp-wasm/UI/TabbedDialogScreen.cpp` 在 `UseHorizontalTabs` 中依据核心有效宽度 `720`（核心 UI 单位）动态在顶部水平栏目与左侧栏之间切换，并通过 `TabHolder.cpp` 与 `UIScreen.cpp` 保留滚动和搜索过滤状态。

上述行为均已沉淀为离线回归夹具与独立校验脚本：`wasm-page/tests/touch-controls.test.mjs`、`wasm-page/tests/orientation.test.mjs`、`scripts/test-sdl-viewport.py`（配合 `wasm-page/tests/sdl-viewport.cpp`）和 `scripts/test-tabbed-layout.py`（配合 `wasm-page/tests/tabbed-layout.cpp`）。需注意脚本断言不能代替真机触控手感评估，更完整的启动交接请看[本地文件启动主流程](../walkthroughs/one-real-run.md)或查[按职责定位源码](../code-map.md)。

证据状态：除特别标注外，本页基于当前源码已确认。
