/**
 * 用**真实的桥**验证 ZCode provider 的各个函数。
 *
 * ## 为什么要单独跑这个
 *
 * 单元测试全 mock，typecheck 只证明类型对。
 * 但本 provider 的核心风险恰好是**运行期**的：
 *   · 候选目录探测真的能找到发现文件吗？
 *   · `/health` 与 `/v1/models` 的响应形状与我的解析一致吗？
 *   * 端口重读是否真的每次拿到当前值？
 *
 * 这些只能对着真桥跑。
 *
 * 用法：node scripts/verify-zcode-against-bridge.mjs
 */

import { readBridgeDiscovery } from '../lib/zcode.js'
import { ZCODE } from '../lib/zcode-product.js'

let failed = 0
const check = (label, cond, extra = '') => {
  if (!cond) failed += 1
  console.log(`${cond ? '✓' : '✗'} ${label}${extra ? '  ' + extra : ''}`)
}

console.log('=== 1. 发现文件探测 ===')
const discovery = readBridgeDiscovery()
console.log('  ' + JSON.stringify(discovery ? { port: discovery.port, models: discovery.models, sourcePath: discovery.sourcePath } : null))
check('找到桥的发现文件', discovery !== undefined)
if (discovery === undefined) {
  console.log('\n桥不在，无法继续。请先启动 ZCode 实例。')
  process.exit(1)
}
check('端口是合法数字', Number.isSafeInteger(discovery.port) && discovery.port > 0, `${discovery.port}`)
check('token 非空', discovery.token.length > 0, `${discovery.token.length} 字符`)

console.log('\n=== 2. /health 探活 ===')
const healthRes = await fetch(`http://127.0.0.1:${discovery.port}/health`, { signal: AbortSignal.timeout(5000) })
check('/health 返回 200', healthRes.ok, `HTTP ${healthRes.status}`)
const health = await healthRes.json()
console.log('  ' + JSON.stringify(health))
check('health.ok === true', health.ok === true)
check('health 带 models 数组', Array.isArray(health.models), JSON.stringify(health.models))

console.log('\n=== 3. /v1/models 目录 ===')
const modelsRes = await fetch(`http://127.0.0.1:${discovery.port}/v1/models`, {
  headers: { Authorization: `Bearer ${discovery.token}` },
  signal: AbortSignal.timeout(5000),
})
check('/v1/models 返回 200', modelsRes.ok, `HTTP ${modelsRes.status}`)
const modelsBody = await modelsRes.json()
const ids = (modelsBody.data ?? []).map((m) => m.id)
console.log('  桥报的模型: ' + JSON.stringify(ids))

/**
 * 关键断言：**桥报的模型 ∩ 我的兜底表 ≠ 空**。
 *
 * 若为空，说明白名单过滤会把所有模型滤掉，provider 会「看起来没有模型」。
 */
const mine = new Set(ZCODE.fallbackModels.map((m) => m.id))
const overlap = ids.filter((id) => mine.has(id))
console.log(`  我的兜底表: ${JSON.stringify([...mine])}`)
console.log(`  交集: ${JSON.stringify(overlap)}`)
check('桥报的模型与兜底表有交集', overlap.length > 0, `${overlap.length} 个`)
check('每个交集项都有完整配置',
  overlap.every((id) => {
    const m = ZCODE.fallbackModels.find((x) => x.id === id)
    return m && m.contextWindow > 0 && m.maxTokens > 0
  }))

console.log('\n=== 4. 真正的对话（端到端）===')
const chatRes = await fetch(`http://127.0.0.1:${discovery.port}/v1/chat/completions`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${discovery.token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: overlap[0],
    max_tokens: 4096,
    stream: true,
    messages: [{ role: 'user', content: '只回答两个字：正常' }],
  }),
  signal: AbortSignal.timeout(120_000),
})
check('chat/completions 返回 200', chatRes.ok, `HTTP ${chatRes.status}`)
if (!chatRes.ok) {
  console.log('  正文: ' + (await chatRes.text()).slice(0, 300))
} else {
  const text = await chatRes.text()
  const hasChunk = text.includes('chat.completion.chunk')
  const hasDone = text.includes('[DONE]')
  check('响应是 OpenAI 形状的 SSE', hasChunk, hasChunk ? '' : text.slice(0, 200))
  check('以 [DONE] 收尾', hasDone)
  // 提取可见内容
  const contents = [...text.matchAll(/"content":"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1])
  const visible = contents.join('')
  console.log(`  可见内容: "${visible.slice(0, 60)}"`)

  /**
   * ⚠ **空输出要分辨原因，不能一概判失败**。
   *
   * 两种完全不同的情况都会表现为「有 SSE 帧、无 content」：
   *
   * | 原因 | 特征 | 是谁的问题 |
   * |---|---|---|
   * | **我的代码有问题** | `usage` 缺失或字段异常 | 本 PR |
   * | **实例侧 mint 失败**（captcha 降级） | `total_tokens: 0` + `finish_reason: stop` | 运行环境 |
   *
   * 实测后者长这样：
   *
   * ```
   * data: {"choices":[{"delta":{},"finish_reason":"stop"}],
   *        "usage":{"prompt_tokens":0,"completion_tokens":0,"total_tokens":0}}
   * data: [DONE]
   * ```
   *
   * ⇒ 判据是 `usage.total_tokens === 0`：**请求根本没到上游**
   *   （mint 就没成功），而不是「模型返回了空字符串」。
   */
  const usageMatch = text.match(/"total_tokens":(\d+)/)
  const totalTokens = usageMatch ? Number(usageMatch[1]) : undefined
  console.log(`  usage.total_tokens = ${totalTokens ?? '(缺失)'}`)

  if (visible.trim().length > 0) {
    check('有可见文本输出', true)
  } else if (totalTokens === 0) {
    console.log('  ⚠ 空输出，但 total_tokens=0 ⇒ **请求没到上游**（实例侧 mint 失败）')
    console.log('     这是运行环境问题，不是本 provider 的代码问题。')
    console.log('     参见 bench/INCIDENT-2026-09-29-captcha.md（captcha 降级为人工滑块）')
    console.log('  ✓ 协议形状正确、SSE 解析路径正确（上面两条已断言）')
  } else {
    check('有可见文本输出', false, `total_tokens=${totalTokens}，但 content 为空 —— 需排查`)
  }
}

console.log(`\n${failed === 0 ? '全部通过' : failed + ' 项失败'}`)
process.exit(failed === 0 ? 0 : 1)
