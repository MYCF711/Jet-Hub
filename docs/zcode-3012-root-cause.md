# ZCode Plan 的 3012 风控：根因已定位，及一条实测可行的替代路径

> 状态：**根因已定位**（非推测，有决定性实验）
> 日期：2026-09-27
> 适用对象：任何想让 DSH 用上 ZCode Plan（`zcode.z.ai`）免费额度的实现

---

## 为什么写这份文档

Jet Hub 本地曾有一个 `zcode` provider 的实验分支，走「**自己解阿里云 captcha
+ 直连上游**」。那份工作的排查记录 `zcode-405-root-cause.md` 自陈：

```
状态：未定位到根因。已排除 13 个维度（含一度以为找到的 captcha 指纹），全部证伪。

## 证据 B —— 真实 Chromium 产的 param 仍然 3012：
=== 真实浏览器 captcha → chat ===
{"code":3012,"msg":"request has been blocked due to unusual activity."}
[HTTP 405]
```

**这份文档给出那个根因，以及一条能跑通的替代路径。**
目的是避免后来者重复我已经走过的两百多次实验。

---

## 一、根因：3012 的判据在服务端的「会话注册状态」

**关键实验是「变量交换」（决定性）：**

```
抢在正常链路之前，用【新鲜 captcha】自己直发上游
  → 3012 转移到了抢发方
  → 正常链路反而拿到 3007（材料被抢先消费）
```

**⇒ 3012 跟随「新鲜材料」移动，不跟随发送者、不跟随头集合。**

也就是说：**客户端做的事（解出正确的 captcha）不影响判定结果**。
判据在服务端，与客户端无法预置的会话状态绑定。

### captcha 材料本身不含会话标识

把 captcha param 解码后是：

```
{certifyId, sceneId, isSign, securityToken}
```

**零个会话标识字段。** 说明绑定关系在服务端按「谁先消费 + 消费时的会话态」
判定 —— 不是客户端能构造出来的。

---

## 二、已排除的路线（**全部实测，不要再试**）

| 路线 | 实测结果 |
|---|---|
| 补 11 个来源头（`User-Agent` / `HTTP-Referer` / `X-Title` / `X-ZCode-App-Version` / `X-Platform` / `X-Release-Channel` / `X-Client-Language` / `X-Client-Timezone` / `X-Os-Category` / `X-Os-Version` / `X-Device-Mid`） | 仍 3012 |
| 补 6 个会话头（`x-session-id` / `x-query-id` / `x-zcode-trace-id` / `x-zcode-session-type` / `x-zcode-agent` / `anthropic-beta`） | 仍 3012 |
| **头集合逐字段对齐真实会话请求（25 个头，完全一致）** | **仍 3012** |
| 补 body 形状（5 组变体） | 全 3012 |
| 换鉴权形式（Bearer / `x-api-key` / 两者 / +`anthropic-beta`） | 全 3007，与 3012 无关 |
| 补客户端签名（`X-Client-Sig` / `X-Client-Pow`） | **开源版本来就不带**；闭源版那套由服务端 feature gate 控制（`isEnabled: async () => false`） |
| 用真实 Chromium 产出 captcha（非 happy-dom） | **仍 3012**（见上文证据 B） |
| 复用观察者捕获的旧材料 | 3007（一次性，必然） |
| **抢新鲜材料自己发** | **3012**（决定性反证） |

### 一个反直觉的发现

壳内模型请求**不带** `X-Device-Mid`（只有 `/billing/*` 那类管理接口带）。

**⇒ 头集合与真实请求「越像越好」，不是「越多越好」。**

### 路由验证（排除「405 是路由错」）

```
/zcode-plan/anthropic/v1/messages  → 带 apiKey 无 captcha 时 3007  → 路由对
/anthropic/messages                → 404                         → 路由错
```

**405 是风控刻意返回的状态码**，不是路由不匹配。

---

## 三、为什么「自己解 captcha」的思路会走进死胡同

那个思路隐含一个假设：

> captcha 不够真 → 上游识别为伪造 → 3012

**这个假设被两条实测推翻：**

1. 真实 Chromium（真实 GPU、真实 canvas、`hardwareConcurrency=16`）产出的
   token 与 happy-dom 版**前 64 + 后 42 字符完全相同** ——
   那段固定内容是**服务端下发的固定结构**，不是本地指纹的产物。
   「82.8% 固定」是正常形态，不构成降级证据。

2. 即便用真实浏览器产出形态完全正确的 param，**仍然 3012**。

⇒ **投入在「提升 captcha 质量」上是无底洞。** 判据不在这里。

---

## 四、实测可行的替代路径：走壳内会话链路

**核心转变：不自己发请求，而是让 ZCode 实例自己发。**

```
DSH ──▶（插件）──▶ 本机 HTTP 桥 ──▶ ZCode 实例的会话链路 ──▶ zcode.z.ai
                     (loopback)      (createTask/sendPrompt)   (免费额度)
```

