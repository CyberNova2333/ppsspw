# PPSSPW 人员署名、AI 工具、代码与资产许可综合清单

**标准文件名：** `ASSETS_LICENSES.md`  
**配套模板版本：** v1.6.7-r4  
**项目名称：** `PPSSPW`  
**开发、维护或联合推出主体：** `CyberNova`  
**上游仓库地址：** `https://github.com/CyberNova2333/ppsspw`  
**所对应的仓库版本及发行物：** `main` 分支（基于提交 `ecfd4ce2` 及本次 v1.6.7-r4 合规更新工作树）  
**记录覆盖范围及尚未核实部分：** 已核实本仓库全部 25,192 个受 Git 跟踪文件，包括 `deps/ppsspp-wasm/`（31 个递归上游仓库快照，见 `upstream/source-lock.json`）、`wasm-page/` 前端与 `server/`/`scripts/`/`deploy/` 脚本、`wasm-page/package.json` 依赖（均为 MIT / Apache-2.0 / MPL-2.0 构建工具，无冲突）、`wasm-page/public/images/psp-3000.webp`（`CC BY-SA 3.0`）以及 `docs-site/` 自托管字体与脚本。本次审计已核实 `deps/ppsspp-wasm/` 不含 `GPL-2.0-only` 文件、FFmpeg 按纯 `LGPL-2.1-or-later` 配置编译，并将 17 个源于上游 `root-hunter/ppsspp-web` 的修改文件头从误标的 `AGPL-3.0-only` 恢复为 `GPL-2.0-or-later`（严格遵循附加条款第 7.4 款）。未核实范围：用户自备的游戏镜像与素材（明确不在本仓库许可范围内）以及 Emscripten 工具链运行库。  
**清单最后更新日期：** `2026-11-19`  
**配套附加条款：** [中文完整文本](./LICENSE-ADDITIONAL_TERMS-zh-CN.md)；[英文参考译文](./LICENSE-ADDITIONAL_TERMS-en.md)；[工程实施指南](./IMPLEMENTATION-GUIDE.zh-en.md)

> **填写状态：本清单已依据本仓库实际文件、Git 提交历史与各上游/字体原始许可文本核实填写。** 四个分区的排列与配套附加条款 v1.6.7-r4 第 3.2、7.1 款一致；本清单如实记录已核实范围与未覆盖范围，不扩大或缩减任何上游有效许可证授予的权利，也不以列名方式向第三方材料追加限制。

**法律效力与载体说明**

1. 本清单记录事实及授权依据，不由登记、标签、Git 字段或 `meta.json` 自行产生版权、转让、代表权限或同意；真实声明的效力与覆盖范围依附加条款第 1.2、1.7—1.9 款判断。
2. 下游可依第 3.7 款改用其他合规载体，无须沿用本文件格式或工作流。与实际采用材料有关、依法或依有效许可应保留的版权、许可、免责、`NOTICE` 和合理署名，仍须按该依据保留；原许可要求完整文本或特定位置、方式的，链接和摘要不能代替。纯工具记录、一般致谢和审计字段的边界见第 3.5—3.6 款。
3. 仓库内既有的 `AUTHORS`、`NOTICE`、`COPYING`、`LICENSE`、`LICENSE.TXT`、`THIRD_PARTY.md`、`THIRD_PARTY_NOTICES.md`、`UPSTREAM.md`、`licenses/` 及 `LICENSES/` 等文件继续原样保留并在此索引；不因采用本清单而删减应保留原文。

工程实践参考见 `IMPLEMENTATION-GUIDE.zh-en.md`（非规范性指南，不增设许可条件）。

**状态标签说明**

