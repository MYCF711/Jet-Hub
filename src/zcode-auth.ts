/**
 * ZCode 认证/凭据服务。
 *
 * ## 为什么这个服务与别的 auth 服务**语义不同**
 *
 * 其它 `ctx.xxxAuth` 管的是「浏览器登录 → 拿 token → 续期」。
 * ZCode **没有登录流程** —— 用户装好并启动 ZCode 实例，
 * 桥就把端口与 token 写进发现文件了。所以本服务的职责是：
 *
 * 1. **探活**：桥在不在、能不能通
 * 2. **读凭据**：从发现文件读端口与 token（**每次重读，不缓存**）
 * 3. **写凭据**：把当前端口/token 存进账号池（供展示与诊断）
 * 4. **拉模型目录**：`GET /v1/models`
 *
 * ⚠ `login()` / `startLogin()` **不实现浏览器流程** —— 它们把
 * 「桥当前可用」当作登录成功的凭据，因为对这个 provider 而言那就是全部。
 * 这与其他 provider 的两步式登录契约形状一致（避免 Jet Hub 前端分叉），
 * 但**没有 loginUrl**（返回 `undefined`），前端据此显示「不需要登录」。
 *
 * ## ⚠ 服务名由 `product.id` 派生
 *
 * 与 `RaccoonAuth` 同款做法：注册为 `ctx.zcodeAuth`。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import type { AccountPool } from './account-pool.js'
import { readBridgeDiscovery, type ZcodeCredential } from './zcode.js'
import { ZCODE, type ZcodeProduct, type ZcodeRemoteModelLike } from './zcode-product.js'

/** 桥的 `/v1/models` 响应形状（OpenAI 兼容）。 */
interface BridgeModelsResponse {
  data?: Array<{ id?: unknown; object?: unknown }>
}

/** 桥的 `/health` 响应形状。 */
interface BridgeHealthResponse {
  ok?: unknown
  models?: unknown
}

/** 一次探活的结果。 */
export interface ZcodeProbeResult {
  /** 桥是否可用。 */
  available: boolean
  /** 端口（不可用时为 undefined）。 */
  port?: number
  /** 桥自报的模型。 */
  models: readonly string[]
  /** 发现文件的实际路径（诊断用）。 */
  sourcePath?: string
  /** 不可用时的原因（人类可读）。 */
  reason?: string
}

/** `ZcodeAuth` 的构造选项。 */
export interface ZcodeAuthOptions {
  /** 产品配置；默认 {@link ZCODE}。 */
  product?: ZcodeProduct
  /** 注入的 fetch（测试用）。 */
  fetchImpl?: typeof fetch
}

/**
 * ZCode 认证服务。
 *
 * ⚠ **不注册任何斜杠命令** —— 与其余 provider 一致，
 * 登录/状态/续期全部在 Jet Hub 完成。
 */
export class ZcodeAuth {
  private readonly product: ZcodeProduct
  private readonly fetchImpl: typeof fetch

