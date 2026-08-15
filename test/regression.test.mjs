/**
 * dsh-deep-research 回归测试。
 *
 * 运行：cd plugins/dsh-deep-research && node --test
 *（零依赖：不 import src/index.ts 的依赖，纯 node + 内置 node:test/node:vm。
 *  Node ≤20 也可用 node --test test/；Node 22+ 把位置参数当 glob，目录参数
 *  需写成 node --test 'test/**' 或直接用默认发现 node --test。）
 *
 * 机制（镜像引擎）：
 * - 从 src/index.ts 抽取 SCRIPT（String.raw 字面量），按模块加载时的行为插值
 *   ${JSON.stringify(PLANNER_SCHEMA)} / ${JSON.stringify(RESEARCHER_SCHEMA)}；
 * - 用与引擎 runtime.ts 相同的 vm.Script 包装 '(async () => { body })()' 求值，
 *   全局钩子 phase / log / args / agent（按 label 从 mock 队列取值）/
 *   parallel（Promise.all 并发执行 thunk）；
 * - 工具注册层：优先动态 import 真实模块（tsx/DSH 环境，Node ≥22.18 原生类型
 *   剥离直接 import .ts）；纯 node 下依赖不可解析（ERR_MODULE_NOT_FOUND）时
 *   退化为在 vm 中求值模块源码——先经 node:module 的 stripTypeScriptTypes 剥离
 *   类型（原生剥离要求 erasable-only 语法，剥离失败会响亮抛错）。
 *
 * 场景映射：
 *   ① 跳过规划（questions 已给）：单轮研究 → rounds=1，报告含子问题与证据
 *   ② 自适应闭环：high-priority 缺口自动派发第 2 轮补充研究
 *   ③ 规划路径：无 questions 时先规划，盲区假设进入侦察队列
 *   ④ 工具注册：deep_research 注册、输出 schema 在引擎受支持子集内
 *   ⑤ 参数校验：空 topic / depth>3 抛错；questions 解析为数组透传；
 *      models / maxParallel 默认值透传；maxTotalAgents null 不写入请求
 *   ⑥ 队列语义：子问题超过 maxParallel 时跨轮续研，绝不静默丢弃
 *   ⑦ 可选 workflows：无 provider 的 profile 照常加载；工具调用时报明确错误
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { test } from 'node:test'
import vm from 'node:vm'

const SRC_URL = new URL('../src/index.ts', import.meta.url)
const SRC = readFileSync(SRC_URL, 'utf8')

// ── 脚本抽取：与 src/index.ts 中定义逐字一致的 schema 常量 ────────────────

const PLANNER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    scope: { type: 'string' },
    dimensions: { type: 'array', items: { type: 'string' } },
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
    coverage_gaps: { type: 'array', items: { type: 'string' } },
  },
  required: ['scope', 'dimensions', 'questions', 'coverage_gaps'],
}

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

/** 抽取 String.raw 脚本字面量并复现模块加载时的 ${...} 插值。 */
function extractScript(name) {
  const marker = `const ${name} = String.raw\``
  const start = SRC.indexOf(marker) + marker.length
  if (start < marker.length) throw new Error(`extract failed: ${name} marker not found`)
  const end = SRC.indexOf('`', start)
  if (end < 0) throw new Error(`extract failed: ${name} closing backtick not found`)
  let body = SRC.slice(start, end)
  body = body.replaceAll('${JSON.stringify(PLANNER_SCHEMA)}', JSON.stringify(PLANNER_SCHEMA))
  body = body.replaceAll('${JSON.stringify(RESEARCHER_SCHEMA)}', JSON.stringify(RESEARCHER_SCHEMA))
  if (body.includes('${')) {
    throw new Error(`unexpected interpolation remains in ${name}: ${body.match(/\$\{[^}]*\}/)?.[0] ?? ''}`)
  }
  return body
}

const SCRIPT = extractScript('SCRIPT')

