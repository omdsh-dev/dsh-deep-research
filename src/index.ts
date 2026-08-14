/**
 * dsh-deep-research — Deep Research orchestrator extension for DeepSeek Harness.
 *
 * A REAL plugin (not a skill): registers one model-facing tool, `deep_research`,
 * that runs the user's deep-research workflow ON TOP OF DSH'S OFFICIAL WORKFLOW
 * ENGINE (`ctx.workflows`, `@deepseek-ai/dsh-workflow-workerthread`) — no custom
 * subagent plumbing, no TUI surface, no prompt injection.
 *
 * The pipeline is a LIVE ADAPTIVE LOOP designed from cybernetics + information
 * theory — it is NOT a fixed four-stage prompt chain:
 *
 * ── 问题定义 (control theory: reference-signal calibration) ────────────────
 *   The planner first defines the ANSWER SPACE (`scope`: what decision the
 *   report supports) and per-question acceptance criteria, so the loop never
 *   chases a mis-set reference.
 *
 * ── 多样性拆解 (Ashby's Law of Requisite Variety) ──────────────────────────
 *   The planner enumerates the topic's information DIMENSIONS, maps each
 *   sub-question to a dimension, and self-audits COVERAGE (`coverage_gaps`):
 *   uncovered dimensions are declared as hypotheses to be tested, not hidden.
 *
 * ── 自适应研究循环 (adaptive control / perception–action cycle) ────────────
 *   Research is an ITERATIVE CLOSED LOOP, not a one-shot fan-out:
 *     round 1:  all planned sub-questions in parallel.
 *     round n>1: dynamic re-planning — high-priority gaps reported by the
 *                previous round become NEW sub-questions, and the planner's
 *                declared blind spots get one reconnaissance attempt (a
 *                planning assumption is verified experimentally, not trusted).
 *   Convergence is information-theoretic: the loop stops when a round produces
 *   no new high-priority gaps (marginal information gain ≈ 0) or the round cap
 *   (depth + 1) is hit. Simple topics converge after one round; hard ones
 *   automatically expand — the flow is alive, not a fixed script.
 *   Each researcher keeps a three-state evidence model (confirmed / uncertain /
 *   gaps = conditional entropy made explicit) and stops internally the moment
 *   one round adds nothing.
 *
 * ── 综合 (rate–distortion) ─────────────────────────────────────────────────
 *   The final report is lossy compression for a stated decision: it keeps only
 *   information that distinguishes conclusions, and PRESERVES uncertainty
 *   (confidence / 矛盾 / verified blind spots) instead of masking it.
 *
 * ── 审查 (channel redundancy / error correction, opt-in) ───────────────────
 *   An adversarial reviewer acts as a parity check: citation spot-checks
 *   (hallucinated sources = channel noise), coverage audit against the declared
 *   dimensions, contradiction and over-confidence marking.
 *
 * Model tiering (OpenAI guide) via config: `plannerModel` / `researcherModel` /
 * `synthesizerModel` / `reviewerModel` → `args.models`; omitted models inherit
 * the parent route. The plugin never fetches the web: search/fetch stays on
 * DSH's built-in `web_search` / `web_fetch`, which children inherit.
 *
 * Native TypeScript source: the package entry points at this file and no build
 * step exists. In a dsh profile the package lives under node_modules, so it
 * loads through the dsh source launcher's whole-process tsx hook (Node's
 * native type stripping refuses files under node_modules); a checkout run
 * outside node_modules can also load via Node >=22.18 native stripping.
 * Syntax must stay erasable-only (no enums/namespaces/parameter properties).
 *
 * @module @dsh-external/dsh-deep-research
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from 'cordis'
// Type-only: brings the `ctx.workflows` Context augmentation into this program.
import type { WorkflowMeta } from '@deepseek-ai/dsh-workflow'

export const name = 'dsh-deep-research'

/**
 * Activate once the tool registry is available. The workflow service is an
 * OPTIONAL runtime capability and is deliberately NOT injected: in profiles
 * without a `workflows` provider (e.g. the stock web composition) an
 * unsatisfied inject leaves this entry pending forever, which parks the
 * loader's EntryGroup (Promise.allSettled) and silently kills the whole dsh
 * process ~40s after startup. Availability is guarded at tool-call time
 * instead (see `execute`).
 */