| 中文标签 | 英文等效标签 | 记录对象及效力边界 |
| --- | --- | --- |
| `[附加条款：已明确同意]` | `[Additional terms: Express agreement recorded]` | 记录可核实的实际权利人或其有效授权代表就特定材料、条款及版本作出的明确同意。须分别核实附加要求和第 9.5—9.6 款附加许可的覆盖范围；同意其中一项不自动证明同意另一项。 |
| `[附加条款：未发表意见]` | `[Additional terms: No recorded position]` | 本项目现有记录尚无该主体对相关材料适用相应条款的可核实明确意见。不表示拒绝、曾被单独征询、放弃权利或在其他场合从未表达意见；原有效许可、既有附加条款或例外仍依实际内容适用。 |
| `[附加条款：不适用（遵循原上游许可证）]` | `[Additional terms: Not applicable (original upstream license governs)]` | 用于第三分区的原上游及第三方材料，说明列名不使其纳入本项目新增附加要求，也不代表其权利人授予本项目第 9.5 款豁免。适用的原许可及组合义务仍须履行。 |

## 一、本项目人类作者与贡献者 (Project Human Authors & Contributors)

依据当前可核实的 Git 历史、仓库权利记录与 `meta.json`，分别记录本项目维护者、原作者与上游历史贡献者的真实角色。`Author`、`Committer`、`Co-authored-by` 与版权持有人并不当然相同。

### 1.1 主体、角色与贡献记录

| 记录编号 | 姓名、笔名或组织名称及真实角色 | Git 或平台账户关联 | 实际贡献及材料范围 | 提交、PR 或其他事实依据 | 附加条款意见状态及授权记录编号 |
| --- | --- | --- | --- | --- | --- |
| `P-01` | CyberNova（项目维护者、原作者、版权持有人、许可人；Git 角色：Committer, Author） | `https://github.com/CyberNova2333` / `295488275+CyberNova2333@users.noreply.github.com` | 本仓库由 CyberNova 原创编写的新增模块、CI/测试脚本、前端新增功能文件（`wasm-page/public/{browser-files,browser-storage,download-worker,game-download,online-games,performance,touch-controls}.js`、`wasm-page/src/app/{idle-motion,interface-motion}.ts`、`scripts/ci/*` 等 37 个文件）、品牌图标与字标（`branding/ppsspw-*.svg`）及文档（`AGPL-3.0-only`）；**明确除外**：源自 `root-hunter/ppsspp-web`、`root-hunter/ppsspp-wasm`、`hrydgard/ppsspp` 及全部子目录的原始与修改文件继续遵循 `GPL-2.0-or-later` 及各子目录原有许可证，不受本项目 `AGPL-3.0-only` 或附加条款覆盖 | 本仓库 Git 完整提交历史（至 `ecfd4ce2`）及根目录 `meta.json` | `[附加条款：已明确同意]`（见 `AUTH-01`） |

### 1.2 授权事实与范围索引

下表严格分别记录“附加要求的覆盖范围”与“第 9.5—9.6 款附加许可的覆盖范围”；同意其中一项不自动推定同意另一项，且任何声明均仅及于声明人享有合法权限的材料范围。

| 授权记录编号及关联主体 | 实际声明主体与代表权限依据 | 材料、提交及版本范围 | 附加要求的覆盖范围 | 第 9.5—9.6 款附加许可的覆盖范围 | 声明、有效许可或证明依据 |
| --- | --- | --- | --- | --- | --- |
| `AUTH-01`；`P-01` | CyberNova（本人，对其原创受版权保护材料享有完整版权与许可权限） | 本仓库由 CyberNova 原创编写的新增模块、CI/测试脚本、前端新增功能文件（`wasm-page/public/{browser-files,browser-storage,download-worker,game-download,online-games,performance,touch-controls}.js`、`wasm-page/src/app/{idle-motion,interface-motion}.ts`、`scripts/ci/*` 等 37 个文件）、品牌图标与字标（`branding/ppsspw-*.svg`）及文档（`AGPL-3.0-only`）；**明确除外**：源自 `root-hunter/ppsspp-web`、`root-hunter/ppsspp-wasm`、`hrydgard/ppsspp` 及全部子目录的原始与修改文件继续遵循 `GPL-2.0-or-later` 及各子目录原有许可证，不受本项目 `AGPL-3.0-only` 或附加条款覆盖（至当前提交 `ecfd4ce2` 及后续由本人提交并标明适用的版本） | 已明确同意适用 `LICENSE-ADDITIONAL_TERMS-zh-CN.md` **v1.6.7-r4** 全部附加要求（第 7(b)/(c)/(d) 条） | 已明确授权适用 `LICENSE-ADDITIONAL_TERMS-zh-CN.md` **v1.6.7-r4** 第 9.5—9.6 款有条件的附加许可豁免（仅限于本人享有权利的原创部分，不代第三人授予） | 仓库根目录 `meta.json`（`additionalTermsConsent.CyberNova = true`）及仓库公开发布记录 |