// ── 引擎包装镜像：vm.Script '(async () => { body })()' + 全局钩子 ───────────

const mk = (issues) => ({ confirmed: issues, uncertain: [], gaps: [] })

/**
 * 在 vm 中执行脚本体。roles 按 agent label 提供 mock 队列（null = 子代理失败；
 * 函数 = 以 (prompt, opts) 调用）。队列耗尽或出现未预料的 label 时抛错（响亮失败）。
 * @returns {Promise<{result: any, prompts: Array<{label: string, opts: any}>}>}
 */
async function runScript(body, args, roles = {}) {
  const state = { idx: {}, prompts: [] }
  const take = (key) => {
    const queue = roles[key]
    if (!queue) throw new Error(`unexpected agent call for role "${key}" (no mock provided)`)
    const i = state.idx[key] ?? 0
    if (i >= queue.length) throw new Error(`mock queue exhausted for role "${key}" (${queue.length} entries)`)
    state.idx[key] = i + 1
    return queue[i]
  }
  const context = vm.createContext({})
  context.phase = Object.freeze(() => {})
  context.log = Object.freeze(() => {})
  context.args = args
  context.parallel = Object.freeze((thunks) => Promise.all(thunks.map((t) => t())))
  context.agent = Object.freeze((prompt, opts = {}) => {
    const label = opts.label ?? ''
    state.prompts.push({ label, prompt, opts })
    const role = label.startsWith('研究') ? 'researcher'
      : label === '规划' ? 'planner'
        : label === '综合' ? 'synthesizer'
          : label === '审查' ? 'reviewer'
            : null
    if (!role) throw new Error('unexpected agent label: ' + label)
    if (!opts.schema) throw new Error(`${label} 调用缺少 opts.schema（结构化 agent 契约）`)
    const value = take(role)
    return typeof value === 'function' ? value(prompt, opts) : value
  })
  const script = new vm.Script(`(async () => {\n${body}\n})()`, { filename: 'workflow:deep-research-test' })
  const result = await Promise.resolve(script.runInContext(context))
  return { result, prompts: state.prompts }
}

/** vm 求值产生的数组/对象属于 vm realm，deepStrictEqual 会因原型不同误报——JSON 往返转宿主值。 */
const plain = (value) => JSON.parse(JSON.stringify(value))

// ════════════════════════════════════════════════════════════════════════════
// ① 跳过规划（questions 已给）：单轮研究，收敛后返回证据状态报告
// ════════════════════════════════════════════════════════════════════════════
test('① 已给 questions：跳过规划，单轮研究收敛', async () => {
  const { result, prompts } = await runScript(SCRIPT, {
    topic: 'T',
    questions: [{ question: 'Q1', dimension: 'd1' }],
    depth: 1,
    synthesize: false,
    review: false,
    maxParallel: 4,
  }, {
    researcher: [mk([{ claim: 'C1', source: 'https://example.com', confidence: 'high' }])],
  })
  assert.strictEqual(prompts.length, 1, '只应有一次研究调用（无规划/综合/审查）')
  assert.strictEqual(prompts[0].label, '研究1·第1轮')
  assert.strictEqual(prompts[0].opts.phase, '研究·第1轮')
  assert.deepEqual(plain(prompts[0].opts.schema), plain(RESEARCHER_SCHEMA), '研究调用带 RESEARCHER_SCHEMA')
  assert.strictEqual(result.rounds, 1)
  assert.strictEqual(result.subquestions, 1)
  assert.strictEqual(result.completed, 1)
  assert.strictEqual(result.failed, 0)
  assert.strictEqual(result.review, null)
  assert.ok(result.report.includes('## Q1'), '报告应含子问题标题')
  assert.ok(result.report.includes('C1'), '报告应含已确认事实')
  assert.ok(result.report.includes('子问题 1 个，完成 1 个，研究轮次 1 轮'), '报告应含证据状态统计')
})