桥跑在 ZCode Electron 实例的 host 进程里，通过实例自己的 `createTask` +
`sendPrompt` 驱动对话。**captcha 与风控由实例自己处理** —— 因为那本来就是
它的正常工作方式（用户手动用界面时走的就是这条链）。

### 实测结果

| 项 | 状态 |
|---|---|
| 对话 | ✅ 跑通（8-25 秒，中位 15-25 秒） |
| **工具调用** | ✅ **跑通**（`tool_call` + `tool_result` 成对，模型给出真实执行结果） |
| captcha | ✅ 不需要自己解 |
| 3012 | ✅ 不再出现 |

### 工具调用是怎么实现的

桥把 DSH 的工具表渲染成提示词注入，模型按约定输出 ```json 围栏；
桥解析后翻成 OpenAI 兼容的 `tool_calls` 形状回给 DSH。

**⚠ 一个已踩的坑**：桥的 preamble 原本写「不要调用任何工具」，
导致模型连调用方给的工具协议也拒绝（回答「按本次桥接模式的约束，
我不能调用工具」）。

**修法**：把「你自己的内置工具」与「调用方给你的工具协议」**显式分开**，
并明确后者不受前者限制 —— 不加限定的禁令会连带禁掉同类但不同的东西。

---

## 五、这条路为什么不适合直接做成 Jet Hub provider

**坦白说：不适合。** 与 `docs/adding-a-new-provider.md` 的框架冲突：

| 规范要求 | 本方案 |
|---|---|
| 凭据结构含 `access_token` | **没有凭据**（靠本机桥） |
| `xxx-auth.ts` 继承 `Service` 管登录/续期 | **没有登录**（壳自己管） |
| 账号池可管理多账号 | **单实例桥** |
| 纯 HTTP 适配 | **进程编排**（spawn 壳 + 保活 + 探活） |
| 内存几 MB | **约 950 MB** |
| `listModels` / `resolveModel` / `stream` | ✅ 契约匹配 |

**⇒ 本文档只作为排查记录并入，不提供 provider 代码。**

如果将来要做成 provider，建议的形态是「**桥客户端**」：
不 spawn 进程，只读 discovery file（`bridge-port.json`）并转发，实例由用户自备。
这样不碰 Jet Hub 的架构假设。

---

## 六、附带结论：纯 Node 替代 Electron 走不通

我试过用纯 Node 跑 ZCode 的 CLI（`zcode.cjs`）来省掉 Electron 外壳（338 MB）：

**它能启动**：
```
$ node zcode.cjs --version      → 0.16.9  (exit 0)
$ node zcode.cjs doctor         → node: v24.20.0  (exit 0)
```

**但走不通，死结在 captcha。** 字符串计数是决定性的：

| 搜索词 | CLI（`zcode.cjs`，16 MB） | renderer（`styles-*.js`，5.64 MB） |
|---|---|---|
| `o.alicdn.com` | **0** | 1 |
| `AliyunCaptcha` | **0** | 4 |
| `aliyun` | **0** | 有 |
| `X-Aliyun` | **0** | 有 |
| `Verify-Param` | **0** | 有 |

renderer 里加载的是：
```js
var yqt = `https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js`
```

**那是阿里云的浏览器 SDK，需要 DOM。**

**CLI 里连 `aliyun` 这个词都不存在** —— 动态拼接也需要字面量碎片，
而一个碎片都没有。**captcha 是 renderer 独占能力。**

（顺带定位了 `--prompt` 的精确抛点，供后人参考：
`createTurnModel` → `WC(e, t)` → `if (!t.selection) throw
"Select a model before continuing"` —— 缺的是会话状态，不是凭据。
但补上之后仍卡在 captcha，所以这条路整体不值得走。）

---

## 七、验证方式（供审阅者复核）

```powershell
# 1) 部署（10-40 分钟）
git clone https://github.com/MYCF711/dsh-free-glm.git
cd dsh-free-glm
pwsh -File deploy-zcode-instance.ps1

# 2) 装插件
dsh plugin --profile web add file:./dsh-zcode-bridge-0.2.3.tgz

# 3) 重启 DSH，等约 30 秒

# 4) 验证工具调用（关键判据）
$env:DSH_HOME="$env:APPDATA\in.dsh-plug.dsh-launcher\homes\0.1.7-rc.2"
dsh --profile web --json "用 glob 工具查找 D:\ 下的所有 .ps1 文件"
# 期望输出含 tool_call 与 tool_result 成对出现
```

---

## 八、来源

- 完整仓库：https://github.com/MYCF711/dsh-free-glm （另有 Gitee 镜像）
- 已知缺点：仓库的 `LIMITATIONS.md`
- 延迟/内存实测：仓库的 `LATENCY-FINDINGS.md`