### 1.3 应保留的项目材料声明

| 对应材料或主体编号 | 应保留的具体版权、许可或合理署名内容及依据 | 实际承载文件或界面 | 适用范围与允许的调整方式 |
| --- | --- | --- | --- |
| `P-01` | GNU AGPLv3 完整原文、附加条款 v1.6.7-r4、合理署名与项目来源声明（依据 AGPLv3 第 4–7 条及附加条款第三条） | `LICENSE`、`LICENSE-ADDITIONAL_TERMS-zh-CN.md`、`LICENSE-ADDITIONAL_TERMS-en.md`、`ASSETS_LICENSES.md` 及各原创源文件 SPDX 头 | 适用于本项目第一方 AGPLv3 适用材料；下游可依附加条款第 3.7 款改用等效合规载体 |
| `C-01` / `C-02` / `C-03` | 上游 GPLv2+ 许可全文、PSPSDK BSD 声明、31 仓来源锁文件与 GPLv3/AGPLv3 §13 组合说明 | `LICENSE.TXT`、`UPSTREAM.md`、`upstream/source-lock.json`、`deps/ppsspp-wasm/ext/*` 各自 `LICENSE`/`COPYING` | 按附加条款第 7.4 款与 GPLv3/AGPLv3 §13 组合分发，保留全部上游原作声明与许可文本 |

## 二、AI Agent 与自动化辅助工具 (AI Agents & Automated Assistants)

本分区记录工程中实际使用的 AI 辅助工具和相关技术账户。依据附加条款第 1.4、1.8 款，本分区不将工具、模型或机器人账户视为独立的版权许可授权主体，也不对工具本身赋予附加条款同意状态。

| 工具记录编号及工具类别或名称 | 技术账户、机器人或环境标识 | 经核实的使用、控制或提交上下文 | 辅助范围及相关提交或材料 | 实际主体或组件记录关联 | 核实情况与必要说明 |
| --- | --- | --- | --- | --- | --- |
| `T-01`；Claude（AI 编程辅助工具） | `noreply@anthropic.com` | 在人类维护者（`P-01` CyberNova）指令、审阅与提交操作下参与工程辅助（Git 字段角色：Co-authored-by） | 代码草拟、重构、文档整理、测试编写与代码审查辅助（以 Git 历史 `Co-authored-by` / 工具记录为准） | `P-01`（工具本身非版权许可授权主体） | 已核实 Git 历史中存在该工具签名记录；工具及技术账户本身不标注附加条款同意状态，权属与许可依附加条款第 1.4、1.8 款按实际人类权利人及有效许可判断 |
| `T-02`；Codex（AI 编程辅助工具） | `noreply@openai.com` | 在人类维护者（`P-01` CyberNova）指令、审阅与提交操作下参与工程辅助（Git 字段角色：Co-authored-by） | 代码草拟、重构、文档整理、测试编写与代码审查辅助（以 Git 历史 `Co-authored-by` / 工具记录为准） | `P-01`（工具本身非版权许可授权主体） | 已核实 Git 历史中存在该工具签名记录；工具及技术账户本身不标注附加条款同意状态，权属与许可依附加条款第 1.4、1.8 款按实际人类权利人及有效许可判断 |
| `T-03`；gemini-code-assist（AI 编程辅助工具） | `200291788+gemini-code-assist@users.noreply.github.com`（https://github.com/apps/gemini-code-assist） | 在人类维护者（`P-01` CyberNova）指令、审阅与提交操作下参与工程辅助（Git 字段角色：Co-authored-by） | 代码草拟、重构、文档整理、测试编写与代码审查辅助（以 Git 历史 `Co-authored-by` / 工具记录为准） | `P-01`（工具本身非版权许可授权主体） | 已核实 Git 历史中存在该工具签名记录；工具及技术账户本身不标注附加条款同意状态，权属与许可依附加条款第 1.4、1.8 款按实际人类权利人及有效许可判断 |
| `T-04`；Kimi（AI 编程辅助工具） | `noreply@moonshot.cn` | 在人类维护者（`P-01` CyberNova）指令、审阅与提交操作下参与工程辅助（Git 字段角色：Co-authored-by） | 代码草拟、重构、文档整理、测试编写与代码审查辅助（以 Git 历史 `Co-authored-by` / 工具记录为准） | `P-01`（工具本身非版权许可授权主体） | 已核实 Git 历史中存在该工具签名记录；工具及技术账户本身不标注附加条款同意状态，权属与许可依附加条款第 1.4、1.8 款按实际人类权利人及有效许可判断 |