// ════════════════════════════════════════════════════════════════════════════
// ② 自适应闭环：high-priority 缺口自动派发下一轮补充研究
// ════════════════════════════════════════════════════════════════════════════
test('② high-priority 缺口自动进入第 2 轮，直到边际增益为零', async () => {
  const { result, prompts } = await runScript(SCRIPT, {
    topic: 'T',
    questions: [{ question: 'Q1', dimension: 'd1' }],
    depth: 2,
    synthesize: false,
    review: false,
    maxParallel: 4,
  }, {
    researcher: [
      { confirmed: [{ claim: 'C1', source: 's1', confidence: 'high' }], uncertain: [], gaps: [{ aspect: 'G1', priority: 'high' }] },
      { confirmed: [{ claim: 'G1 已确认', source: 's2', confidence: 'medium' }], uncertain: [], gaps: [] },
    ],
  })
  assert.strictEqual(result.rounds, 2, '第1轮产出 high 缺口 → 自动第2轮')
  assert.strictEqual(result.subquestions, 2, '两轮子问题都在报告里')
  assert.strictEqual(result.completed, 2)
  assert.ok(result.report.includes('## G1'), '补充研究的问题应入报告')
  assert.ok(result.report.includes('G1 已确认'), '第2轮证据应入报告')
  assert.strictEqual(prompts.length, 2)
  assert.strictEqual(prompts[1].label, '研究1·第2轮', '第2轮是补充研究（follow-up 提示词）')
  assert.ok(prompts[1].prompt.includes('补充研究'), '第2轮提示词应标注补充研究')
})

// ════════════════════════════════════════════════════════════════════════════
// ③ 规划路径：无 questions 时先规划，盲区假设进入侦察队列
// ════════════════════════════════════════════════════════════════════════════
test('③ 无 questions：规划 → 盲区侦察进入第 2 轮', async () => {
  const { result, prompts } = await runScript(SCRIPT, {
    topic: 'T',
    depth: 1,
    synthesize: false,
    review: false,
    maxParallel: 4,
  }, {
    planner: [() => ({
      scope: '支撑决策 D',
      dimensions: ['d1'],
      questions: [{ question: 'Q1', dimension: 'd1' }],
      coverage_gaps: ['盲区X'],
    })],
    researcher: [
      mk([{ claim: 'C1', source: 's1', confidence: 'high' }]),
      mk([{ claim: '盲区X 确实无公开信息', source: '', confidence: 'low' }]),
    ],
  })
  assert.strictEqual(prompts[0].label, '规划', '先规划')
  assert.deepEqual(plain(prompts[0].opts.schema), plain(PLANNER_SCHEMA), '规划调用带 PLANNER_SCHEMA')
  // 盲区侦察与规划问题同轮并行（subs.concat 在循环前），不额外消耗轮次
  assert.strictEqual(result.rounds, 1, '盲区侦察并入第1轮')
  assert.strictEqual(result.subquestions, 2, '规划问题 + 盲区侦察都在报告里')
  assert.ok(result.report.includes('研究答案空间：支撑决策 D'), '报告应含规划答案空间')
  assert.ok(result.report.includes('盲区X'), '盲区侦察结果应入报告')
  const blindPrompt = prompts.find((p) => p.label === '研究2·第1轮')
  assert.ok(blindPrompt && blindPrompt.prompt.includes('盲区假设'), '侦察调用提示词应标注盲区假设')
})

// ════════════════════════════════════════════════════════════════════════════

let pluginPromise = null
function loadPlugin() {
  if (!pluginPromise) {
    pluginPromise = (async () => {
      try {
        const mod = await import(SRC_URL.href)
        return { mod, mode: 'real-import' }
      } catch (err) {
        if (err.code !== 'ERR_MODULE_NOT_FOUND') throw err
        return { mod: evaluateModuleInVm(), mode: 'vm-mock' }
      }
    })()
  }
  return pluginPromise
}