  constructor(
    private readonly ctx: Context,
    options: ZcodeAuthOptions = {},
  ) {
    this.product = options.product ?? ZCODE
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  /** 服务标识（与 `product.id` 一致）。 */
  get id(): string {
    return this.product.id
  }

  /** 展示名。 */
  get displayName(): string {
    return this.product.displayName
  }

  /**
   * 探活：桥在不在、能不能通。
   *
   * 分两步：
   *   1. 读发现文件（**唯一权威来源**）
   *   2. `GET /health`（确认它真的在监听，而不只是文件还在）
   *
   * ⚠ 第 2 步不能省：实例崩溃后**发现文件不会自动删除**，
   * 只看文件会误报「可用」，用户随后每次发消息都得到连接失败。
   */
  async probe(): Promise<ZcodeProbeResult> {
    const discovery = readBridgeDiscovery()
    if (discovery === undefined) {
      return {
        available: false,
        models: [],
        reason:
          '未找到桥的发现文件（ZCode 实例没在跑？）—— ' +
          '检查 <dataBaseDir>/.zcode/v2/bridge-port.json',
      }
    }

    try {
      const response = await this.fetchImpl(
        `http://127.0.0.1:${discovery.port}/health`,
        { signal: AbortSignal.timeout(3_000) },
      )
      if (!response.ok) {
        return {
          available: false,
          port: discovery.port,
          models: [],
          sourcePath: discovery.sourcePath,
          reason: `桥 /health 返回 HTTP ${response.status}`,
        }
      }
      const health = await response.json().catch(() => ({})) as BridgeHealthResponse
      const models = Array.isArray(health.models)
        ? health.models.filter((m): m is string => typeof m === 'string')
        : discovery.models
      return { available: true, port: discovery.port, models, sourcePath: discovery.sourcePath }
    } catch (error) {
      return {
        available: false,
        port: discovery.port,
        models: [],
        sourcePath: discovery.sourcePath,
        reason:
          `桥不可达（端口 ${discovery.port}）：` +
          `${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }

  /**
   * 读取当前凭据。
   *
   * ⚠ **每次调用都重读发现文件**，不缓存 —— 端口随实例重启变化，
   * 缓存会让「实例重启后全部请求失败」。
   *
   * 返回 `undefined` 表示桥不在（没有可用的凭据）。
   */
  async current(): Promise<ZcodeCredential | undefined> {
    const discovery = readBridgeDiscovery()
    if (discovery === undefined) return undefined
    return {
      bridge_token: discovery.token,
      bridge_port: discovery.port,
      account_label: `127.0.0.1:${discovery.port}`,
    }
  }

  /**
   * 把当前桥信息存进账号池（供展示与诊断）。
   *
   * 对 ZCode 而言「登录」就是这件事 —— 确认桥在，然后把它的
   * 端口/token 记下来。**不需要用户在浏览器里做任何事。**
   */
  async persistCurrent(refName?: string): Promise<{ refName: string; credential: ZcodeCredential }> {
    const discovery = readBridgeDiscovery()
    if (discovery === undefined) {
      throw new Error(
        'ZCode 桥不可用：请先启动 ZCode 实例（它会自行写出 bridge-port.json）',
      )
    }
    const credential: ZcodeCredential = {
      bridge_token: discovery.token,
      bridge_port: discovery.port,
      account_label: `127.0.0.1:${discovery.port}`,
    }
    const ref: CredentialRef = (refName ?? this.product.defaultCredentialRef) as CredentialRef
    /**
     * ⚠ `ctx.credentials.set` 的第二个参数是**字符串**，不是一个对象。
     *
     * 第一版写成了 `{ type: 'api-key', value: ... }` —— 那是别的 API 的形状。
     * 这里的约定是「把凭据本体序列化成字符串存进去」，
     * 读的时候再 `JSON.parse`（与 `RaccoonAuth` 同款做法）。
     */
    await this.ctx.credentials.set(ref, JSON.stringify(credential))
    return { refName: ref, credential }
  }

  /**
   * 「登录」—— 对 ZCode 而言就是确认桥可用并记下凭据。
   *
   * ⚠ **不返回 loginUrl**（与两步式登录的其它 provider 不同）：
   * ZCode 没有任何需要用户在浏览器里完成的事。
   * Jet Hub 前端据此显示「不需要登录，只需要 ZCode 实例在跑」。
   */
  async login(options: { refName?: string } = {}): Promise<{ refName: string; credential: ZcodeCredential }> {
    return await this.persistCurrent(options.refName)
  }

  /**
   * 两步式登录的兼容形状。
   *
   * ⚠ `loginUrl` 为 `undefined` —— 这是**有意的**，不是漏实现。
   * 见 {@link login} 的说明。
   */
  async startLogin(options: { refName?: string } = {}): Promise<{
    loginUrl: undefined
    result: Promise<{ refName: string; credential: ZcodeCredential }>
  }> {
    return {
      loginUrl: undefined,
      result: this.persistCurrent(options.refName),
    }
  }

  /**
   * 拉远端模型目录。
   *
   * ⚠ **只返回该套餐真正可用的模型**。服务端的 `/v1/models` 会列出 4 个
   * （含 `GLM-5-Turbo` / `GLM-5.2`），但实测后两个在当前套餐下**返回空响应**。
   * 列一个用不了的模型比不列更糟 —— 用户选中后收到空回复。
   *
   * 过滤依据是 `product.fallbackModels` 的 id 集合：
   * 兜底表只放实测可用的，故用它当白名单是**有意复用**那份实测结论，
   * 而不是另立一份可能漂移的清单。
   *
   * 失败时返回**空数组**（由适配器回退兜底表）。
   */
  async fetchModels(): Promise<ZcodeRemoteModelLike[]> {
    const discovery = readBridgeDiscovery()
    if (discovery === undefined) return []

    let response: Response
    try {
      response = await this.fetchImpl(
        `http://127.0.0.1:${discovery.port}/v1/models`,
        {
          headers: { Authorization: `Bearer ${discovery.token}` },
          signal: AbortSignal.timeout(5_000),
        },
      )
    } catch {
      return []
    }
    if (!response.ok) return []

    let parsed: BridgeModelsResponse
    try {
      parsed = await response.json() as BridgeModelsResponse
    } catch {
      return []
    }

    const available = new Set(this.product.fallbackModels.map((model) => model.id))
    const byId = new Map(this.product.fallbackModels.map((model) => [model.id, model]))
    const out: ZcodeRemoteModelLike[] = []
    for (const entry of parsed.data ?? []) {
      const id = typeof entry.id === 'string' ? entry.id : undefined
      if (id === undefined || !available.has(id)) continue
      const known = byId.get(id)
      if (known === undefined) continue
      out.push({
        id: known.id,
        name: known.name,
        contextWindow: known.contextWindow,
        maxTokens: known.maxTokens,
        supportsImage: known.supportsImage,
      })
    }
    /**
     * ⚠ 若白名单过滤后为空，**返回空数组**而不是「原样放行」。
     *
     * 原因：那意味着桥报的模型与我们实测可用的集合**完全不相交** ——
     * 要么套餐变了、要么桥换了协议。此时回退兜底表（调用方的行为）
     * 比放行一批未经验证的 id 更安全。
     */
    return out
  }

  /**
   * 批量同步端口到账号**昵称**。
   *
   * ⚠ ZCode **不可续期**（没有 refresh 端点）。但这个方法**仍然要做一件实事**：
   * 把发现文件里最新的端口同步到账号条目，让卡片显示的是**当前**端口。
   *
   * ## 为什么写 `nickname` 而不是别的字段
   *
   * `ProviderAccountEntry` 的字段是固定的（`id` / `provider` / `nickname` /
   * `enabled` / `credentialRef` / `createdAt` / `expiresAt?` / `refreshable` /
   * `modelRateLimits?`），**没有专门的「备注」字段**。
   * 而 `updateAccount` 只接受 `nickname` / `expiresAt` / `enabled` / `refreshable`。
   *
   * 端口对 ZCode 而言就是账号的**身份**（一个 ZCode 实例 = 一个账号），
   * 所以放进 `nickname` 是语义正确的：用户看到的「账号名」就是它在哪。
   *
   * 幂等：端口没变时不写。
   */
  async refreshAll(pool: AccountPool): Promise<void> {
    const discovery = readBridgeDiscovery()
    if (discovery === undefined) return
    const nickname = `ZCode @ 127.0.0.1:${discovery.port}`
    const accounts = pool.listAccountsByProvider(this.product.id)
    for (const account of accounts) {
      try {
        if (account.nickname === nickname) continue // 没变，省一次写
        await pool.updateAccount(account.id, { nickname })
      } catch {
        // 单个账号失败不影响其余；端口同步失败也不影响请求（请求走文件）。
      }
    }
  }

  /** 无状态资源需要释放（形状对齐用）。 */
  stop(): void {
    // ZCode 不持有任何长连接或定时器 —— 请求是「每次现读文件 + 现发 HTTP」。
  }
}
