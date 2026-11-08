---
title: 快速入门
description: PPSSPW 是基于 WebAssembly 与 WebGL2 技术的**高性能网页端 Sony PSP 掌机模拟器**。
---

# 快速入门

PPSSPW 是基于 WebAssembly 与 WebGL2 技术的**高性能网页端 Sony PSP 掌机模拟器**。

## 解决的核心痛点

- **痛点 1**：浏览器切到后台或在高刷新率屏幕（120Hz/144Hz）下传统 RAF 调度导致画面严重撕裂与跳帧
- **痛点 2**：音频采样缓冲区与视频帧步进不协调引起恼人的破音与电流音
- **痛点 3**：触屏虚拟按键布局僵硬，移动端无法获得舒适的游戏操控手感

---

## 环境准备

支持 WebAssembly 与 WebGL 2.0 的现代浏览器。

---

## 快速安装与运行

```bash
# 1. 安装开发依赖
pnpm install

# 2. 启动本地调试服务器
pnpm run start

# 3. 浏览器访问测试
http://localhost:4200
```

---

## 接下来探索

- 深入了解系统内部流转：查阅 [系统架构与设计](/docs/architecture)
- 探索全部配置参数与高级场景：查阅 [配置与使用指南](/docs/configuration)
- 遇到问题排错：查阅 [常见问题与排错](/docs/faq)
