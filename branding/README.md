# PPSSPW 品牌资源

`ppsspw-symbol.svg` 以 PSP 的横向掌机轮廓、中央宽屏、左侧十字键与摇杆、右侧四键体现平台，并在屏幕中加入 PPSSPW 的 W。它是本项目绘制的图标；`ppsspw-wordmark.svg` 是对应的路径字标，不依赖系统字体。配色沿用播放器的深灰、浅蓝和白色。两份源稿按本项目 [GPLv3](../LICENSE) 发布。

安装网页依赖后运行 `npm --prefix wasm-page run icons`，生成网页图标、192/512 像素安装图标、32 像素标签页图标及模拟器使用的 `assets/ui_images/ppsspw.svg`。生成物入库，正式构建无需重新生成。Maskable 版本将整个符号收在中心安全区域内。

网页核心优先从自有图集读取 `I_ICON`、`I_ICON_GOLD` 和 `I_LOGO`；这些标识保持不变，以兼容已有 UI。原始 PPSSPP 图形作为上游源码保留，不用于网页产品标识。上游作者名单、版权、许可和组件来源继续保留。