export const inject = ['tools']

/** Plugin config (all optional). */
export interface Config {
  /** Child-provider override passed to every workflow run. */
  subagentProvider?: string
  /** Role-level model overrides, one per planner/researcher/synthesizer/reviewer role. */
  plannerModel?: string
  researcherModel?: string
  synthesizerModel?: string
  reviewerModel?: string
  /** Per-run total-child ceiling for every workflow run. */
  maxTotalAgents?: number
  /** Research concurrency per round. */
  maxParallel?: number
}

/** Planner structured output: answer space + dimension coverage + questions. */
const PLANNER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    scope: { type: 'string' },
    dimensions: {
      type: 'array',
      items: { type: 'string' },
    },
    questions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          question: { type: 'string' },
          dimension: { type: 'string' },
          keywords: { type: 'string' },
          acceptance: { type: 'string' },
        },
        required: ['question', 'dimension'],
      },
    },
    coverage_gaps: {
      type: 'array',
      items: { type: 'string' },
    },
  },
  required: ['scope', 'dimensions', 'questions', 'coverage_gaps'],
}

/** Researcher structured output: the three-state evidence model (entropy tracking). */
const RESEARCHER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    confirmed: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          claim: { type: 'string' },
          source: { type: 'string' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
        required: ['claim', 'source'],
      },
    },
    uncertain: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          point: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['point'],
      },
    },
    gaps: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          aspect: { type: 'string' },
          priority: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
        required: ['aspect'],
      },
    },
  },
  required: ['confirmed'],
}

/**
 * The workflow script. STATIC TEXT — no template interpolation: all dynamic
 * input rides `args` (topic, purpose, questions, depth, flags, models,
 * maxParallel), and the body uses string concatenation only, so there is no
 * `\${` escaping and no injection surface. The EXECUTION is adaptive: the
 * research phase re-plans itself round by round until information saturation.
 * Runs in the official engine's worker thread.
 */
