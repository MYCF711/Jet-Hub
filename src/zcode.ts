/**
 * ZCode（智谱 z.ai 免费额度通道）常量与凭据形态。
 *
 * ## 为什么单独一套 `ZcodeProduct`
 *
 * 与既有各族都不同源：ZCode 走的是**本机 ZCode 实例的 HTTP 桥**，
 * 不是「读凭据 → 直发远端」。请求由本机那个 Electron 实例代发
 * （captcha 与风控由它自己处理），所以 `BuddyProduct` /
 * `QoderProduct` / `RaccoonProduct` 的字段对它全无意义。
 *
 * 这里只放**与协议有关**的常量；产品配置在 `zcode-product.ts`。
 *
 * ## 桥的发现方式
 *
 * ZCode 实例启动时把端口与 token 写进一个 JSON 文件：
 *
 * ```
 * <dataBaseDir>/.zcode/v2/bridge-port.json
 * { "port": 53297, "token": "<48位hex>", "models": ["GLM-5.3", ...] }
 * ```
 *
 * ⚠ **端口每次重启都变**，所以必须**每次读文件**，
 * 不能把端口写进配置或缓存太久。
 *
 * ## 多候选目录探测
 *
 * `<dataBaseDir>` 的取值随安装方式而异（用户主目录 / 自定义数据目录 /
 * 环境变量指定）。`AGENTS.md` 记过一条真实的坑：
 * **launcher 的环境块可能几天没更新**，子进程继承不到新值。
 * 所以这里按「**文件实际在哪**」这个事实做候选探测，
 * 而不是只信环境变量。
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 桥的发现文件相对于数据目录的路径。 */
export const BRIDGE_DISCOVERY_RELATIVE = '.zcode/v2/bridge-port.json'

/** ZCode 免费额度通道的 provider 前缀（账号级，非内置）。 */
export const ZCODE_START_PLAN_PROVIDER = 'account:bigmodel-start-plan'

/**
 * 候选数据目录（按优先级）。
 *
 * ## ★ 一个真实踩到的坑（决定了本函数的最终形态）
 *
 * 第一版只查「环境变量 + 用户主目录」。**对着真桥跑时找不到它**，
 * 尽管实例明明在运行：
 *
 * ```
 * ZCODE_DATA_BASE_DIR = (空)     ← launcher 的环境块里没有它
 * 桥实际在             D:\zcode-glm5.3f\_oss_data\.zcode\v2\bridge-port.json
 * ```
 *
 * 这正是 `AGENTS.md` 记过的那类问题：
 * **「靠『文件实际在哪』这个事实做候选探测，
 * 比靠『进程记得什么』可靠」** —— 只信环境变量会全盘找不到，
 * 而失败形态是「provider 静默没有模型」，用户完全不知道原因。
 *
 * ⇒ 所以除了环境变量，还必须**按盘符扫一遍**。
 */
export function bridgeDiscoveryCandidates(): readonly string[] {
  const out: string[] = []
  const push = (p: string): void => {
    if (!out.includes(p)) out.push(p)
  }

  /** ① 环境变量（标准安装方式）；支持 `;` 分隔的多数据目录。 */
  const fromEnv = process.env.ZCODE_DATA_BASE_DIR
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) {
    for (const dir of fromEnv.split(';')) {
      const trimmed = dir.trim()
      if (trimmed.length > 0) push(join(trimmed, BRIDGE_DISCOVERY_RELATIVE))
    }
  }

  /**
   * ② 显式声明的已知数据目录（`;` 分隔）。
   *
   * 给「环境块过期、但你知道装在哪」的场景用 —— 比扫描更快更确定。
   */
  const known = process.env.ZCODE_BRIDGE_KNOWN_DATA_DIRS
  if (typeof known === 'string' && known.trim().length > 0) {
    for (const dir of known.split(';')) {
      const trimmed = dir.trim()
      if (trimmed.length > 0) push(join(trimmed, BRIDGE_DISCOVERY_RELATIVE))
    }
  }

  /** ③ 用户主目录下的标准位置（默认安装）。 */
  push(join(homedir(), BRIDGE_DISCOVERY_RELATIVE))
  push(join(homedir(), '.zcode', 'v2', 'bridge-port.json'))

  /**
   * ④ **扫描常见根目录下的两级目录**（最后手段）。
   *
   * 为什么非要它：本机的部署方式把数据目录放在一个**自定义路径**
   *（`<项目目录>\_oss_data`），那个路径既不在环境变量、也不在主目录下，
   * 前三类候选**全部落空**。
   *
   * 扫描范围刻意收紧（只下两级、只找这个特定文件名），
   * 且用 `existsSync` 粗筛 —— 它是兜底，慢一点可以接受，
   * 但「找不到桥」不可接受。
   */
  for (const root of scanRoots()) {
    push(join(root, '\\_oss_data', '.zcode', 'v2', 'bridge-port.json'))
    push(join(root, '_oss_data', '.zcode', 'v2', 'bridge-port.json'))
  }

  return out
}