/** 在 vm 中求值模块源码：先剥离类型（原生类型剥离契约），再移除 import/export，注入 mock defineTool。 */
function evaluateModuleInVm() {
  let src = SRC
  src = stripTypeScriptTypes(src) // throws on non-erasable syntax — keeps the source portable
  src = src.replace("import { defineTool } from '@deepseek-ai/dsh-tools'", '')
  src = src.replaceAll(/\bexport\s+/g, '')
  src += '\n;globalThis.__drExports = { name, inject, apply, SCRIPT, PLANNER_SCHEMA, RESEARCHER_SCHEMA }\n'
  const defs = []
  const context = vm.createContext({
    // 镜像 defineTool 的编译契约（dsh-tools schema.ts 子集）：
    // 输出 schema 编译 + 受支持子集断言 + execute 参数校验。
    defineTool: (def) => {
      const parameters = compileParameterSchema(def.parameters)
      const outputSchema = compileOutputSchema(def.output.schema)
      const compiled = {
        ...def,
        parameters,
        output: { ...def.output, schema: outputSchema },
        execute: async (args, exec) => {
          const violations = validateJsonSchemaValue(parameters, args, '')
          if (violations.length > 0) {
            throw new Error('INVALID_ARGS: ' + violations.join('; '))
          }
          return def.execute(args, exec)
        },
      }
      defs.push(compiled)
      return compiled
    },
  })
  new vm.Script(src, { filename: 'dsh-deep-research-lib' }).runInContext(context)
  return { ...context.__drExports, __defs: defs }
}

// ── 移植自 @deepseek-ai/dsh-tools 的 schema 子集（与 dsh-inspect 测试同源）──

const SCHEMA_TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']
const SCHEMA_ANNOTATIONS = ['description', 'title', 'default', 'examples']

function isSchemaRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function compileValueSchema(input, path) {
  if (!isSchemaRecord(input)) throw new Error(`unsupported schema: ${path} must be a value schema object`)
  const node = {}
  switch (input.type) {
    case 'object': {
      node.type = 'object'
      node.additionalProperties = input.additionalProperties
      if (Object.hasOwn(input, 'properties')) {
        const compiled = compilePropertyMap(input.properties, `${path}.properties`)
        node.properties = compiled.properties
        if (compiled.required.length > 0) node.required = compiled.required
      }
      break
    }
    case 'array': {
      node.type = 'array'
      if (Object.hasOwn(input, 'items')) node.items = compileValueSchema(input.items, `${path}.items`)
      break
    }
    case 'string':
    case 'number':
    case 'integer':
    case 'boolean':
    case 'null': {
      node.type = input.type
      if (Object.hasOwn(input, 'enum')) node.enum = input.enum
      break
    }
    default:
      throw new Error(`unsupported schema: ${path}.type must be within the value schema DSL`)
  }
  return node
}

function compilePropertyMap(input, path) {
  const properties = {}
  const required = []
  for (const [key, prop] of Object.entries(input)) {
    const p = `${path}.${key}`
    if (!isSchemaRecord(prop)) throw new Error(`unsupported schema: ${p} must be a value schema object`)
    if (Object.hasOwn(prop, 'required')) {
      if (prop.required !== true) throw new Error(`unsupported schema: ${p}.required must be true when present`)
      required.push(key)
    }
    properties[key] = compileValueSchema(prop, p)
  }
  return { properties, required }
}

function compileOutputSchema(spec) {
  const schema = compileValueSchema(spec, 'schema')
  assertSupportedJsonSchema(schema)
  return schema
}

function compileParameterSchema(spec) {
  const compiled = compilePropertyMap(spec, 'parameters')
  const schema = { type: 'object', properties: compiled.properties }
  if (compiled.required.length > 0) schema.required = compiled.required
  assertSupportedJsonSchema(schema)
  return schema
}

