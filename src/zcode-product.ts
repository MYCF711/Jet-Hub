/**
 * ZCode（智谱 z.ai 免费额度）产品配置。
 *
 * ## 为什么新建 `ZcodeProduct` 而不复用既有类型
 *
 * `BuddyProduct` / `QoderProduct` / `RaccoonProduct` 的字段全部围绕各自
 * 的远端协议设计（归属头、refresh 载荷、WASM 签名、加密密钥…），
 * 对 ZCode 无一有意义。ZCode 需要的是：一个**本机桥地址**、
 * 一个连接超时、一张兜底模型表。故定义**平行**的接口 ——
 * 共用的是架构**模式**（产品差异收敛到单一真相源），不是那个类型。
 *
 * ## 数据来源（全部实测，非推测）
 *
 * - 模型池：2026-09-28 实测 `GET http://127.0.0.1:<port>/v1/models`
 * - 上游模型清单：服务端有 4 个（GLM-5-Turbo / GLM-5.2 / GLM-5.3 /
 *   GLM-5.3-Flash），但**前两个在当前套餐下返回空响应**（实测 0/3 正确），
 *   故**只暴露后两个** —— 列一个用不了的模型比不列更糟。
 * - 上下文窗口与输出上限：来自插件的既有实测（`LATENCY-FINDINGS.md`）。
 */

import type { ZcodeCredential } from './zcode.js'

/** 兜底模型目录中的一个条目。 */
export interface ZcodeFallbackModel {
  /** 模型 ID（传给桥的 `model` 字段）。 */
  id: string
  /** 展示名。 */
  name: string
  /** 上下文窗口。 */
  contextWindow: number
  /** 单次输出上限。 */
  maxTokens: number
  /** 是否支持图片输入。 */
  supportsImage: boolean
}

/** ZCode 产品配置。 */
export interface ZcodeProduct {
  /** provider 标识：注册到 `ctx.llm` 的路由名，也是账号列表的 provider 字段值。 */
  id: 'zcode'
  /** 设置页 / 模型选择器展示名。 */
  displayName: string
  /** 默认凭据 ref（无账号池时的单凭据回退）。 */
  defaultCredentialRef: string
  /** 请求桥的超时（毫秒）。 */
  requestTimeoutMs: number
  /** 远端模型列表不可用时的兜底目录。 */
  fallbackModels: readonly ZcodeFallbackModel[]
}

/**
 * 兜底模型目录。
 *
 * ⚠ **只放实测可用的两个**。服务端的模型清单里有 `GLM-5-Turbo` 与
 * `GLM-5.2`，但 2026-09-28 实测它们**返回空响应**（同样的三题 0/3 正确，
 * 而 GLM-5.3 是 3/3）。把不可用的模型列出来会让用户选中后收到空回复，
 * 比不列更糟。
 *
 * ⚠ 两者的速度差异**不是**「谁更快」那么简单，实测结论：
 *
 * | 模型 | 中位延迟 | 正确率 | 并发限流 |
 * |---|---|---|---|
 * | GLM-5.3 | 4452ms | 8/14 (57%) | 撞过 21 次 3009 |
 * | GLM-5.3-Flash | 4915ms | 10/15 (67%) | **0 次** |
 *
 * ⇒ GLM-5.3 略快但略不准，且并发配额严得多。默认放 Flash（更稳）。
 * 样本量偏小（n≈15），所以两个都列出来让用户自己选。
 */
const ZCODE_FALLBACK_MODELS: readonly ZcodeFallbackModel[] = [
  {
    id: 'GLM-5.3-Flash',
    name: 'GLM-5.3-Flash',
    contextWindow: 200_000,
    maxTokens: 32_768,
    supportsImage: false,
  },
  {
    id: 'GLM-5.3',
    name: 'GLM-5.3',
    contextWindow: 200_000,
    maxTokens: 32_768,
    supportsImage: false,
  },
]

/** ZCode provider 配置。 */
export const ZCODE: ZcodeProduct = {
  id: 'zcode',
  // ⚠ 用『ZCode (智谱)』而非『ZCode Bridge (GLM free)』—— 后者在 Jet Hub 的
  // provider Tab 里**触发换行**（与 Raccoon 同样的用户报障）。
  // 与 `plugin-src/client/jet-hub.js` 的 `PROVIDERS` label 保持一致。
  displayName: 'ZCode (智谱)',
  defaultCredentialRef: 'ZCODE_BRIDGE_TOKEN',
  /**
   * 桥的请求超时。
   *
   * ⚠ 取值明显高于其它 provider（它们多为 120s）。理由：
   * 实测单请求耗时 1.3-33 秒，**中位约 4-6 秒**，但长尾能到 30 秒以上；
   * 而多步 agent 的每一步都是一次独立请求。给 180s 是为了包住长尾，
   * 不是为了让正常请求等那么久（正常请求 5 秒内就回来了）。
   */
  requestTimeoutMs: 180_000,
  fallbackModels: ZCODE_FALLBACK_MODELS,
}

/** 全部 ZCode 产品配置（当前只有一个，保留数组以便将来扩展）。 */
export const ALL_ZCODE_PRODUCTS: readonly ZcodeProduct[] = [ZCODE]

/**
 * 按 provider id 取产品配置；未知 id 返回 undefined。
 *
 * 与 `productById` / `raccoonProductById` 分开：各自返回**不同类型**，
 * 合并会让调用方拿到联合类型后再也不得不做类型收窄。
 */
export function zcodeProductById(id: string): ZcodeProduct | undefined {
  return ALL_ZCODE_PRODUCTS.find((product) => product.id === id)
}

/** 供适配器使用的凭据别名（避免循环 import）。 */
export type { ZcodeCredential }

/**
 * 远端模型条目的形状（适配器与 auth 服务共用的最小契约）。
 *
 * 为什么不直接用 `ZcodeFallbackModel`：那个是**兜底表**的类型，
 * 语义是「实测可用的静态清单」；这里是「运行期拿到的目录条目」。
 * 两者当前字段相同，但**语义不同** —— 将来远端可能多出字段
 * （例如倍率、能力标记），那时不该被迫改兜底表。
 */
export interface ZcodeRemoteModelLike {
  id: string
  name: string
  contextWindow: number
  maxTokens: number
  supportsImage: boolean
}
