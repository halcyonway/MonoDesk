# conversation-ui-polish: reasoning 节奏 / tool args 隐藏 / step N 删除 / 设计感 + TasksPage 宽度

> MonoDesk UI polish 任务（2026-09）。本文件是行为契约 + 设计意图，`src/stream/engine.ts`、
> `src/components/Conversation.tsx`、`src/styles.css` 是实现。
>
> 视觉稿：`spec/ui/conversation-ui-polish.html`

---

## 1. Context：5 个用户反馈 + 1 个 TasksPage 宽度

用户在截图里点出的具体问题：

1. **reasoning 不丝滑** —— `paintReasoning` 当前 `REASONING_CPS = 90`，每 tick 33ms 释放 `dtMs * 90 / 1000 ≈ 2` 字 ≈ 60 cps。
   感觉"不是一字一字出来，是一下出好多"。期望字符打字机效果。
2. **tool args 展示不全** —— `Conversation.tsx:ToolBlock` 的 `<span className="t-args">{child.args}</span>`
   mono 字体截断显示，但完整 args（fork_task description / bash 命令）一截就看不出有用信息。
   "还不如不展示"。
3. **step N 完全不对** —— `engine.ts:onMetric` 每收 metric 事件就 appendChild 一个 `note` child，
   文本 `"step N · Xms · Ytok · Ztool"`。`step_idx` 顺序错乱、`tool_calls_count` 字段语义不明
   （per-step vs 累计）。msg.tokens / msg.latencyMs 已经承载这部分信息。
4. **设计感不够** —— 当前 block 用 1px border + monospace 标签，简洁但偏代码 console 风。
   要"简洁 更有设计感"。
5. **TasksPage 卡片宽度不对** —— 截图里 task 卡片撑满整个主区域宽（~1000px），不像 Chat 那样有
   max-width 760px 居中。根因：`#tasks-page` 在 `#body`（flex column）里被 `align-self: stretch`
   默认行为撑满；`max-width: 760px; margin: 0 auto` 在 stretch item 上 auto margin 失效
   （剩余空间为 0，auto 被视为 0），所以页面左对齐 + 视觉上贴边。

## 2. 设计

### 2.1 reasoning 字符打字机（engine.ts）

**改 paintReasoning 释放速率**：`REASONING_CPS` 从 90 → 30（约 1 字/tick @ 33ms）。

```ts
// engine.ts:131
const REASONING_CPS = 30;        // reasoning 字符打字机：~1 字/tick @ 30fps
```

**理由**：`paintReasoning` 用 `Math.floor((dtMs * REASONING_CPS) / 1000)` 计算本 tick 解锁字符数。
当前 90 → 实际 ~2 字/tick；改成 30 → ~1 字/tick，配合每个 char 的 `.ch.fresh` 180ms fade-in，
每个字符视觉上"独占一帧"，符合"一个字一个字出来"的预期。

text 仍用 `CHARS_PER_TICK = 3`（90 cps），跟 reasoning 节奏拉开层次（正文快，思考慢）。

### 2.2 tool args 隐藏（Conversation.tsx）

`ToolBlock` 删掉 args span 和 pending placeholder。tool name + badge + latency 即可。
`child.args` 字段保留在 data 模型里（折叠展开 body 仍可见，跟 fork_task 等 task tool 一致；
非 task tool 默认折叠看不到）。

修改点：

```tsx
// Conversation.tsx:ToolBlock 删掉：
{child.args ? (
  <span className="t-args">{child.args}</span>
) : pending ? (
  <span className="t-args t-args-pending">parsing args…</span>
) : null}
```

`styles.css` 里 `.t-args` / `.t-args-pending` 两条样式同步删（dead code）。
task tool（fork/cancel/poll）走 `TaskBlock`，不在这条路径里。

### 2.3 step N 删除（engine.ts）

`engine.ts:onMetric` 整段替换为「不创建 note child」：

```ts
// 删掉：
this.appendChild(cb, sk, { id: nextId(), kind: "note", text });
```

只保留：写 `msg.runId` / `msg.tokens` / `msg.latencyMs` / `setMetrics` / `setSteps`（这些是 step
sidebar / agent label 上的指标来源，不在 children 里出现）。

`Conversation.tsx` 的 `NoteBlock` 和 `styles.css` 的 `.metric-note` 不删（保留给 `onCard` / 未来用），
只是当前 `onMetric` 不再走它。

### 2.4 TasksPage 宽度修复（styles.css）

**根因**：`#body` 是 `display: flex; flex-direction: column`，`#tasks-page` 作为 flex item 默认
`align-self: stretch`，被横向撑满。`max-width: 760px` 起作用但 `margin: 0 auto` 在 stretch item
上 auto margin 失效（剩余空间为 0，auto 被视为 0），所以页面左对齐 + 视觉上贴边。