function assertSupportedJsonSchema(schema) {
  const violations = []
  checkSchemaNode(schema, 'schema', violations)
  if (violations.length > 0) {
    throw new Error('unsupported JSON schema: ' + violations.join('; '))
  }
}

function checkSchemaNode(node, path, violations) {
  if (!isSchemaRecord(node)) {
    violations.push(`${path} must be a schema object`)
    return
  }
  for (const key of Object.keys(node)) {
    if (['type', 'properties', 'required', 'additionalProperties', 'items', 'enum'].includes(key)) continue
    if (SCHEMA_ANNOTATIONS.includes(key)) continue
    violations.push(`${path}.${key} is not a supported keyword`)
  }
  const type = node.type
  if (typeof type !== 'string' || !SCHEMA_TYPES.includes(type)) {
    violations.push(`${path}.type must be one of ${SCHEMA_TYPES.join('/')}`)
    return
  }
  if (type === 'object') {
    if (Object.hasOwn(node, 'properties')) {
      for (const [key, child] of Object.entries(node.properties)) {
        checkSchemaNode(child, `${path}.properties.${key}`, violations)
      }
    }
    if (Object.hasOwn(node, 'required')) {
      const required = node.required
      if (!Array.isArray(required) || required.some((x) => typeof x !== 'string')) {
        violations.push(`${path}.required must be an array of strings`)
      }
    }
  } else if (type === 'array') {
    if (Object.hasOwn(node, 'items')) checkSchemaNode(node.items, `${path}.items`, violations)
  }
}

function validateJsonSchemaValue(schema, value, path = 'value') {
  const violations = []
  checkValue(schema, value, path, violations)
  return violations
}

function checkValue(node, value, path, violations) {
  switch (node.type) {
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        violations.push(`"${path}" must be an object`)
        return
      }
      const properties = node.properties ?? {}
      for (const key of node.required ?? []) {
        if (!Object.hasOwn(value, key) || value[key] === undefined) {
          violations.push(`missing required property "${path}.${key}"`)
        }
      }
      for (const [key, child] of Object.entries(properties)) {
        if (!Object.hasOwn(value, key) || value[key] === undefined) continue
        checkValue(child, value[key], `${path}.${key}`, violations)
      }
      break
    }
    case 'array': {
      if (!Array.isArray(value)) {
        violations.push(`"${path}" must be an array`)
        return
      }
      if (node.items !== undefined) {
        value.forEach((item, i) => checkValue(node.items, item, `${path}[${i}]`, violations))
      }
      break
    }
    default: {
      if (typeof value !== node.type) {
        violations.push(`"${path}" must be a ${node.type}`)
        return
      }
      if (node.enum !== undefined && !node.enum.includes(value)) {
        violations.push(`"${path}" must be one of ${JSON.stringify(node.enum)}`)
      }
    }
  }
}

/** stub ctx + stub workflows.start；value 为脚本返回值。 */
function stubContext(value) {
  const defs = []
  const requests = []
  const ctx = {
    tools: { register: (def) => defs.push(def) },
    workflows: {
      start: (request) => {
        requests.push(request)
        return {
          result: Promise.resolve({ stopReason: 'completed', value }),
          cancel: () => {},
          dispose: async () => {},
          id: 'run-1',
        }
      },
    },
  }
  // 模拟 cordis 宽松读取：ctx.get(name) 不做 inject 检查
  ctx.get = (name) => ctx[name]
  return { ctx, defs, requests }
}

