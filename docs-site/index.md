---
layout: home
repoGuideSource: "repo-docs/README.md"

hero:
  name: PPSSPW
  text: WebAssembly PSP 仿真器前端与运行沙盒
  tagline: 基于 Angular 与 Emscripten/WASM，支持浏览器直接挂载玩家持有 ISO/CSO 镜像并畅快运行。
  actions:
    - theme: brand
      text: 开启文档阅读
      link: /walkthroughs/one-real-run
    - theme: alt
      text: 架构代码地图
      link: /code-map
    - theme: alt
      text: GitHub 仓库
      link: https://github.com/CyberNova2333/ppsspw

features:
  - title: 纯浏览器端沙盒仿真
    details: 无需安装本地模拟器应用，借助现代浏览器 WebAssembly 与 WebGL/WebGPU 硬件加速实现原汁原味的掌机体验。
  - title: 本地文件零上传私密运行
    details: 使用 File System Access API 直接从本地磁盘读取游戏镜像与虚拟记忆棒（MemoryStick），零流量开销且完全保障隐私。
  - title: 虚拟触控与全手柄映射
    details: 针对桌面端（物理手柄/键盘按键重映射）与移动端触控屏（半透明虚拟摇杆及十字键）提供深度优化的交互外壳。
---

## 这是什么

**PPSSPW** 是一个基于 WebAssembly 技术的 PSP（PlayStation Portable）跨平台网页仿真运行环境。

在现代 Web 平台能力飞速发展的背景下，PPSSPW 证明了无需复杂宿主环境配置，纯网页即可作为高性能主机仿真载体。它精确处理“浏览器环境特性探测”、“WASM 核心引导”、“本地只读镜像虚拟挂载”与“即时存档持久化”之间的协同，为玩家和仿真器研究人员提供便捷、安全、透明的阅读与运行体验。

## 怎么用 / 快速上手

### 1. 本地启动开发环境

Node.js 20+ 环境：

```bash
# 安装依赖
npm install

# 启动本地开发服务器并载入 WASM 沙盒
npm start
```

### 2. 挂载镜像体验

在浏览器中打开页面后：
1. 点击“打开本地镜像”，选择你合法持有的 `.iso` 或 `.cso` 文件；
2. 页面将自动进行能力检测并分配虚拟内存缓冲区；
3. 点击画面即可激活虚拟摇杆或插入标准 USB/蓝牙手柄畅玩。

## 分层阅读与快速跳转

::: tip 按读者角色快速检索
- **初次接触 / 快速上手**：从[一次真实主流程](/walkthroughs/one-real-run)开始，追踪一次玩家选择本地镜像后，WASM 核心如何被调起并交出渲染主循环。
- **架构设计 / 模块定位**：从[代码地图](/code-map)进入，查阅 Angular 界面外壳、文件系统桥接器与 Emscripten 胶水层。
- **审计复核 / 核心贡献**：从[源码证据](/references/source-evidence)核对能力探测逻辑，查阅[文档质量复核](/references/quality-review)了解未覆盖特性。
:::

---

## 完整项目指南概览

<!--@include: ../repo-docs/README.md-->
