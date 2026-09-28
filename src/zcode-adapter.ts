/**
 * ZCode（智谱 z.ai 免费额度）LLM 适配器。
 *
 * ## 与其它 provider 的根本差异
 *
 * 其它 provider 都是「读凭据 → 直发远端」。ZCode **不是**：
 * 请求发给**本机 ZCode 实例的 HTTP 桥**，由那个实例代发上游。
 *
 * ```
 * Jet Hub ──▶ http://127.0.0.1:<port>/v1/chat/completions
 *                     │
 *                     └─▶ （实例内部处理 captcha 与风控）──▶ zcode.z.ai
 * ```
 *
 * 好处：**captcha 与 3012 风控由实例自己处理** —— 那本来就是它的正常工作方式。
 * 代价：需要本机跑着 ZCode 实例。
 *
 * ## 桥是标准 OpenAI 兼容
 *
 * 实测 `POST /v1/chat/completions` 是**标准 OpenAI 兼容 + 标准 SSE**
 * （`chat.completion.chunk` + `data: [DONE]`），与 Qoder / Loomy / Raccoon
 * 同形，正是 `openai-compat.ts` 的适用场景。
 *
 * ⚠ **不改 `openai-compat.ts` 的内部逻辑** —— 它当前服务 qoder / loomy /
 * raccoon；zcode 是第四个消费者。若实测发现字段形态不符，
 * 应在**本文件**内做局部适配，而不是改共享层。
 *
 * ## 两个必须真的做到的点
 *
 * 1. **`tools` 必须下发到请求体顶层** —— Qoder 与 TRAE 都因漏发而让模型
 *    在正文里臆造 XML 工具调用、harness 认不出 → 任务终止。
 * 2. **`listAllModels()` 必须实现** —— 设置页要显示被关闭的模型；
 *    缺了它会退化为裸 id（AGENTS.md 记录的真实缺陷）。
 *
 * ## ⚠ 端口每次都要重读
 *
 * 桥的端口与 token **随实例重启变化**（实测：53297 → 58640 → 62019 …）。
 * 所以**每次请求前都重读发现文件**，不缓存。
 * 缓存端口是本 provider 最容易犯的错 —— 表现为「实例重启后全部请求失败」。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { AccountPool, providerCatalogVisible } from './account-pool.js'
import { settingsNamespaceFor } from './settings-compat.js'
import { readBridgeDiscovery, type ZcodeCredential } from './zcode.js'
import { ZCODE, type ZcodeFallbackModel, type ZcodeProduct, type ZcodeRemoteModelLike } from './zcode-product.js'
import {
  consumeOpenAiSse,
  errorDetail,
  httpErrorCode,
  isTransportError,
  serializeMessages,
} from './openai-compat.js'

/** 本适配器注册的 provider 路由名（等价于 `ZCODE.id`）。 */
export const PROVIDER = 'zcode'

/** 远端模型条目（已归一）。 */
export type ZcodeRemoteModel = ZcodeRemoteModelLike

/** 兜底表条目转远端形状。 */
function fallbackToRemote(model: ZcodeFallbackModel): ZcodeRemoteModel {
  return {
    id: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    supportsImage: model.supportsImage,
  }
}

/**
 * 只放行**安全正整数**。
 *
 * ⚠ 远端是外部输入：`0` / 负数 / `NaN` 会让 DSH 在
 * `defaultMaxTokens` 的硬校验上抛 `INVALID_MODEL_MAX_TOKENS`，
 * **整轮对话起不来**（不是降级，是崩）。
 */