// ════════════════════════════════════════════════════════════════════════════
// ④ 工具注册：deep_research 注册、输出 schema 在引擎受支持子集内
// ════════════════════════════════════════════════════════════════════════════
test('④ 工具注册与输出 schema 编译通过', async () => {
  const { mod, mode } = await loadPlugin()
  const { ctx, defs } = stubContext({ report: 'r' })
  assert.doesNotThrow(() => mod.apply(ctx, {}), `${mode} 路径下工具注册/编译应通过`)
  assert.strictEqual(defs.length, 1, '应只注册一个工具')
  const def = defs[0]
  assert.strictEqual(def.name, 'deep_research')
  assert.strictEqual(mod.name, 'dsh-deep-research')
  assert.deepEqual(plain(mod.inject), ['tools'], 'inject 只声明 tools（workflows 为可选运行时能力，不再 inject——否则无 provider 的 profile 会挂死启动）')
  assert.doesNotThrow(() => assertSupportedJsonSchema(def.output.schema), 'output.schema 应在引擎受支持子集内')
  assert.doesNotThrow(() => assertSupportedJsonSchema(def.parameters), 'parameters 应编译为受支持的对象 schema')
  const valid = { ok: true, report: '# r', review: '审阅' }
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, valid), [], '合法输出通过')
  assert.ok(validateJsonSchemaValue(def.output.schema, { ok: true }).length > 0, '缺 report 被拒')
})

// ════════════════════════════════════════════════════════════════════════════
// ⑤ 参数校验与请求透传
// ════════════════════════════════════════════════════════════════════════════
test('⑤ 参数校验：空 topic / depth>3 抛错，不进入 workflows.start', async () => {
  const { mod } = await loadPlugin()
  const { ctx, defs, requests } = stubContext({ report: 'r' })
  mod.apply(ctx, {})
  const def = defs[0]
  const exec = { agent: { id: 'parent' }, signal: new EventTarget() }

  await assert.rejects(def.execute({ topic: '   ' }, exec), /topic must not be empty/)
  await assert.rejects(def.execute({ topic: 'T', depth: 4 }, exec), /depth must be 1, 2 or 3/)
  assert.strictEqual(requests.length, 0, '校验失败时不进入 workflows.start')

  const ok = await def.execute({ topic: 'T', depth: 1, questions: '1. Q1\n2. Q2' }, exec)
  assert.strictEqual(ok.ok, true)
  assert.strictEqual(requests.length, 1)
  const req = requests[0]
  assert.strictEqual(req.script, SCRIPT, '透传的脚本与模块中的 SCRIPT 一致')
  assert.strictEqual(req.meta.name, 'deep-research')
  assert.strictEqual(req.parent.id, 'parent', 'parent 透传给引擎')
  assert.strictEqual(req.signal, exec.signal, 'signal 透传给引擎')
  assert.deepEqual(plain(req.args.questions), [
    { question: 'Q1' },
    { question: 'Q2' },
  ], 'questions 解析为数组透传')
  assert.strictEqual(req.args.depth, 1)
  assert.strictEqual(req.args.synthesize, true, 'synthesize 默认 true')
  assert.strictEqual(req.args.review, false, 'review 默认 false')
  assert.strictEqual(req.args.maxParallel, 4, 'maxParallel 默认 4')
  assert.ok(!('models' in req.args), '未配置 models 时不传 models 键')
  assert.ok(!('subagentProvider' in req), '未配置时不传 subagentProvider')

  // 配置透传：models / maxParallel / subagentProvider
  const { ctx: ctx2, defs: defs2, requests: requests2 } = stubContext({ report: 'r' })
  mod.apply(ctx2, {
    plannerModel: 'pm',
    researcherModel: 'rm',
    maxParallel: 2,
    subagentProvider: 'fork',
    maxTotalAgents: 7,
  })
  await defs2[0].execute({ topic: 'T', depth: 2 }, exec)
  const req2 = requests2[0]
  assert.deepEqual(plain(req2.args.models), { planner: 'pm', researcher: 'rm' }, '角色模型透传')
  assert.strictEqual(req2.args.maxParallel, 2)
  assert.strictEqual(req2.subagentProvider, 'fork')
  assert.strictEqual(req2.maxTotalAgents, 7)

  // maxTotalAgents 为 null/undefined 时请求省略该键（引擎用默认上限），
  // 绝不写入 0（引擎对 <1 的 maxTotalAgents 直接 INVALID_ARGUMENT）。
  const { ctx: nullCtx, defs: nullDefs, requests: nullReqs } = stubContext({ report: 'r' })
  mod.apply(nullCtx, { maxTotalAgents: null })
  await nullDefs[0].execute({ topic: 'T' }, exec)
  assert.strictEqual(nullReqs.length, 1)
  assert.ok(!('maxTotalAgents' in nullReqs[0]), 'maxTotalAgents: null 不写入请求（引擎默认）')
})