**修法**：给 `#tasks-page` 加 `align-self: center`，让 flex item 在 cross axis 居中。

```css
#tasks-page {
  align-self: center;          /* 关键：让 flex item 居中，max-width + margin auto 才生效 */
  width: 100%;                  /* 在 align-self: center 下，width 仍需声明才能撑满到 max-width */
  max-width: 760px;
  margin: 0 auto;
  padding: 24px 28px;
  overflow-y: auto;
}
```

`.task-list { max-width: 100%; }` 确保 task-list 跟随父容器宽度。

### 2.5 设计感提升（styles.css）

针对 4 个具体组件微调，不做大改：

**a) reasoning / tool block** —— 去掉 1px border，改用左侧 2px accent stripe + soft shadow：
- `.block`：删 `border: 1px solid var(--border)`，加 `box-shadow: 0 1px 2px rgba(0,0,0,0.04)`。
- `.block-head`：font-family 改 sans-serif（不再 monospace），letter-spacing 提升。
- `.block.open .block-head`：背景渐变到 `--bg-hover` + 圆角。

**b) 圆点** —— `.r-dot / .t-dot` 从 8x8 实心圆 → 6x6 + box-shadow 半透明晕（glowing dot 效果）。

**c) badge** —— `.t-badge` padding 从 1px 7px → 2px 8px；running badge 加 1px outline 更明显。

**d) task card** —— 同样去掉 1px border 改 soft shadow；dot 加 box-shadow halo；卡片 max-width
收窄到 720px（窄于 #tasks-page 760，留出边距）。

**e) metric pill** —— `msg-meta-tokens / msg-meta-lat / msg-meta-cache` 当前小字号灰底，保留但
改用 1px border + 不同字号梯度。

**不改的**：颜色变量（`--thinking / --tool / --accent` 等）、layout 间距、字体家族、整体色调。
只调「border → soft shadow」「mono label → sans」「dot → glow」「flex 居中」这四类。

## 3. 文件清单

### 修改（3 个文件）

| 文件 | 修改 |
|---|---|
| `src/stream/engine.ts` | REASONING_CPS 90→30（line 131）；删 onMetric 的 appendChild note |
| `src/components/Conversation.tsx` | ToolBlock 删 args span |
| `src/styles.css` | `.block` 改 soft shadow、`.block-head` 改 sans、`.r-dot/.t-dot` 加 glow、`.t-badge` padding、`#tasks-page` 加 `align-self: center` + `width: 100%`、`.task-card` max-width 720px、删 `.t-args` / `.t-args-pending` |

### 不动

- `engine.ts` 其他逻辑（paintText / freezeText / jbQueue 等不动）
- `Conversation.tsx` 其他组件（ReasonBlock / TextStream / MsgView 不动）
- `TasksPage.tsx` / `TaskBlock.tsx` 组件本身（只调 CSS）
- Markdown 渲染（已单独修过，不重做）
- Wire protocol / 数据模型（`child.args` 字段保留，只是不展示）

## 4. 验证

### 4.1 单测：vitest 全跑

```bash
cd MonoDesk && npx vitest run
# 期望：120+ passed（之前 120 passed，不破现有）
```

新加 1 个 `engine.test.ts`：
- paintReasoning 释放速率（mock 字符 + 验证 ~30 cps）

### 4.2 手工 e2e

```bash
cd MonoDesk && npm run dev
# MonoX runtime 起在另一个终端
# 测试场景：
# 1) 发一条触发 reasoning 的消息（如 "看看这个仓库"）→ 验证一个字符一个字符浮现
# 2) 触发 fork_task 工具 → 验证 tool head 不再显示 args 截断
# 3) 触发多步 tool call → 验证 msg.tokens / msg.latencyMs 仍显示累计指标，
#    但 children 列表里不再有 "step N · ..." 那行
# 4) 切到 Tasks 页面 → 验证 task card 居中在 760px 内，meta 行不再横跨整页
```

### 4.3 设计检查

截图前后对比：
- block 不再有硬 border，有 soft shadow
- dot 有 glow 效果
- label 字体 sans 不再 mono
- TasksPage 卡片居中不贴边

## 5. 关键不变量

- `child.args` 字段保留（fork_task 等 task tool 的折叠体仍可看）
- `msg.tokens` / `msg.latencyMs` 仍承载指标，step sidebar (`setSteps`) 仍正常
- PaintText 不动（正文 90 cps），只动 PaintReasoning 节奏
- 颜色变量不动，只调 border / shadow / font-family / dot 视觉细节
- TasksPage 数据流不动（ws subscribe / store / queryTaskList）

## 6. 不做（明确范围）

- 不重做整个 layout / 重新设计 sidebar
- 不引入图标库（保持 emoji + 内联 SVG 的当前形态）
- 不动 wire protocol
- 不动 MonoX 端
- 不重写 TasksPage（只调 CSS 居中 + task-card 宽度）