## 三、上游基线、依赖与第三方代码组件（含原始作者与贡献者） (Upstream Baselines, Dependencies & Third-Party Code Components)

本分区登记本仓库实际引入、分叉、快照化、内嵌或作为关键依赖使用的上游与第三方代码组件。组件未出现在 Git 提交历史中，不减少其权利人已有权利或应保留声明。

### 3.1 代码组件与原始作者主清单

| 组件编号及名称 | 类型与实际引入方式 | 仓库位置、发行物位置或调用关系 | 上游来源及所采用版本、提交或归档标识 | 原始作者、版权持有人及相关贡献署名出处 | 实际核实范围与备注 |
| --- | --- | --- | --- | --- | --- |
| `C-01`；PPSSPP / `root-hunter/ppsspp-wasm` 模拟器核心与递归依赖快照 | 上游固定提交源码快照直接入库（无上游 Git 历史；已排除 141 个预编译 FFmpeg 归档并从源码重编） | `deps/ppsspp-wasm/`（含 `ffmpeg/`、`ext/*` 等 30 个递归组件，详列于 `upstream/source-lock.json`） | https://github.com/root-hunter/ppsspp-wasm（提交 `e536386db3edc73d0b94c64f0cfdf1656cdda654`，上游自 https://github.com/hrydgard/ppsspp） | Henrik Rydgård & PPSSPP Contributors、root-hunter 及各 `ext/` 子依赖原作者 | 已核实无 `GPL-2.0-only` 冲突文件；`scripts/build-ffmpeg-wasm.sh` 未启用 `--enable-gpl`，FFmpeg 按 `LGPL-2.1-or-later` 编译；`zstd` 采用 BSD-3-Clause 侧、`freetype` 兼容 GPLv3/AGPLv3 |
| `C-02`；`root-hunter/ppsspp-web` 网页客户端与中继基线 | 上游固定提交源码快照直接入库（无上游 Git 历史） | `wasm-page/public/{ppsspp-runtime,adhoc-transport,sw}.js`、`wasm-page/src/{main,app/app,app/network-invites,app/ppsspp-runtime}.ts`、`server/{relay,relay_admin,relay_auth,serve}.py`、`scripts/` 与 `deploy/relay/deploy.sh` 等（原配置备份于 `upstream/web/`） | https://github.com/root-hunter/ppsspp-web（提交 `dbb273baee573025875593786fd22967ae81d91f`） | Antonio Ricciardi (root-hunter) & ppsspp-web Contributors | 已核实并恢复 17 个源于上游的修改文件头为 `SPDX-License-Identifier: GPL-2.0-or-later`（严格遵循附加条款第 7.4 款），与 CyberNova 原创的 37 个 `AGPL-3.0-only` 文件清晰分界 |
| `C-03`；PSPSDK（部分宏定义、常量与头文件） | 随 PPSSPP 核心上游引入的兼容头文件片段 | 见 `LICENSE.TXT` 顶部声明及 `deps/ppsspp-wasm/` 相关头文件 | PSPSDK（随 PPSSPP 上游引入） | adresd, Marcus R. Brown, James Forshaw, John Kelley, Jesper Svennevid（`Copyright (c) 2005`） | 已核实 `LICENSE.TXT` 完整保留 PSPSDK 三条款 BSD 兼容声明 |
| `C-04`；Anime.js 4.5.0 | 第三方内嵌脚本（静态复制） | `wasm-page/public/licenses/animejs-MIT.txt`（对应网页端动效库） 与 `docs-site/.vitepress/theme/vendor/animejs/` | https://github.com/juliangarnier/anime（v4.5.0） | Julian Garnier（`Copyright (c) 2025 Julian Garnier`） | 已核实仓内随附 MIT 许可原文与静态脚本文件；未修改上游逻辑 |