function positiveMaxTokens(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

/** {@link ZcodeAdapter} 的构造选项。 */
export interface ZcodeAdapterOptions {
  /** 单凭据回退 ref（无账号池时）。 */
  credentialRef: CredentialRef
  /** 解析当前可用凭据。 */
  resolveCredential: () => Promise<ZcodeCredential | undefined>
  /**
   * 凭据失效时的处理。
   *
   * ⚠ ZCode **不可续期**（凭据语义是「本机桥是否活着」，没有远端 token）。
   * 这个回调存在只是为了让适配器与其它 provider 同形；
   * 实现应当**重读发现文件**而不是去调什么 refresh 端点。
   */
  refresh: () => Promise<void>
  /** 拉取远端模型目录；失败时适配器回退兜底表。 */
  fetchRemoteModels?: () => Promise<ZcodeRemoteModel[]>
  /** 账号池（目录门控与黑名单）。 */
  accountPool?: AccountPool
  /** 产品配置；默认 {@link ZCODE}。 */
  product?: ZcodeProduct
  /** 注入的 fetch（测试用）。 */
  fetchImpl?: typeof fetch
}

/** ZCode 模型适配器。 */
export class ZcodeAdapter extends LlmAdapter {
  private readonly product: ZcodeProduct
  private readonly fetchImpl: typeof fetch
  /** 兜底模型索引（id → 条目）。 */
  private readonly fallbackIndex: ReadonlyMap<string, ZcodeFallbackModel>
  /** 远端模型缓存；未拉取时为 undefined。 */
  private remoteModels: ZcodeRemoteModel[] | undefined

  constructor(private readonly options: ZcodeAdapterOptions) {
    super()
    this.product = options.product ?? ZCODE
    this.fetchImpl = options.fetchImpl ?? fetch
    this.fallbackIndex = new Map(this.product.fallbackModels.map((model) => [model.id, model]))
  }

  /**
   * 描述本适配器拥有的 provider 路由。
   *
   * 对入参做防御性归一化：DSH 会强制校验 `info.id === provider`，
   * 而模型设置页会用该 id 计算 `deriveKeyRef(provider)`
   * （内部调 `provider.toUpperCase()`）。一旦 provider 不是字符串，
   * 直接回退到本产品的 id。
   */
  providerInfo(provider: string): LlmProviderInfo {
    const id = typeof provider === 'string' && provider.length > 0 ? provider : this.product.id
    return { id, name: this.product.displayName }
  }

  /**
   * 完整目录（**不套黑名单**），带最终展示名。
   *
   * 设置页需要它渲染被关闭的模型 —— 否则那些条目只能凭 `disabledMap` 的 key
   * 补回，而那条路径拿不到展示名，会退化成裸 id。
   */
  listAllModels(): readonly { id: string; name: string }[] {
    const source = this.remoteModels ?? this.product.fallbackModels.map(fallbackToRemote)
    return source.map((model) => ({ id: model.id, name: model.name }))
  }

  /** 取（并缓存）远端模型目录；失败时回退兜底表。 */
  private async loadModels(): Promise<ZcodeRemoteModel[]> {
    if (this.remoteModels !== undefined) return this.remoteModels
    if (this.options.fetchRemoteModels !== undefined) {
      try {
        const fetched = await this.options.fetchRemoteModels()
        if (fetched.length > 0) {
          this.remoteModels = fetched
          return fetched
        }
      } catch {
        // 远端失败静默回退兜底表：模型目录是展示信息，不该让整个 provider 报错。
      }
    }
    const fallback = this.product.fallbackModels.map(fallbackToRemote)
    this.remoteModels = fallback
    return fallback
  }

  private inputModalitiesFor(model: ZcodeRemoteModel | undefined): readonly ('text' | 'image')[] {
    return model?.supportsImage === true ? ['text', 'image'] : ['text']
  }

  async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    // ⚠ 无已登录账号时返回 `[]` → DSH 的 buildModelCatalog 把整个 provider
    // 分组隐藏。**必须返回空数组而不能抛错**（抛错会被归入 catalog 的
    // failures，界面上反而多一条 provider 报错）。
    //
    // 对 ZCode 而言这条尤其自然：**桥不在（实例没跑）= 没有任何模型**，
    // 正是用户期望的表现。
    if (!await providerCatalogVisible(this.options.accountPool, this.product.id)) return []

    const all = await this.loadModels()
    const disabled = this.options.accountPool?.disabledModelsFor(this.product.id)
    const listed = disabled === undefined || disabled.size === 0
      ? all
      : all.filter((model) => !disabled.has(model.id))

    return listed.map((model) => ({
      provider: this.product.id,
      id: model.id,
      name: model.name,
      inputModalities: this.inputModalitiesFor(model),
    }))
  }

  async resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const all = await this.loadModels()
    const entry = all.find((item) => item.id === model)
    const fallback = this.fallbackIndex.get(model)
    const resolved: LlmResolvedModelInfo = {
      provider,
      id: model,
      name: entry?.name ?? fallback?.name ?? model,
      inputModalities: this.inputModalitiesFor(entry),
    }
    const contextWindow = entry?.contextWindow ?? fallback?.contextWindow
    // 未知模型不编造 context（宁可让 DSH 用默认值，也不报一个假窗口）。
    if (contextWindow !== undefined && contextWindow > 0) {
      resolved.context = { contextWindow }
    }
    // ⚠ 远端非法值必须过滤：不声明就让 DSH 用默认值。
    const maxTokens = positiveMaxTokens(entry?.maxTokens ?? fallback?.maxTokens)
    if (maxTokens !== undefined) resolved.defaultMaxTokens = maxTokens
    return resolved
  }

  /**
   * 兼容 0.1.1-rc.2：新版 `LlmRuntime.prepareCall()` 会调用
   * `registration.adapter.prepareCall(...)`，而本仓库链接的 dsh-llm 副本
   * 基类尚未提供该方法。与其余适配器同款 shim。
   */
  async prepareCall(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<{ model: LlmResolvedModelInfo; stream: (options: GenerateOptions) => AsyncIterable<StreamChunk> }> {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options: GenerateOptions) => this.stream(options),
    }
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    // 图片能力按**模型**判定。不能放宽成「总是接受」：DSH 在 LlmRuntime 里
    // 按适配器播报的 `inputModalities` 决定要不要把图片投影成文本占位符，
    // 声明支持就必须真支持。
    //
    // ZCode 的桥目前**不支持图片**（实测请求体里没有 image 块的能力），
    // 所以这里硬性拒绝 —— 比静默丢图更好（丢图会让模型看到空内容）。
    for (const message of options.messages) {
      if (Array.isArray(message.content) &&
          message.content.some((block) => (block as { type?: unknown }).type === 'image')) {
        throw new LlmError(
          `zcode: 模型 "${options.model}" 不支持图片输入（ZCode 桥未实现图片通道）`,
          'UNSUPPORTED_CONTENT',
        )
      }
    }

    // 1. 取凭据（ZCode 恒不「过期」，这个调用是形状对齐）
    let credential = await this.options.resolveCredential()
    if (credential === undefined || isExpired(credential)) {
      await this.options.refresh()
      credential = await this.options.resolveCredential()
    }
    if (credential === undefined) {
      throw new LlmError('zcode: no usable credential; start the ZCode instance first', 'MISSING_CREDENTIAL')
    }

    /**
     * ★★ **每次请求都重读桥的端口与 token**（本文件最关键的一行）。
     *
     * ## 为什么不能缓存
     *
     * 桥的端口**随实例重启变化** —— 实测同一台机器上先后是
     * `53297` → `58640` → `62019` → `60713`。token 同样是每次随机生成。
     *
     * 缓存端口的表现是：**实例重启后所有请求失败**，
     * 而错误是「连接被拒绝」，看起来像「ZCode 没跑」——
     * 排查方向会被完全带偏（其实它跑着，只是端口变了）。
     *
     * `AGENTS.md` 也记过同类教训：
     * 「靠『文件实际在哪』这个事实做候选探测，比靠『进程记得什么』可靠」。
     *
     * ## 用发现文件而不是凭据里的值
     *
     * 凭据里也存了一份 `bridge_port`，但那只是**上次观察到的**值，
     * 仅用于展示与诊断。**实际请求一律以文件为准。**
     */
    const discovery = readBridgeDiscovery()
    if (discovery === undefined) {
      throw new LlmError(
        'zcode: 未找到桥的发现文件（ZCode 实例没在跑？）—— ' +
          '检查 <dataBaseDir>/.zcode/v2/bridge-port.json',
        'MISSING_CREDENTIAL',
      )
    }

    const messages = serializeMessages(options.messages)

    /**
     * 前置 system 消息（若有）。
     *
     * ⚠ 必须**先拼再放进对象**，不要在对象字面量里写两次 `messages` ——
     * 后者依赖「后面的键覆盖前面」这一隐式行为，读者极易误判成漏了 system。
     */
    const wireMessages = options.system !== undefined && options.system.length > 0
      ? [{ role: 'system', content: options.system }, ...messages]
      : messages

    /** 构造请求体。 */
    const buildBody = (): string => JSON.stringify({
      model: options.model,
      messages: wireMessages,
      stream: true,
      ...options.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {},
      ...options.temperature !== undefined ? { temperature: options.temperature } : {},
      ...options.stop !== undefined && options.stop.length > 0 ? { stop: options.stop } : {},
      // ⚠ tools 必须真的下发到请求体**顶层**：Qoder/TRAE 都因漏发而让模型
      // 在正文里臆造 XML 工具调用，harness 认不出 → 任务终止。
      ...options.tools !== undefined && options.tools.length > 0
        ? {
            tools: options.tools.map((tool) => ({
              type: 'function',
              function: {
                name: tool.name,
                ...tool.description.length > 0 ? { description: tool.description } : {},
                ...tool.parameters === undefined ? {} : { parameters: tool.parameters },
              },
            })),
          }
        : {},
    })

    const headers = (): Record<string, string> => ({
      Accept: 'text/event-stream',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${discovery.token}`,
    })

    /** 发送一次 chat 请求（用**本次**读到的端口）。 */
    const send = async (): Promise<Response> => {
      try {
        return await this.fetchImpl(
          `http://127.0.0.1:${discovery.port}/v1/chat/completions`,
          {
            method: 'POST',
            headers: headers(),
            body: buildBody(),
            signal: options.signal,
          },
        )
      } catch (error) {
        if (options.signal?.aborted) throw error
        if (isTransportError(error)) {
          throw new LlmError(
            `zcode: transport error（桥不在了？端口 ${discovery.port}）: ` +
              `${error instanceof Error ? error.message : String(error)}`,
            'TRANSPORT',
            { cause: error as Error },
          )
        }
        throw error
      }
    }

    const response = await send()

    if (!response.ok) {
      const errorText = await response.text().catch(() => '')
      throw new LlmError(`zcode: ${errorDetail(errorText)}`, httpErrorCode(response.status), { status: response.status })
    }

    // ⚠ 业务失败也可能以 HTTP 200 + SSE 内嵌错误帧返回，由 consumeOpenAiSse 处理。
    yield* consumeOpenAiSse(response, { signal: options.signal }, {
      label: 'zcode',
      firstTokenTimeoutMs: resolveFirstTokenTimeoutMs(),
      chunkTimeoutMs: resolveChunkTimeoutMs(),
    })
  }
}

