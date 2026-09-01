# trace-context-percent: Trace 页面 + Chat 顶栏显示当前 context 占比

> **功能类 / UI**。本 spec 是 [MonoX/spec/requirements/metric-context-window.md](../../../MonoX/spec/requirements/metric-context-window.md) 的 client 端消费 spec。
> server 端把 `context_window` 塞进 `MetricChunk.metrics.tokens.context_window`（详见 server 端 spec），
> 本 spec 规定 MonoDesk 怎么算、怎么画。

## 问题

MonoDesk 当前在两处丢了关键信息：

1. **Trace 详情面板**（点 message 旁的 trace 按钮打开）：显示每 step 的 prompt_tokens / completion_tokens / cached_tokens，但**不知道模型 context window**——没法说「这一步用了多少 % 的 context」。
2. **Chat 顶栏 / 消息列表**：用户看不到 session 当前累积的 context 多大、距离上限还有多远。compression 触发后突然归零，也没有视觉提示。

## 目标

1. Trace 详情面板每个 step 显示「`prompt_tokens / context_window` (NN.N%)」+ 进度条
2. Chat 顶栏（statusbar 或 assistant label 旁边）显示**当前 session 的最新 step**的 context 占比，作为常驻指标
3. context_window 未知（server 没传）→ 占位「— / —」+ 隐藏百分比
4. 高占用警告：占比 ≥ 80% 时进度条变橙；≥ 95% 变红（预警下次 step 可能压缩）

## 设计

### 1. 数据来源

每条 `MetricChunk.metrics.tokens`：

```ts
{
  prompt_tokens: number,        // 已存在
  completion_tokens: number,    // 已存在
  cached_tokens?: number,       // 已存在
  context_window?: number,      // 新增，见 server 端 spec
}
```

`context_window` 缺失 → 视作未知：UI 显示「— / —」+ 隐藏百分比，不报错。

### 2. Trace 详情面板（已有 trace-page component）

每 step 节点（已有 trace-node）加：

```
┌─ Step 3 · 0.84s · claude-sonnet-4-5 · tok 1,234 ─┐
│  Prompt:  5,832 / 200,000  ▓▓▓░░░░░░░░  2.9%      │  ← 新增
│  Cached:  4,200 (72% hit)                          │  ← 已有，可能需要补 cached/total
│  Output:  412                                       │  ← 已有
└────────────────────────────────────────────────────┘
```

进度条颜色规则：

| 占比 | 颜色 |
|---|---|
| < 60% | 蓝（accent） |
| 60–80% | 黄（warning） |
| 80–95% | 橙（caution） |
| ≥ 95% | 红（critical，下次 step 可能压缩 / 触发断点） |

### 3. Chat 顶栏常驻指标

位置：assistant label 行（同 [runId / tokens](#辅助设计) 旁），文字 + 迷你进度条：

```
Agent   5,832 / 200,000 tok · 2.9%   ▓░░░░░░
```

更新时机：每收到 MetricChunk → 替换为该 step 的 `prompt_tokens` / `context_window`。

session 多 step 时永远显示**最后一个 step**的 prompt 大小
（不累加——server 的 `usage.prompt_tokens` 就是「这次发给 LLM 的所有 message 序列化后的总 token」，
已经包含 system + tools + 历史 messages + 用户新 input）。

### 4. 数值精度

- prompt_tokens 整数显示
- context_window 千分位分隔（`200,000` 不是 `200000`）
- 百分比保留 1 位小数（`2.9%` 而不是 `2.92%`）

### 5. 缺失 context_window 的 fallback

server 没传 → 显示 `— / — tok`，**不**显示百分比，进度条隐藏。

实现：

```ts
const ctx = metric.tokens?.context_window;
const prompt = metric.tokens?.prompt_tokens ?? 0;
const ratio = ctx ? (prompt / ctx) * 100 : null;
// ratio === null → UI 显示占位
```

## 辅助设计

复用现有 `Msg` 的 `tokens` 字段（已经有 `prompt / completion / cached`），
新增 `contextWindow?: number`：

```ts
// engine.ts
| {
    ...
    tokens?: {
      prompt: number;
      completion: number;
      cached?: number;
      contextWindow?: number;  // 新增
    } | null;
    ...
  };
```

MetricChunk → Msg 写入路径已经走 `onMetric` callback，写入时带 `contextWindow` 即可。

## 不做的事

- 不算「session 累积 token」（每 step metric 独立，不累加）
- 不在 client 维护自己的 context_window 表（永远读 MetricChunk）
- 不做"超 context_window 警告弹窗"（server 端 [context-compression.md](../../../MonoX/spec/requirements/context-compression.md) 已经处理）
- 不在 chat 主消息流里每条 user message 显示占比（避免冗余——顶栏常驻就够了）

## 验证

1. 单测：`TraceContextPercent.test.tsx`
   - 收到 MetricChunk 带 context_window → 渲染「X / Y tok · Z%」
   - 收到 MetricChunk 不带 context_window → 渲染「— / — tok」不报错
   - 收到多 step → 显示最后一个
   - 占比 ≥ 80% → 进度条变橙；≥ 95% → 红
2. 手动：MonoDesk 跑长会话 → 看 trace 详情面板 step 的 prompt 占比 + chat 顶栏常驻指标同步刷新

## 进度

- 设计：本文档
- 实现：未开始