### 3.2 原始许可、本地修改与组合边界

| 组件编号 | 原始部分的有效许可证及完整文本位置 | 本地新增或修改部分及其有效授权 | 构建、链接或交互方式与适用边界 | 原始材料的附加条款状态 |
| --- | --- | --- | --- | --- |
| `C-01` | GPL-2.0-or-later（`LICENSE.TXT`）及各 `ext/` 子目录原许可（LGPL-2.1-or-later、MIT、Apache-2.0、BSD、Zlib 等） | 本仓对 `deps/ppsspp-wasm/` 的本地修改文件继续遵循 `GPL-2.0-or-later` 并保留原文件版权头，不改标 `AGPL-3.0-only` | 与本项目原创 `AGPL-3.0-only` 模块经 GPLv3 §13 与 AGPLv3 §13 兼容组合构成网页模拟器程序（不将原 GPL 代码改授 `AGPL-3.0-only`） | [附加条款：不适用（遵循原上游许可证）] |
| `C-02` | GPL-2.0-or-later（`LICENSE.TXT`） | 对源自上游的 17 个文件所作本地修改继续遵循 `GPL-2.0-or-later`（文件头注明修改者 CyberNova）；CyberNova 新增的 37 个原创文件为 `AGPL-3.0-only`（含附加条款） | 与本项目原创 `AGPL-3.0-only` 文件依 GPLv3 §13 与 AGPLv3 §13 兼容组合发布（`wasm-page/package.json` 标明 `AGPL-3.0-only AND GPL-2.0-or-later`） | [附加条款：不适用（遵循原上游许可证）] |
| `C-03` | BSD-3-Clause 兼容许可（`LICENSE.TXT` 顶部） | 无本地修改 | 随 PPSSPP 核心编译链接，与 GPLv3/AGPLv3 兼容 | [附加条款：不适用（遵循原上游许可证）] |
| `C-04` | MIT（`wasm-page/public/licenses/animejs-MIT.txt`、`docs-site/.vitepress/theme/vendor/animejs/LICENSE.md`） | 无本地源码修改（原样静态内嵌） | 作为独立前端／文档站动效库静态分发，与 AGPL-3.0-only 兼容 | [附加条款：不适用（遵循原上游许可证）] |

### 3.3 需保留的许可、NOTICE 与版权声明索引

| 组件编号 | 声明类别及原始出处 | 实际随附或提供位置 | 原许可要求保留的内容和适用范围 | 载体安排说明 |
| --- | --- | --- | --- | --- |
| `C-01` | GPL-2.0-or-later 原文、`UPSTREAM.md`、锁文件与子目录 `LICENSE`/`COPYING` | `LICENSE.TXT`、`UPSTREAM.md`、`upstream/source-lock.json`、`deps/ppsspp-wasm/LICENSE.TXT` 及各子目录许可文件 | 分发编译产物或部署线上实例须履行 GPLv3/AGPLv3 §13 对应源码提供与全部声明保留义务 | 原样随仓保留并在应用“关于”界面提供 `UPSTREAM-LICENSE.txt` 链接 |
| `C-02` | 上游版权声明、`LICENSE.TXT` 与修改标识 | `LICENSE.TXT`、`UPSTREAM.md` 及各修改文件头部 | 保留原版权声明、GPL-2.0-or-later 许可与显著修改说明 | 随源码文件头与根目录 `LICENSE.TXT` 完整保留 |
| `C-03` | PSPSDK 版权与三条款免责声明 | `LICENSE.TXT`（1–28 行） | 源代码与二进制分发须保留该版权与免责声明 | 保留于 `LICENSE.TXT` 与构建产物 `UPSTREAM-LICENSE.txt` |
| `C-04` | MIT 版权与许可声明 | `wasm-page/public/licenses/animejs-MIT.txt`、`docs-site/.vitepress/theme/vendor/animejs/LICENSE.md` | 随源代码及静态站点分发保留原版权声明与 MIT 许可全文 | 随仓提供完整 `LICENSE.md` / `animejs-MIT.txt` 文本文件 |