/** 凭据是否过期 —— ZCode 恒 false（见 `zcode.ts` 的说明）。 */
function isExpired(credential: ZcodeCredential): boolean {
  return credential.bridge_token.length === 0
}

/**
 * 首 token 超时（毫秒）。
 *
 * ⚠ 默认值明显高于其它 provider（它们多为 120s，这里取 **240s**）。
 * 理由：实测单请求长尾能到 30 秒以上（上游限流重试 + 思考链），
 * 而 240s 是「宁可多等也不误杀」的选择。
 */
function resolveFirstTokenTimeoutMs(): number {
  const raw = Number(process.env.DSH_ZCODE_FIRST_TOKEN_TIMEOUT_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : 240_000
}

/** chunk 间隔超时（毫秒）。 */
function resolveChunkTimeoutMs(): number {
  const raw = Number(process.env.DSH_ZCODE_CHUNK_TIMEOUT_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : 240_000
}

/**
 * 在 `ctx.llm` 上注册 zcode provider 路由与适配器。
 *
 * 返回适配器实例：Jet Hub「显示列表」需要 `listAllModels()`
 * （不受黑名单影响、带最终展示名）。`ctx.llm` 不透传自定义方法，
 * 故须由调用方持有引用并在 `index.ts` 的 `modelAdapters` 里登记。
 */
export function registerZcodeLlm(ctx: Context, options: ZcodeAdapterOptions): ZcodeAdapter {
  const product = options.product ?? ZCODE
  ctx.llm.registerConfigurableProviders([
    {
      provider: product.id,
      displayName: product.displayName,
      settingsNs: settingsNamespaceFor(ctx, `llm-${product.id}`),
      settingsPath: [],
    },
  ])
  const adapter = new ZcodeAdapter(options)
  ctx.llm.registerAdapter([product.id], adapter)
  return adapter
}