/**
 * 扫描根目录（只返回**已存在**的目录，避免大量无效候选）。
 */
function scanRoots(): readonly string[] {
  const roots: string[] = []
  if (process.platform === 'win32') {
    for (const drive of ['C', 'D', 'E', 'F', 'G', 'H']) {
      const base = `${drive}:\\`
      if (!existsSync(base)) continue
      try {
        for (const entry of readdirSync(base, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue
          // 跳过系统目录 —— 它们不可能放 ZCode 数据
          if (/^\$|^Windows$|^Program Files|^ProgramData|^System Volume|^Recovery/i.test(entry.name)) {
            continue
          }
          roots.push(join(base, entry.name))
        }
      } catch {
        /* 无权限的盘符跳过 */
      }
    }
  } else {
    for (const base of ['/opt', '/srv', join(homedir(), 'projects')]) {
      if (!existsSync(base)) continue
      try {
        for (const entry of readdirSync(base, { withFileTypes: true })) {
          if (entry.isDirectory()) roots.push(join(base, entry.name))
        }
      } catch {
        /* 忽略 */
      }
    }
  }
  return roots
}

/** 桥的发现信息。 */
export interface BridgeDiscovery {
  /** 监听端口。 */
  port: number
  /** 访问令牌（`Authorization: Bearer <token>`）。 */
  token: string
  /** 桥自报可用的模型 id。 */
  models: readonly string[]
  /** 发现文件的实际路径（诊断用）。 */
  sourcePath: string
}

/**
 * 读取桥的发现信息。
 *
 * 返回 `undefined` 表示**没找到**（ZCode 实例没跑，或数据目录不对）。
 * **不抛错** —— 调用方（`listModels`）需要的是「返回空数组」这一语义，
 * 抛错会在 DSH 界面上多一条 provider 失败记录。
 */
export function readBridgeDiscovery(): BridgeDiscovery | undefined {
  for (const candidate of bridgeDiscoveryCandidates()) {
    if (!existsSync(candidate)) continue
    try {
      const raw = readFileSync(candidate, 'utf8')
      const parsed = JSON.parse(raw) as {
        port?: unknown
        token?: unknown
        models?: unknown
      }
      const port = typeof parsed.port === 'number' ? parsed.port : Number(parsed.port)
      if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) continue
      if (typeof parsed.token !== 'string' || parsed.token.length === 0) continue
      const models = Array.isArray(parsed.models)
        ? parsed.models.filter((m): m is string => typeof m === 'string')
        : []
      return { port, token: parsed.token, models, sourcePath: candidate }
    } catch {
      // 文件正在被写入 / 格式损坏 —— 试下一个候选，不抛错。
    }
  }
  return undefined
}

/** ZCode 凭据（存的是桥的访问信息，不是远端 token）。 */
export interface ZcodeCredential {
  /** 桥的访问令牌。 */
  bridge_token: string
  /** 上次观察到的端口（仅记录用；**实际请求必须重读文件**）。 */
  bridge_port: number
  /** 账号标识（显示用）。 */
  account_label?: string
  /** 不可续期（桥的 token 由实例自己管理）。 */
  refresh_token?: undefined
}

/**
 * 凭据是否过期。
 *
 * ⚠ **恒为 `false`**：ZCode 的凭据是「本机桥是否活着」，
 * 而不是一个有有效期的远端 token。端口与 token 随实例重启变化，
 * 那个变化由**每次重读发现文件**处理，不是「续期」。
 *
 * 保留这个函数是为了让适配器可以无条件调用它（与其它 provider 同形），
 * 而不是让调用方到处写 `provider === 'zcode'` 的特例。
 */
export function isZcodeExpired(_credential: ZcodeCredential): boolean {
  return false
}

/** ZCode 是否可续期 —— 见 {@link isZcodeExpired}，**否**。 */
export const ZCODE_REFRESHABLE = false