## 四、独立美术、字体与项目标识资产 (Independent Artwork, Fonts & Project Identifier Assets)

本分区登记可独立识别的美术图形、Logo、图标、字体及其他静态资产，依附加条款第 7.6—7.8 款及第八条区分许可与使用边界。

### 4.1 资产、来源与许可清单

| 资产编号、名称及类别 | 实际文件、来源与所采用版本 | 作者、版权持有人及可核实依据 | 实际有效许可证或具体授权及完整文本位置 | 是否为项目标识、随包方式及替换情况 | 适用范围、修改与尚待核实事项 |
| --- | --- | --- | --- | --- | --- |
| `A-01`；PPSSPW 原创符号、路径字标与应用图标 | `branding/ppsspw-symbol.svg`、`branding/ppsspw-wordmark.svg`、`wasm-page/public/icons/ppsspw*.{svg,png}`；本项目原创（说明见 `branding/README.md`） | CyberNova | AGPL-3.0-only（`LICENSE`，适用附加条款第五、八条） | 是（项目默认标识与 PWA 图标）；随网页客户端打包；下游可自由替换或更名 | 依据附加条款第五条与第八条随网页客户端复制、打包、显示与替换；明确与上游 PPSSPP 标识相区分 |
| `A-02`；PSP-3000 设备照片（派生 WebP 静态图） | `wasm-page/public/images/psp-3000.webp`；来源：https://commons.wikimedia.org/wiki/File:PSP-3000-Silver.png | Evan-Amos（Wikimedia Commons；详见 `wasm-page/public/images/CREDITS.md`） | CC BY-SA 3.0（https://creativecommons.org/licenses/by-sa/3.0/ ；见 `CREDITS.md`） | 否（非项目标识）；作为独立静态图片资源随网页加载；可替换 | 按 CC BY-SA 3.0 保留署名、来源链接与修改说明（已缩放到 1200px 宽并转码 WebP，派生图仍为 CC BY-SA 3.0）；未改授 AGPL |
| `A-03`；`deps/ppsspp-wasm/` 随上游快照保留的原有图形与字体资源 | `deps/ppsspp-wasm/assets/` 等原有上游资源目录 | PPSSPP 上游原作者及各第三方资源权利人（见 `LICENSE.TXT`、`UPSTREAM.md`） | GPL-2.0-or-later 或各所在目录原声明许可证 | 否（非 PPSSPW 项目标识）；随模拟器核心构建与运行保留 | 严格按原有有效上游许可随核心构建与界面保留；不作为 PPSSPW 品牌标识使用 |
| `A-04`；IBM Plex Sans（网页播放器自托管字体） | `wasm-page/public/fonts/ibm-plex-sans-latin-*.woff2`；来源：IBM Plex Sans | IBM Corp.（见 `wasm-page/public/fonts/LICENSE-IBM-Plex-Sans.txt`） | SIL Open Font License 1.1（`wasm-page/public/fonts/LICENSE-IBM-Plex-Sans.txt`） | 否（非项目标识）；随网页播放器静态资源打包；可替换 | 按 SIL OFL 1.1 随页面排版使用；未修改字形 |
| `A-05`；IBM Plex Sans（文档站自托管字体） | `docs-site/.vitepress/theme/fonts/ibm-plex-sans-latin-*.woff2`；来源：IBM Plex Sans | IBM Corp.（见同目录 `IBM-Plex-Sans-LICENSE.txt`） | SIL Open Font License 1.1（`docs-site/.vitepress/theme/fonts/IBM-Plex-Sans-LICENSE.txt`） | 否（非项目标识）；随 `docs-site` 构建静态分发；可由下游自由替换 | 按 SIL OFL 1.1 随文档站构建与浏览分发；未修改字形 |
| `A-06`；JetBrains Mono（文档站自托管字体） | `docs-site/.vitepress/theme/fonts/jetbrains-mono-latin-500-normal.woff2`；来源：JetBrains Mono | The JetBrains Mono Project Authors（见同目录 `LICENSE-jetbrains-mono.txt`） | SIL Open Font License 1.1（`docs-site/.vitepress/theme/fonts/LICENSE-jetbrains-mono.txt`） | 否（非项目标识）；随 `docs-site` 构建静态分发；可由下游自由替换 | 按 SIL OFL 1.1 随文档站代码块渲染使用；未修改字形 |

