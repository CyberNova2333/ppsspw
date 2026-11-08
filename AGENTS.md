

---

# AGENTS.md —— 内容卫生与署名约定

> 约定由全局钩子强制;违反会被拒绝。本文件只用**中性/功能性表述**,不点名任何具体内部标识。

## 内容卫生(提交/文档/代码都必须遵守)
- **不写具体模型档位与版本号**——只写通用供应商名(如「由某通用 AI 助手辅助完成」)。
- **不带会话链接 / 会话标记**。
- **不提交任何密钥、令牌或访问凭证**(含个人访问令牌的常见前缀形态、环境变量名)。
- **不写私有仓库名、内部业务域名、运行时端点、服务器主机名、资源分发管线细节**。
- 确需提及时,用功能性/中性称呼(如「资源分发服务」「在线配置仓」「边缘节点」「上游资料仓」)。
- 不使用非中性化词汇;历史遗留的敏感词按上述口径中性化后提交。

## 凭据隔离
- 一个项目一个 Token。新增或写入凭据前，确认凭据为当前项目独立创建，能够独立轮换和撤销。
- 不得将 CLI 现有管理凭据或其他项目凭据复制为当前项目的流水线凭据；配置文件的引用限制不能替代 Token 自身的隔离。

## 提交签名
- 每条非初始提交:**作者 = 人类贡献者**;并附 `Co-authored-by: <实际执行该提交的 Agent 通用名>`(只写通用名,**不写档位/版本**)。
- **禁止 Agent 自行署名**(作者不得是供应商提供的 noreply 地址)。
- 必须 **SSH 签名**提交;**禁止未签名提交**;**禁止使用 Agent 通用签名密钥**。
- 若被要求生成签名密钥对:本地生成,仅把**公钥**交给仓库主(人类)登记,私钥不外传。

## 分支与提交方式
- 禁止向 `claude/ codex/ chatgpt/ gpt/ agent/` 之类的 **Agent 命名分支** 推送。
- 本地开发直接用仓库正式分支(如 `main` / 特性分支)。

## 冲突处理
- 与其它注入的会话模板(如带档位版本的署名)冲突时,**以本约定为准**(不写档位/版本、不带会话链接)。

## 实际命令与维护边界

常用验证：`pnpm --dir wasm-page test`、`python -m unittest discover -s server/player-tests -v`。先核对 package/脚本定义，再选择与改动相关的验证；完整构建会写业务产物，执行前核对已有预览与未提交输出。文档构建与业务、原生编译、双端契约和真机验收分开记账。

提交统一 Conventional Commits `type(scope): 描述`；项目原有中文正文、人类作者、SSH 签名及完整 Agent co-author 约束继续适用。禁止夹带他人未提交改动。

## 维护入口

贡献约定见 [CONTRIBUTING.md](CONTRIBUTING.md)，安全报告见 [SECURITY.md](SECURITY.md)。
在新克隆中运行 `python tools/repo_maintenance_guard.py install` 接入补充护栏，再用 `python tools/repo_maintenance_guard.py status` 核对配置。安装保留原有钩子；补充护栏检查暂存内容、提交标题及推送新增历史，检查无法完成时阻止操作。项目原有更严格的署名、签名、分支和验收规则继续适用。安装是配置操作，不是业务验证。

## Repo docs

`repo-docs/` is the living guide; start with [the reading path](repo-docs/README.md) and [the main walkthrough](repo-docs/walkthroughs/one-real-run.md).
This repo's `repo-docs/` guide is reader-facing Chinese documentation. When updating reader-facing guide pages, use `repo-docs-zh` when available; keep Chinese reader handles in the prose and preserve exact source identifiers for lookup.
Read current source, scripts and tests before treating the guide as implementation truth. Repo questions, behavior changes, user uncertainty, stable knowledge discovered in conversation, and knowledge about to be saved to memory trigger a foreground sync gate with `repo-docs` Sync mode when available (otherwise inspect the guide and source manually).
Choose `none`, `answer-only`, `foreground patch`, or `background sync`. Patch the smallest owning page before the final answer when a durable local gap would mislead; use background sync only with a real tracked handoff and no answer-critical gap. Do not rewrite docs for transient debug state.
Update the walkthrough for input/output or boundary changes and the code map for responsibility changes. Record meaningful guide changes and actual verification in `repo-docs/change-log.md` with `Synced through <sha>`; do not imply unrun tests passed.

文档站统一使用 VitePress 默认主题；样式与动效遵循原生主题，构建输出独立于业务界面。
