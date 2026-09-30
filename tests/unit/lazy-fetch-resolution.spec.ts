/**
 * 回归：适配器必须**惰性**解析 fetch，不得在构造期捕获 `globalThis.fetch`。
 *
 * 背景：`billion-context` 等上下文压缩代理靠运行时装在 `globalThis.fetch` 上的
 * accessor 补丁接管模型流量。若适配器在构造期执行
 * `this.fetchImpl = options.fetchImpl ?? fetch`，就把当时的引用冻结下来，
 * 补丁再也看不到这些请求 —— 症状是压缩静默失效（代理日志零 `processTurn`、
 * `acp_status` 报 `no model request has arrived`）。
 *
 * 本用例对每个适配器做同一件事：先构造实例，**之后**才给 `globalThis.fetch`
 * 装补丁，然后断言实例解析出的 fetch 就是补丁本身。
 * 构造期捕获的实现会断言失败（拿到的是补丁前的原始 fetch）。
 */

import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { describe, expect, it } from 'vitest'
import { BuddyAdapter } from '../../src/buddy-adapter.js'
import { ClineAdapter } from '../../src/cline-adapter.js'
import { CodeArtsAdapter } from '../../src/llm-adapter.js'
import { LobsteraiAdapter } from '../../src/lobsterai-adapter.js'
import { LoomyAdapter } from '../../src/loomy-adapter.js'
import { QoderAdapter } from '../../src/qoder-adapter.js'
import { AntigravityAdapter } from '../../src/antigravity-adapter.js'
import { AntigravityLocalAdapter } from '../../src/antigravity-local-adapter.js'
import { RaccoonAdapter } from '../../src/raccoon-adapter.js'
import { TraeAdapter } from '../../src/trae-adapter.js'

/** 取出实例解析出的 fetch（私有 getter / 字段在运行时可读）。 */
function resolvedFetch(adapter: unknown): typeof fetch {
  return (adapter as { fetchImpl: typeof fetch }).fetchImpl
}

/** 最小可用 options——凭据回调不会被本用例触发。 */
const base = {
  resolveCredential: async () => undefined,
  refresh: async () => {},
} as const

/**
 * 构造适配器，**之后**再把 `globalThis.fetch` 换成 accessor 补丁，
 * 最后断言补丁可见。`make` 必须在装补丁之前调用完毕。
 */
function expectPatchVisibleAfterConstruction(make: () => unknown): void {
  const adapter = make()
  const original = globalThis.fetch
  const patched = (async () => new Response('patched')) as typeof fetch
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    enumerable: true,
    get: () => patched,
    set: () => {},
  })
  try {
    expect(resolvedFetch(adapter)).toBe(patched)
  } finally {
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      enumerable: true,
      value: original,
      writable: true,
    })
  }
}

describe('适配器惰性解析 fetch（构造期不得捕获 globalThis.fetch）', () => {
  it('BuddyAdapter', () => {
    expectPatchVisibleAfterConstruction(() =>
      new BuddyAdapter({ credentialRef: credentialRef('BUDDY_ACCESS_TOKEN'), ...base }))
  })

  it('ClineAdapter', () => {
    expectPatchVisibleAfterConstruction(() =>
      new ClineAdapter({ credentialRef: credentialRef('CLINE_ACCESS_TOKEN'), ...base }))
  })

  it('CodeArtsAdapter', () => {
    expectPatchVisibleAfterConstruction(() =>
      new CodeArtsAdapter({ credentialRef: credentialRef('CODEARTS_ACCESS_TOKEN'), ...base }))
  })

  it('LobsteraiAdapter', () => {
    expectPatchVisibleAfterConstruction(() =>
      new LobsteraiAdapter({ credentialRef: credentialRef('LOBSTERAI_ACCESS_TOKEN'), ...base }))
  })

  it('LoomyAdapter', () => {
    expectPatchVisibleAfterConstruction(() =>
      new LoomyAdapter({ credentialRef: credentialRef('LOOMY_ACCESS_TOKEN'), ...base }))
  })

  it('QoderAdapter', () => {
    expectPatchVisibleAfterConstruction(() =>
      new QoderAdapter({ credentialRef: credentialRef('QODER_ACCESS_TOKEN'), ...base }))
  })

  it('RaccoonAdapter', () => {
    expectPatchVisibleAfterConstruction(() =>
      new RaccoonAdapter({ credentialRef: credentialRef('RACCOON_ACCESS_TOKEN'), ...base }))
  })

  it('TraeAdapter', () => {
    expectPatchVisibleAfterConstruction(() =>
      new TraeAdapter({ credentialRef: credentialRef('TRAE_ACCESS_TOKEN'), ...base }))
  })

  it('AntigravityAdapter', () => {
    expectPatchVisibleAfterConstruction(() => new AntigravityAdapter())
  })

  it('AntigravityLocalAdapter', () => {
    expectPatchVisibleAfterConstruction(() => new AntigravityLocalAdapter())
  })

  it('显式注入的 options.fetchImpl 仍然优先于全局补丁', () => {
    const injected = (async () => new Response('injected')) as typeof fetch
    const adapter = new BuddyAdapter({
      credentialRef: credentialRef('BUDDY_ACCESS_TOKEN'),
      ...base,
      fetchImpl: injected,
    })
    const original = globalThis.fetch
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      enumerable: true,
      get: () => (async () => new Response('patched')) as typeof fetch,
      set: () => {},
    })
    try {
      expect(resolvedFetch(adapter)).toBe(injected)
    } finally {
      Object.defineProperty(globalThis, 'fetch', {
        configurable: true,
        enumerable: true,
        value: original,
        writable: true,
      })
    }
  })
})