### 4.2 字体与其他资产的专门条件记录

以下版权声明与保留字体名称（RFN）均**逐字核对自本仓库实际随附的许可原文文件**，不从品牌名或文件名推定。

| 资产编号 | 实际保留的版权、许可及署名资料 | 保留字体名称或其他专门条件 | 本地修改及其许可要求 | 实际提供或展示方式 |
| --- | --- | --- | --- | --- |
| `A-02` | `PSP-3000 photo: Evan-Amos, via Wikimedia Commons`（`https://commons.wikimedia.org/wiki/File:PSP-3000-Silver.png`，CC BY-SA 3.0）；记录见 `wasm-page/public/images/CREDITS.md` | CC BY-SA 3.0 要求署名、提供许可链接、说明所作修改，且派生图片以相同方式共享 | 上游已调整尺寸至 1200px 宽并转为 WebP；派生图维持 CC BY-SA 3.0 | 随仓提供 `wasm-page/public/images/CREDITS.md` 并在网页界面“关于 → 许可与资源署名”中直接展示 |
| `A-04` | `Copyright 2019 IBM Corp. All rights reserved. IBMPlexSans-Italic[wdth,wght].ttf: Copyright 2019 IBM Corp. All rights reserved.`；全文见 `wasm-page/public/fonts/LICENSE-IBM-Plex-Sans.txt` | 未声明保留字体名称（无 RFN）；不得单独售卖字体文件本身 | 无本地字形修改 | 随 `wasm-page/public/fonts/` 同目录保留完整 OFL-1.1 原文 |
| `A-05` | `Copyright 2019 IBM Corp. All rights reserved. IBMPlexSans-Italic[wdth,wght].ttf: Copyright 2019 IBM Corp. All rights reserved.`；全文见 `docs-site/.vitepress/theme/fonts/IBM-Plex-Sans-LICENSE.txt` | 未声明保留字体名称（无 RFN）；不得单独售卖字体文件本身，衍生字体须续用 SIL OFL 1.1 | 无本地字形修改（仅原样自托管 WOFF2） | 随源码仓库与 `docs-site` 主题字体目录同目录保留完整 OFL-1.1 原文 |
| `A-06` | `Copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono) JetBrainsMono-Italic[wght].ttf: Copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono)`；全文见 `docs-site/.vitepress/theme/fonts/LICENSE-jetbrains-mono.txt` | 未声明保留字体名称（无 RFN）；不得单独售卖字体文件本身，衍生字体须续用 SIL OFL 1.1 | 无本地字形修改（仅原样自托管 WOFF2） | 随源码仓库与 `docs-site` 主题字体目录同目录保留完整 OFL-1.1 原文 |

### 4.3 项目标识与既有许可边界

PPSSPW 原创标识（`branding/ppsspw-*.svg`）与上游 PPSSPP 标识明确区分，为独立可替换资产并按 `AGPL-3.0-only` 提供；遵循附加条款第五、八条（不主张注册商标权，亦不暗示与 PPSSPP 官方或 Sony Interactive Entertainment 存在任何官方关系）。

引用附加条款第八条（含第 8.2 款）时，完整保留资产独立性、实际权利人授权、可替换性、许可相容性及不追溯收回既有版本有效授权（第 7.8、9.3 款）等全部前提条件，不单独摘录或扩大限制。

---

本清单记录事实与许可索引，不增设原有效许可证未规定的条件，也不要求下游沿用相同文件名、分区或自动化工作流；下游载体调整依附加条款第 3.7 款处理。