const SCRIPT = String.raw`const PLANNER_SCHEMA = ${JSON.stringify(PLANNER_SCHEMA)}
const RESEARCHER_SCHEMA = ${JSON.stringify(RESEARCHER_SCHEMA)}
const { topic, questions, depth, synthesize, review, models, purpose, maxParallel } = args
const M = models ?? {}
const LIMIT = depth >= 3 ? 4 : depth === 1 ? 2 : 3

function confidenceLabel(c) {
  return c === 'high' ? '高' : c === 'medium' ? '中' : c === 'low' ? '低' : '中'
}

function renderFindings(q, f) {
  const lines = ['## ' + q.question, '']
  if (f.confirmed && f.confirmed.length > 0) {
    lines.push('### 已确认事实（置信度）')
    for (const item of f.confirmed) {
      lines.push('- ' + item.claim + '（置信度：' + confidenceLabel(item.confidence) + '，来源：' + item.source + '）')
    }
  }
  if (f.uncertain && f.uncertain.length > 0) {
    lines.push('### 不确定项')
    for (const item of f.uncertain) {
      lines.push('- ' + item.point + (item.reason ? '（原因：' + item.reason + '）' : ''))
    }
  }
  if (f.gaps && f.gaps.length > 0) {
    lines.push('### 信息缺口（优先级）')
    for (const item of f.gaps) {
      lines.push('- ' + item.aspect + '（优先级：' + confidenceLabel(item.priority) + '）')
    }
  }
  if (!f.confirmed || f.confirmed.length === 0) lines.push('（该子问题未获得任何可确认的证据）')
  return lines.join('\n')
}

phase('规划')
let subs = Array.isArray(questions) && questions.length > 0 ? questions : null
let planText = ''
if (!subs) {
  const planned = await agent(
    '你是深度研究规划代理。研究的第一步是定义问题本身：先界定答案空间，再按信息维度拆解子问题。\n\n'
    + '研究主题：' + topic
    + (purpose ? '\n研究用途（要支撑的决策/判断）：' + purpose : '')
    + '\n\n请按以下顺序工作：\n'
    + '1. 【答案空间】用一句话界定 scope：这份研究要回答什么问题、支撑什么判断或决策；若用途未说明，明确写出你假设的用途。\n'
    + '2. 【信息维度】枚举主题空间的信息维度（如：背景与现状、关键技术/机制、主要参与者与生态、数据与规模、趋势与未来、争议与风险、政策与监管、对比分析等，按主题取舍），这是后续覆盖度检查的基准。\n'
    + '3. 【多样性拆解】每个维度至少对应一个子问题（必要多样性定律：子问题集合的多样性必须覆盖主题空间的全部维度，否则必然存在盲区）；每个子问题给出：所属维度、搜索关键词线索（中英文）、验收标准 acceptance（怎样算回答了该子问题）。\n'
    + '4. 【覆盖度假设】列出 coverage_gaps：哪些维度你无法用子问题覆盖、或信息可能极难获取。这些会被后续研究轮实际验证——如果侦察发现信息其实可得，会自动补充研究；如果确实不可得，会作为已验证盲区写入报告。\n\n'
    + '只输出 JSON，不要输出任何其他文字。',
    {
      label: '规划',
      phase: '规划',
      schema: PLANNER_SCHEMA,
      ...(M.planner ? { model: M.planner } : {}),
    },
  )
  if (!planned || !Array.isArray(planned.questions) || planned.questions.length === 0) {
    throw new Error('规划子代理未返回有效子问题')
  }
  subs = planned.questions
  const dims = Array.isArray(planned.dimensions) ? planned.dimensions : []
  const gaps = Array.isArray(planned.coverage_gaps) ? planned.coverage_gaps : []
  planText = '研究答案空间：' + (planned.scope || '（未声明）')
    + '\n覆盖维度：' + (dims.length > 0 ? dims.join('、') : '（未声明）')
    + (gaps.length > 0 ? '\n规划假设的盲区（待验证）：' + gaps.join('、') : '')
  // 规划的盲区作为假设进入研究队列（超出 maxParallel 的部分留在队列里，
  // 由后续轮次处理，绝不静默丢弃）。
  subs = subs.concat(gaps.map((g) => ({ question: g, dimension: '盲区侦察', blind: true })))
}

phase('研究')
const researcherPrompt = (q, round, isFollowUp) => {
  const header = isFollowUp
    ? '这是第 ' + round + ' 轮补充研究，针对上一轮暴露的高优先级信息缺口：'
    : (q.blind
      ? '这是对规划阶段"盲区假设"的定向侦察：验证以下方面是否真的缺乏公开信息（若确实没有，明确写进 gaps，不要勉强编造）：'
      : '你的子问题：')
  return '你是深度研究子代理。你的任务不是"尽可能多搜索"，而是以最大信息增益为准则，'
    + '把对该子问题的条件不确定性降到可接受水平，然后立即停止。\n\n'
    + '研究主题：' + topic + '\n' + header + q.question
    + (q.dimension && !q.blind ? '\n所属维度：' + q.dimension : '')
    + (q.keywords ? '\n搜索关键词线索：' + q.keywords : '')
    + (q.acceptance ? '\n验收标准（怎样算回答完成）：' + q.acceptance : '')
    + '\n\n用内置的 web_search 工具搜索（若你的工具集中有 web_fetch，必要时可抓取具体页面；没有则只靠 web_search）。不要使用除 web_search / web_fetch 以外的工具。'
    + '\n\n感知-行动循环（每轮严格按此执行）：\n'
    + '第 0 步：根据已有知识写出你对子问题的当前最佳答案（哪怕不完整）。\n'
    + '第 1 步【预测】：列出当前最不确定的 1-3 个高熵点；为下一个查询选择预期信息增益（EIG）最高的一个，并写一句话：本轮查询针对哪个高熵点、预期新增什么信息、如果得到相反结果会如何改变答案。\n'
    + '第 2 步【行动】：执行该查询（web_search，中英文关键词都试；若你的工具集中有 web_fetch，必要时可抓取关键页面；没有则只靠 web_search）。\n'
    + '第 3 步【更新】：把新证据归入三态：confirmed（有可靠来源支撑的事实）/ uncertain（来源弱或相互矛盾的判断）/ gaps（仍未获得的信息，标注 high/medium/low 优先级）。\n'
    + '第 4 步【边际增益验证】：回答——本轮搜索是否新增了 confirmed 条目？是否改变或推翻了你之前的任何结论？'
    + '\n\n停止准则（信息论意义，满足其一即停，不要再搜）：\n'
    + '- 上一轮边际增益为零：没有新增 confirmed，也没有改变任何结论；\n'
    + '- 高优先级缺口已全部清空；\n'
    + '- 达到轮次硬上限：最多 ' + LIMIT + ' 轮搜索。\n\n'
    + '来源评估：权威性（政府/学术/行业机构优先）、时效性（优先近 3 年）、可靠性（有引用/数据支撑）。'
    + '可信度分级：A 政府/学术/国际组织；B 行业协会/企业白皮书；C 专业媒体；D 个人博客/自媒体。'
    + '只列你实际访问过的来源。宁可不确认，也不要编造——无法确认的点放进 uncertain 或 gaps。\n\n'
    + '输出 JSON（不要输出任何其他文字）：'
    + 'confirmed 数组（每条：claim 结论、source 来源URL、confidence high/medium/low）；'
    + 'uncertain 数组（point 不确定点、reason 原因）；'
    + 'gaps 数组（aspect 缺口方面、priority high/medium/low）。'
}

// ── 自适应研究闭环 ──────────────────────────────────────────────────────────
const results = {}
const rounds = []
let pending = subs.slice()
let round = 0
while (pending.length > 0 && round < depth + 1) {
  round += 1
  phase('研究·第' + round + '轮')
  const batch = pending.slice(0, maxParallel)
  const found = await parallel(batch.map((q, i) => () => agent(researcherPrompt(q, round, round > 1), {
    label: '研究' + (i + 1) + '·第' + round + '轮',
    phase: '研究·第' + round + '轮',
    schema: RESEARCHER_SCHEMA,
    ...(M.researcher ? { model: M.researcher } : {}),
  })))
  batch.forEach((q, i) => {
    if (found[i]) results[q.question] = found[i]
  })
  rounds.push(batch.map((q, i) => ({ q, f: found[i] })))

  // 收敛评估：收集本轮所有 high-priority 缺口 → 下一轮动态补充。
  const leads = []
  const seen = new Set()
  for (const item of batch) {
    const f = results[item.question]
    if (!f || !Array.isArray(f.gaps)) continue
    for (const g of f.gaps) {
      if (g.priority !== 'high') continue
      if (seen.has(g.aspect) || leads.length >= maxParallel) continue
      seen.add(g.aspect)
      leads.push({ question: g.aspect, followUp: true })
    }
  }
  pending = [...pending.slice(maxParallel), ...leads]
  // 队列语义：本轮未处理的子问题（超出 maxParallel 的部分）留在队首，
  // 下一轮继续研究；high-priority 缺口作为补充问题排在它们之后。
  // 边际信息增益收敛：本轮没有产出任何新的 high-priority 缺口 → 循环自然结束。
}

const ordered = []
const seenQ = new Set()
for (const batch of rounds) {
  for (const { q, f } of batch) {
    if (seenQ.has(q.question)) continue
    seenQ.add(q.question)
    ordered.push({ q, f })
  }
}
const parts = []
let okCount = 0
for (const { q, f } of ordered) {
  if (f) okCount += 1
  parts.push(f ? renderFindings(q, f) : '## ' + q.question + '\n\n> 该子问题研究失败（子代理未返回结构化证据）')
}
const totalRounds = rounds.length
const intermediate = '# ' + topic + ' — 深度研究中间结果（证据状态）\n\n> 子问题 ' + ordered.length
  + ' 个，完成 ' + okCount + ' 个，研究轮次 ' + totalRounds + ' 轮。'
  + (planText ? '\n\n' + planText : '') + '\n\n' + parts.join('\n\n---\n\n')

let report = intermediate
if (synthesize) {
  phase('综合')
  const final = await agent(
    '你是顶级行业分析师。你的产出是一次"有损压缩"：在报告长度（率）约束下，只保留对最终结论有区分度的信息，最大化决策有用性（最小化失真）。\n\n'
    + '报告主题：' + topic
    + (purpose ? '\n研究用途（要支撑的决策/判断）：' + purpose : '')
    + (planText ? '\n' + planText : '')
    + '\n\n报告结构：\n## 摘要（3-5 句核心结论，含整体置信度评估）\n## 1. 背景\n## 2. 核心发现（按维度组织，每条附置信度与来源引用）\n## 3. 不确定性与矛盾（明确列出：哪些结论置信度低、哪些来源相互矛盾——不确定性本身就是重要信息，必须保留而非掩盖）\n## 4. 信息缺口与已验证盲区（规划假设的盲区经研究验证后的真实状态）\n## 5. 结论与建议（给出基于现有证据的最优判断，标注证据强度）\n## 6. 参考资料'
    + '\n\n要求：所有关键信息行内引用来源 URL；区分事实（高置信）与推断（低置信）；矛盾信息要并列呈现；用表格/对比呈现适合的数据；避免泛泛而谈；中文输出，Markdown 格式；证据不足处明确说明，不要编造。\n\n以下是研究发现：\n\n' + intermediate,
    {
      label: '综合',
      phase: '综合',
      ...(M.synthesizer ? { model: M.synthesizer } : {}),
    },
  )
  if (final) report = final + '\n\n---\n\n## 附录：原始证据状态\n\n' + intermediate
}

let reviewText = null
if (review) {
  phase('审查')
  reviewText = await agent(
    '你是研究审阅代理。你的角色是信道纠错：对报告做对抗性审查，找出证据链中的噪声与错误。若你的工具集中有 web_fetch，可用它抽查可疑来源 URL 是否真实可达、内容是否支撑引用；没有则依据 web_search 可得信息评估来源可信度。\n\n'
    + '审查维度：\n'
    + '1. 引用纠错：URL 无法访问或与结论无关？引用是否支撑对应观点？（幻觉来源 = 信道噪声，必须标出）\n'
    + '2. 覆盖度审计：对照规划阶段声明的信息维度，哪些维度证据不足或完全缺失？（Ashby 必要多样性：维度缺失 = 控制器多样性不足 = 盲区）\n'
    + '3. 信息矛盾：不同来源冲突处是否被标注并保留？\n'
    + '4. 时效性：关键数据是否过时？\n'
    + '5. 过度自信：是否有低置信结论被表述为确定事实？\n'
    + (planText ? '\n规划阶段声明：\n' + planText : '')
    + '\n\n只输出审查意见（Markdown，中文），不要改写报告本身：\n## 审查意见\n### 可疑来源（如有）\n### 覆盖盲区（如有）\n### 信息矛盾\n### 过度自信项\n### 需要补充研究的最高优先级缺口（如有，供下一步定向研究）\n### 总体评估与修正建议\n\n报告主题：' + topic + '\n\n以下是待审查报告：\n\n' + report,
    {
      label: '审查',
      phase: '审查',
      ...(M.reviewer ? { model: M.reviewer } : {}),
    },
  )
  if (reviewText) reviewText = '## 对抗性审查意见\n\n' + reviewText
}

return {
  report,
  review: reviewText,
  rounds: totalRounds,
  subquestions: ordered.length,
  completed: okCount,
  failed: ordered.length - okCount,
}
`