// ════════════════════════════════════════════════════════════════════════════
// ⑥ 队列语义：子问题超过 maxParallel 时绝不静默丢弃（跨轮续研）
// ════════════════════════════════════════════════════════════════════════════
test('⑥ 子问题超过 maxParallel：剩余问题进入下一轮，全部被研究', async () => {
  const questions = ['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6'].map((q) => ({ question: q, dimension: 'd' }))
  const { result, prompts } = await runScript(SCRIPT, {
    topic: 'T',
    questions,
    depth: 2, // 3 轮上限 × maxParallel 2 = 6，恰好全部研究
    synthesize: false,
    review: false,
    maxParallel: 2,
  }, {
    researcher: [
      { confirmed: [{ claim: 'C1', source: 's1', confidence: 'high' }], uncertain: [], gaps: [] },
      { confirmed: [{ claim: 'C2', source: 's2', confidence: 'high' }], uncertain: [], gaps: [] },
      { confirmed: [{ claim: 'C3', source: 's3', confidence: 'high' }], uncertain: [], gaps: [] },
      { confirmed: [{ claim: 'C4', source: 's4', confidence: 'high' }], uncertain: [], gaps: [] },
      { confirmed: [{ claim: 'C5', source: 's5', confidence: 'high' }], uncertain: [], gaps: [] },
      { confirmed: [{ claim: 'C6', source: 's6', confidence: 'high' }], uncertain: [], gaps: [] },
    ],
  })
  assert.strictEqual(result.rounds, 3, '6 个问题按 maxParallel=2 分 3 轮研究')
  assert.strictEqual(result.subquestions, 6, '所有子问题都被研究（无静默丢弃）')
  assert.strictEqual(result.completed, 6)
  for (const q of questions) {
    assert.ok(result.report.includes('## ' + q.question), `报告应含 ${q.question}`)
  }
  assert.strictEqual(prompts.length, 6)
  assert.deepEqual(prompts.map((p) => p.label), [
    '研究1·第1轮', '研究2·第1轮',
    '研究1·第2轮', '研究2·第2轮',
    '研究1·第3轮', '研究2·第3轮',
  ], '两两分轮，轮次递增')
})

// ════════════════════════════════════════════════════════════════════════════
// ⑦ 无 workflows provider 的 profile（如标准 web 组合）：插件照常加载，
//    工具调用时报明确错误，而不是 inject 未满足 → Loader EntryGroup 永久
//    pending → 整棵插件树挂死 → 进程启动约 40s 后静默退出（exit 0）。
// ════════════════════════════════════════════════════════════════════════════
test('⑦ 无 workflows provider：apply 正常注册，execute 报明确错误', async () => {
  const { mod } = await loadPlugin()
  const defs = []
  // 刻意不含 workflows 服务（标准 web profile 的服务集合）
  const ctx = { tools: { register: (def) => defs.push(def) }, get: () => undefined }
  assert.doesNotThrow(() => mod.apply(ctx, {}), '无 workflows 服务时 apply 应照常注册工具（启动不挂死）')
  assert.strictEqual(defs.length, 1)
  assert.strictEqual(defs[0].name, 'deep_research')
  const exec = { agent: { id: 'parent' }, signal: new EventTarget() }
  await assert.rejects(
    defs[0].execute({ topic: 'T' }, exec),
    /workflows service is unavailable .*workflow engine provider/s,
    '调用时应给出指向 workflow 引擎缺失的明确错误',
  )
})
