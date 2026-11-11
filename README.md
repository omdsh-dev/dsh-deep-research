# @dsh-external/dsh-deep-research

把 deep-research 流程做成 **DSH 扩展插件**（plugin，与 skill 体系分开），
基于 **DSH 官方 workflow 引擎**（`ctx.workflowEngine`，dsh >= 0.2.2-rc.1 由
`@deepseek-ai/dsh-workflow-ptc` 提供）实现，按 **控制论 + 信息论** 设计——不是固定提示词流水线，而是**活的、自适应的研究闭环**。

## dsh 0.2.2-rc.1 兼容性

在 dsh 0.2.2-rc.1 上需要四处适配（本 PR 内容）：

1. workflow 服务名 `workflows` → `workflowEngine`（旧名在 0.2.2-rc.1 不存在，inject 永远 pending）；
2. peerDependencies 对齐 `^0.2.2-rc.1`（`^0.0.1` 会被宿主启动期版本兼容门直接 skip）；
3. `questions` 绑定值不得携带 `keywords: undefined`——workflow 引擎要求绑定值是无损 JSON，
   含 `undefined` 属性的对象会被拒绝（真实运行报错：`workflow binding value must be lossless JSON`）；
4. cordis.patch.yml 增加 id 定向覆盖重新启用 `workflow-ptc`：web profile 的 web-app bundle 层把
   全局 workflow-ptc 禁用为 preset 级，不禁用则插件激活不了。

注意：若与其它注册 `deep_research` 工具的插件（如 houdinicc/dsh-deep-research）共存，宿主工具
注册表拒绝重名，需把本插件工具改名为 `deep_research_workflow` 之类——非本 PR 范围，按需自行处理。

## 理论 → 机制


| 理论                                      | 插件里的落地                                                                                                                                    |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 控制论：参考信号校准（闭环控制错误目标 = 白费）               | 规划代理先定义**答案空间**（`scope`：研究支撑什么判断/决策）与每个子问题的**验收标准**（`acceptance`），再开始研究                                                                   |
| Ashby 必要多样性定律（控制器多样性 &lt; 系统多样性 ⇒ 必有盲区） | 规划代理枚举主题的**信息维度**，每个子问题映射一个维度，并输出**覆盖度自检** `coverage_gaps`                                                                                |
| 信息论：信息 = 不确定性的减少                        | 研究子代理维护三态证据 `confirmed / uncertain / gaps`——条件熵的工程表达；报告保留置信度与矛盾，不掩盖不确定性                                                                   |
| 信息论：边际信息增益（EIG）递减 ⇒ 无限搜索是错的             | 每个研究子代理：预测（针对哪个高熵点、预期新增什么）→ 行动（web_search/web_fetch）→ 更新证据 → **边际增益验证**；**连续一轮零增益即停** + 轮次硬上限                                             |
| 控制论：自适应控制（流程是活的，不是固定脚本）                 | 研究阶段是**闭环再规划**：第 1 轮并行研究全部子问题；每轮结束收集 high-priority 缺口 → **自动派发下一轮补充研究**；规划声明的"盲区"会被**定向侦察验证**（假设被实验检验而非静态接受）；简单主题一轮收敛，复杂主题自动扩展，直到边际增益 ≈ 0 |
| 信息论：率失真（给定"率"最小化失真）                     | 综合子代理把证据**有损压缩**为最终报告：只保留对结论有区分度的信息，决策有用性最大化                                                                                              |
| 信息论：信道冗余/纠错（对抗幻觉=噪声）                    | 可选**对抗性审查**子代理 = 奇偶校验：引用抽查（URL 可达性/支撑性）、覆盖度审计、矛盾与过度自信标注                                                                                   |


## 结构

```
dsh-deep-research/
├── package.json    # @dsh-external/dsh-deep-research（声明 dsh.bundle.patch）
├── cordis.patch.yml  # bundle 补丁：按包名插入插件行
├── src/index.ts    # cordis 插件：注册 deep_research 工具，提交官方 workflow 脚本（原生 TS，零构建）
├── tsconfig.json   # typecheck 配置（project references 解析到 sibling deepseek-harness 源码）
└── README.md
```

## 开发与检查

```bash
pnpm install        # 仅 typescript/@types/node（typecheck 用）
pnpm run typecheck  # tsc -b，类型从 sibling deepseek-harness checkout 解析
```

源码即运行时：包入口直接指向 `src/index.ts`，无构建步骤。profile 安装的副本位于
node_modules 下，由 dsh 源码启动器的 tsx hook 加载（Node 原生类型剥离拒绝
node_modules 内的文件）；源码 checkout 在 node_modules 外直跑时也可用 Node ≥22.18
原生剥离。要求 erasable-only TS 语法（无 enum/命名空间等），
`node --test`/`pnpm typecheck` 会挡住不可移植写法。

## 安装与使用方式

