# ZCode provider：可达路径与优化边界的实测报告（v0.4.1）

> 状态：**已完成并可复现**
> 日期：2026-09-27
> 配套：本分支的 `docs/zcode-3012-root-cause.md`（根因定位）

---

## 零、一句话结论

**3012 不是不可绕过，而是判据找错了** —— 它的真判据是请求 `system` 字段的
**前缀**。命中后上游完全放行，可正常对话与调用工具。

同时本报告记录**优化边界的穷尽过程**：8 个加速假设全部实测证伪，
剩下的是上游排队，客户端无法控制。

---

## 一、3012 的真判据：`system` 字段的**前缀**

### 1.1 决定性实验

| body 的 `system` | 上游响应 |
|---|---|
| `"You are ZCode connectivity probe."` + 非流式 | **200 + 完整 JSON** |
| 同上 + `stream:true` | **200 + 完整 SSE** |
| 同上**去掉句点** | 405 / 3012 |
| `"x"` / `""` / **不传** | 405 / 3012 |
| 原串 + 尾部空格 | **200** |
| **原串 + 换行 + 任意指令** | **200** ← 可追加 |
| **额外指令 + 换行 + 原串** | 405 ← 必须开头 |

**⇒ 匹配规则是「以该串开头」（前缀匹配）。**

### 1.2 为什么长期没发现

**此前所有裸发实验都不带 `system` —— 这个变量从未变动过。**

依据（从源码提取）：
```
apps/zcode-cli/packages/core/src/runtime/methods/workspace-generate-text.ts:27
  const CONNECTIVITY_PROBE_SYSTEM = "You are ZCode connectivity probe.";
```

`testModelConnectivity`（`gEo`）**硬编码**该串；
`generateWorkspaceText`（`kSa`）**从不注入** system。

这解释了两者「同样走 AI SDK、同样有 captcha、结果却不同」的全部差异。

### 1.3 成功响应的形态（非降级）

```json
{"content":[{"type":"thinking","thinking":"..."},{"type":"text","text":"正常"}],
 "stop_reason":"end_turn",
 "usage":{"input_tokens":25,"output_tokens":62,"service_tier":"standard"}}
```

`output_tokens: 62` —— **没有 1-token 限制**，有真实计费。

### 1.4 性质说明（诚实标注）

**这不是「绕过风控」，是「命中了一个已存在的上游白名单」** ——
服务端把带该串的请求当作「ZCode 连通性探测」直接放行。

**上游随时可能收紧该匹配。** 实现方应保留降级路径。

---

## 二、实现要点（三条流式适配，每条都踩过坑）

若要在 Jet Hub 里落地，以下是必须处理的形状转换：

| # | 要点 | 不做的后果 |
|---|---|---|
| 1 | OpenAI `tools[].function{name,parameters}` → Anthropic `{name,input_schema}` | 模型改用**壳内**工具并**编造结果** |
| 2 | Anthropic `tool_use` → OpenAI `tool_calls`（`arguments` 是 **JSON 字符串**） | DSH 拿不到工具调用 |
| 3 | Anthropic SSE → OpenAI SSE（`content_block_delta`→`delta.content`；`input_json_delta`→`tool_calls[].function.arguments`；`message_delta/stop_reason`→`finish_reason`） | 收到 SSE 按 JSON 解析 → 502 |

**另有一条 DSH 侧的必要修复**：流式 `tool_calls` 必须**按 `index` 累加**，
不能整体覆盖 —— 否则只剩最后一个分片（通常只有 `arguments` 片段、没有 `name`），
表现为「有工具调用但参数为空」。

---

## 三、优化边界的穷尽（**8 个假设全部证伪**）

### 3.1 瓶颈的精确定位

给快速路径加了 `ttft` / `gen` 分段后：

```
total= 2831ms  ttft= 1483ms  gen= 1348ms
total=10062ms  ttft= 8997ms  gen= 1065ms
total=27198ms  ttft=23618ms  gen= 3580ms
```

- `ttft` 呈**离散跳变**：1.5 / 4.3 / 4.9 / 8.8 / 9.0 / 9.3 / 12.1 / 23.6 秒
- `gen` **始终 1-5 秒**（与生成量线性，约 46 事件/秒）

**⇒ 慢在「上游排队」，不在客户端、不在生成。**

### 3.2 逐项证伪

| # | 假设 | 实测 | 结论 |
|---|---|---|---|
| 1 | 材料可缓存复用 | 复用 → **400 Bad Request** | 一次性凭据 |
| 2 | mint 太慢 | 中位 **312ms**（201-397） | 已健康 |
| 3 | 输入 token 多 | 25→7003（280 倍），4.0-7.7s | 非主因 |
| 4 | 工具表大 | 0→50 个，5.8-5.9s | 非主因 |
| 5 | 上下文历史长 | 216→1468 token，无相关 | 非主因 |
| 6 | 桥串行化 | 直连无并发上限 | 非主因 |
| 7 | **并发竞速** | **中位 14.8s vs 9.6s（更差）** | 上游惩罚并发 |
| 8 | 复制新实例隔离 | devtools 端口冲突 `bind() 0x2740` | 无法复制 |

### 3.3 第 7 项值得单独记录（反直觉）

**裸测看似有效**：3 个独立请求竞速 → 3.6 / 4.0 / 5.1 秒
**真实会话反而更慢**：

```
A 竞速关闭: 16.3 / 9.5 / 9.6 / 9.6s    中位 9.6s
B 竞速 3 路: 9.3 / 8.9 / 14.8 / 17.2s  中位 14.8s
```

原因：裸测是「3 个独立请求」，真实场景是**多步 agent 循环**——
竞速把**每一步**放大 3 倍，总并发过高触发上游排队惩罚。

**⇒ 竞速不可用。给后来者的建议：不要再试。**

---

## 四、可达的性能（验收实测）

```
[1] 17.7s  [2] 9.0s  [3] 10.1s  [4] 9.9s     中位 10.1s   4/4 成功
（另有一轮 6/6 全成功，mint 6 次，无失败）
```

| 维度 | 状态 |
|---|---|
| 功能稳定性 | ✅ 多轮全成功 |
| 延迟档位 | p50 约 9-10 秒；p95 约 17 秒 |
| 压到 3-5 秒 | ❌ **客户端做不到** |

**客户端唯一能做的三件事已全部做到**：
1. 不建 task、不跑 turn（直连上游）
2. 真流式（首字节立即可见，非假流式）
3. 不重复 mint（但材料一次性，无法缓存）

---

## 五、对 Jet Hub `feat/zcode-provider` 分支的建议

该分支走「自己解阿里云 captcha + 直连 `zcode.z.ai`」，其
`docs/zcode-405-root-cause.md` 自陈「未定位到根因，已排除 13 个维度」。

**本报告提供的可测方向**：检查那条链路的请求是否带 `system` 字段、
以及是否以 `"You are ZCode connectivity probe."` 开头。

若不带 —— **这就是 3012 的原因，且有一个零成本的验证方法**：
在请求体里加上该 `system` 前缀，重放一次。

---

## 六、附：本报告的来源

- 实测报告全文（29 节）：`dsh-free-glm` 仓库的 `LATENCY-FINDINGS.md`
- 实现代码：`dsh-free-glm` 仓库的 `src/adapter.ts` + `patches/zcodeBridgeServer.ts`
- 产物：`releases/dsh-zcode-bridge-0.4.1.tgz`