/** Apply the plugin: register the `deep_research` tool on `ctx.tools`. */
export function apply(ctx: Context, config: Config = {}) {
  const subagentProvider = config.subagentProvider ?? undefined
  const plannerModel = config.plannerModel ?? undefined
  const researcherModel = config.researcherModel ?? undefined
  const synthesizerModel = config.synthesizerModel ?? undefined
  const reviewerModel = config.reviewerModel ?? synthesizerModel
  // null/undefined both mean "leave the engine default" (old JS contract:
  // positiveInt(..., undefined, ...) omitted the key — keep it omitted).
  const maxTotalAgents = config.maxTotalAgents === undefined || config.maxTotalAgents === null
    ? undefined
    : positiveInt(config.maxTotalAgents, 0, 'maxTotalAgents')
  const maxParallel = config.maxParallel === undefined
    ? 4
    : positiveInt(config.maxParallel, 4, 'maxParallel')

  ctx.tools.register(defineTool({
    name: 'deep_research',
    description:
      '深度研究编排工具（Deep Research Orchestrator，基于 DSH 官方 workflow 引擎，按控制论与'
      + '信息论设计的自适应流程）。当用户要求对复杂主题做深度研究/调研（需要多源信息搜集、'
      + '交叉验证、撰写调研报告）时调用。流程是活的，不是固定脚本：规划子代理先定义答案空间、'
      + '按信息维度拆解子问题并声明盲区假设 → 研究阶段是自适应闭环——第一轮并行研究所有子问题，'
      + '每轮结束收集高优先级信息缺口，自动派发下一轮补充研究（规划盲区也会被定向侦察验证），'
      + '直到某一轮边际信息增益为零或达到轮次上限（简单主题一轮收敛，复杂主题自动扩展）→ '
      + '综合子代理按率失真原则压缩为最终报告（保留不确定性与已验证盲区）→ 可选对抗性审查'
      + '（引用纠错 + 覆盖度审计）。触发场景：深度研究、调研、多源信息综合分析、研究报告、'
      + '文献/资料搜集。若需求模糊，先向用户澄清（用途/范围）再调用；若你已有具体问题清单，'
      + '直接传 questions 可跳过自动拆解。',
    parameters: {
      topic: {
        type: 'string',
        required: true,
        description: '研究主题。',
      },
      purpose: {
        type: 'string',
        description: '可选：研究用途——这份研究要支撑什么判断/决策。用于定义答案空间；缺省时规划子代理会声明假设的用途。',
      },
      questions: {
        type: 'string',
        description: '可选：已有研究问题清单（每行一个，或 1. 2. 3. 编号）。提供后跳过自动拆解阶段。',
      },
      depth: {
        type: 'number',
        description: '研究精度（容差）：1=初步（研究闭环最多2轮），2=深入（默认，最多3轮），3=穷尽（最多4轮）。',
      },
      synthesize: {
        type: 'boolean',
        description: '是否让综合子代理撰写最终报告（默认 true）。false 时只返回各子问题的三态证据，由你撰写。',
      },
      review: {
        type: 'boolean',
        description: '是否让审阅子代理做对抗性审查（默认 false）：引用纠错、覆盖度审计、矛盾与过度自信标注，并给出需要补充研究的最高优先级缺口。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          report: { type: 'string', required: true },
          review: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok
          ? (value.review !== undefined ? `${value.report}\n\n${value.review}` : value.report)
          : `deep_research 未能完成研究：${value.report}`,
      }],
    },
    async execute(args, exec) {
      const parent = exec.agent
      if (!parent) {
        throw new Error('deep_research requires a calling agent (exec.agent was undefined)')
      }
      // Runtime guard instead of an inject: keep profiles without a workflow
      // engine loadable (see the `inject` note above).
      const workflows: Context['workflows'] | undefined = ctx.workflows
      if (workflows === undefined) {
        throw new Error(
          'dsh-deep-research: the workflows service is unavailable in this profile '
          + '(no workflow engine provider). deep_research needs DSH\'s official workflow '
          + 'engine: use a profile/composition that provides it (e.g. tui/headless) '
          + 'or register a workflows provider first.',
        )
      }

      const topic = String(args.topic).trim()
      if (topic.length === 0) throw new Error('deep_research: topic must not be empty')
      const purpose = typeof args.purpose === 'string' && args.purpose.trim().length > 0
        ? args.purpose.trim()
        : undefined
      const depth = args.depth === undefined ? 2 : positiveInt(args.depth, 2, 'depth')
      if (depth > 3) {
        throw new Error('dsh-deep-research: depth must be 1, 2 or 3 (1=初步，2=深入，3=穷尽)')
      }
      const synthesize = args.synthesize !== false
      const review = args.review === true
      const questions = parseQuestionList(args.questions)

      const models: Record<string, string> = {}
      if (plannerModel !== undefined) models.planner = plannerModel
      if (researcherModel !== undefined) models.researcher = researcherModel
      if (synthesizerModel !== undefined) models.synthesizer = synthesizerModel
      if (reviewerModel !== undefined) models.reviewer = reviewerModel

      const run = workflows.start({
        script: SCRIPT,
        meta: {
          name: 'deep-research',
          description: 'Adaptive deep research: answer-space definition, dimension coverage, EIG-driven research rounds, rate-distortion synthesis, optional error-correcting review.',
          whenToUse: 'Deep research / investigation tasks needing multi-source evidence and a cited report.',
          phases: [
            { title: '规划', detail: 'Answer-space definition + dimension coverage decomposition' },
            { title: '研究', detail: 'Adaptive research rounds over built-in web tools' },
            // The engine matches phase() calls by exact title (workflow/types.ts); the
            // script calls '研究·第N轮' with N up to depth+1 (depth contract: 1-3).
            { title: '研究·第1轮', detail: 'Adaptive research round over built-in web tools' },
            { title: '研究·第2轮', detail: 'Adaptive research round over built-in web tools' },
            { title: '研究·第3轮', detail: 'Adaptive research round over built-in web tools' },
            { title: '研究·第4轮', detail: 'Adaptive research round over built-in web tools' },
            { title: '综合', detail: 'Rate-distortion report synthesis' },
            { title: '审查', detail: 'Opt-in error-correcting adversarial review' },
          ],
        } satisfies WorkflowMeta,
        args: {
          topic,
          ...(purpose !== undefined ? { purpose } : {}),
          ...(questions.length > 0 ? { questions } : {}),
          depth,
          synthesize,
          review,
          maxParallel,
          ...(Object.keys(models).length > 0 ? { models } : {}),
        },
        ...(subagentProvider !== undefined ? { subagentProvider } : {}),
        ...(maxTotalAgents !== undefined ? { maxTotalAgents } : {}),
        parent,
        signal: exec.signal,
      })

      const result = await run.result
      await run.dispose()

      if (result.stopReason !== 'completed') {
        throw new Error(`deep_research: workflow run ${result.stopReason}${result.error !== undefined ? ` (${result.error})` : ''}`)
      }
      const raw: unknown = result.value
      if (raw === null || typeof raw !== 'object') {
        throw new Error('deep_research: workflow returned no report')
      }
      const record = raw as Record<string, unknown>
      if (typeof record.report !== 'string') {
        throw new Error('deep_research: workflow returned no report')
      }
      return {
        ok: true,
        report: record.report,
        ...(typeof record.review === 'string' ? { review: record.review } : {}),
      }
    },
  }))
}

// ── helpers ─────────────────────────────────────────────────────────────────

function parseQuestionList(raw: string | undefined): Array<{ question: string; keywords?: undefined }> {
  if (typeof raw !== 'string') return []
  return raw
    .split('\n')
    .map(line => line.replace(/^\s*(?:\d+[.、)])?\s*/, '').trim())
    .filter(line => line.length > 0)
    .map(question => ({ question, keywords: undefined }))
}

function positiveInt(value: unknown, fallback: number, label: string): number {
  if (value === undefined || value === null) return fallback
  const n = Number(value)
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`dsh-deep-research: ${label} must be a positive integer`)
  }
  return n
}