包声明了 `dsh.bundle.patch`（cordis.patch.yml），通过 `dsh plugin` 装进**任意** profile
（把 `<profile>` 换成 `tui` / `headless` / `web` 或自建 profile）：

```bash
dsh plugin --profile <profile> add git+https://github.com/dsh-external/dsh-deep-research.git
dsh --profile <profile>        # 重启生效：工具 deep_research 随 profile 注入
```

> 若 pnpm 把 https URL 重写成 git+ssh（本机全局 git `insteadof` 配置所致），用上面的
> `git+https://` 形式；`dsh plugin` 会提示需要 `allowBuilds` 时按提示在
> `$DSH_HOME/profiles/<name>/pnpm-workspace.yaml` 加一行即可。

工具由模型按工具描述自动触发（深度研究/调研/多源信息综合分析/研究报告/文献搜集），
对话中直接说人话即可：

- 「深度调研一下 MCP 生态现状，重点对比几家主流实现，出一份带引用的报告」
- 「按这份问题清单做研究：1. ... 2. ...」（已有清单 → 跳过自动拆解，直接并行研究）
- 「调研一下 A/B 方案，purpose 是决定我们选哪个」（用途越明确，答案空间越准）
- 复杂主题会自动扩展轮次（自适应闭环），简单主题一轮收敛；想要更严谨传 `depth: 3`，
  要引用纠错和覆盖度审计传 `review: true`。

**成本建议**：模型分层——规划/综合用强模型、研究用便宜模型（配置
`plannerModel`/`researcherModel`/`synthesizerModel`/`reviewerModel`），可显著降本。

**依赖要求**：profile 的组合必须包含官方 workflow 引擎与内置 web 工具——`dsh` 官方
base 组合自带，无需额外安装；peer 依赖（`@deepseek-ai/dsh-tools` 等）由组合提供，
profile 的 `autoInstallPeers: false` 可避免向 registry 查找未发布的 `@deepseek-ai/*`。

**更新 / 卸载**：

```bash
dsh plugin --profile <profile> update
dsh plugin --profile <profile> remove @dsh-external/dsh-deep-research
# 或：从 profile 的 package.json 移除依赖后 dsh plugin --profile <profile> update
```

## 工具参数


| 参数           | 必填  | 说明                                           |
| ------------ | --- | -------------------------------------------- |
| `topic`      | 是   | 研究主题                                         |
| `purpose`    | 否   | 研究用途（要支撑的判断/决策）——用于定义答案空间；缺省时规划代理声明假设用途      |
| `questions`  | 否   | 已有问题清单（每行一个）；提供则跳过自动拆解                       |
| `depth`      | 否   | 精度/容差：1=初步 2=深入（默认）3=穷尽——决定研究闭环轮次上限（depth+1） |
| `synthesize` | 否   | 综合子代理出最终报告（默认 true）；false 只返回三态证据            |
| `review`     | 否   | 对抗性审查（默认 false）：引用纠错 + 覆盖度审计 + 矛盾/过度自信标注     |


## 配置（可选）


| Key                                                                       | 默认           | 说明                                |
| ------------------------------------------------------------------------- | ------------ | --------------------------------- |
| `subagentProvider`                                                        | 引擎默认 `spawn` | 子代理 provider                      |
| `maxParallel`                                                             | `4`          | 每轮研究并发上限                          |
| `maxTotalAgents`                                                          | 引擎上限         | 整次运行子代理总数上限                       |
| `plannerModel` / `researcherModel` / `synthesizerModel` / `reviewerModel` | 继承父配置        | 模型分级（OpenAI 指南：规划/综合用强模型，执行用便宜模型） |


## 设计说明

- **plugin ≠ skill**：不注册进 `ctx.skills`；触发靠工具描述（深度研究/调研/多源信息综合分析等）。
- **复用官方能力**：编排走官方 workflow 引擎（worker 隔离、并发/总数 caps、取消、进度事件、`wf-runs` 记录）；搜索/抓取走内置 `web_search`/`web_fetch`——插件零网络逻辑、零自研编排。
- **不碰 TUI**：无 tuiPrompt / overlay / system-prompt 注入，规避 prompt 槽位 disposed 类崩溃。
- **取消传播**：`exec.signal` 传入 workflow run，取消时子代理随之中止。
- **失败隔离**：单个子问题研究失败只在该节标注；规划失败则工具报错，主代理可调参重试。
- 技能模板（`.claude/skills/deep-research`）保留不动，两者独立。


## Profile 兼容性

本插件运行时依赖 DSH 官方 workflow 引擎（`ctx.workflows`，peer：`@deepseek-ai/dsh-workflow`）。
请把它安装进**提供 workflows provider 的 Profile**（如 tui/headless 组合）；若 Profile 未声明
该 provider（如部分 Web Profile 组合），Loader 会保持 pending——此时请先在 DSH Hub 登记
workflows provider 关系或改用提供该服务的组合。编译产物（`lib/types/index.js`）为官方
0810 生产入口，Node 原生可加载。
