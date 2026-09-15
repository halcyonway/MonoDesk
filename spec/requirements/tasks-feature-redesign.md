# tasks-feature-redesign: 异步任务 UI 整体重做（list + detail）

> MonoDesk UI 改版任务（2026-09）。本文件是行为契约 + 设计意图。
> 对应 issue：用户在 `feat/conversation-ui-polish` 之后反馈「task 界面太丑了」（list 页 6 个问题），
> 又截图详情页「点进去看也很丑」 —— 要求**整体看一下，不要局部优化**。
> 视觉稿：`spec/ui/tasks-feature-redesign.html`。

---

## 0. 整体设计语言（list + detail 共享）

整个 Tasks feature 用一套 design tokens / 视觉骨架，list 和 detail 都遵守：

| 元素 | 设计 |
|---|---|
| **状态色带** | 4px 左 stripe，status → color（running=accent / completed=ok / failed=error / timed_out=thinking / cancelled·interrupted=faint） |
| **状态点** | 8x8 dot + glow halo（running 带 `@keyframes dot-pulse` 2.4s 呼吸） |
| **状态文字** | 跟 stripe 同色，10px/600/uppercase，跟 stripe 视觉关联 |
| **title 字号** | 14px sans-serif / 600（卡片）/ 18px（详情页头） |
| **meta 行** | 11-12px faint，最淡的一级 |
| **cancel** | 24x24 圆形 icon button（详情页 30x30 + 文字），不再是拉伸一列或红字 |
| **宽度阶梯** | conversation 760 (reading) < tasks-list 880 (list) < task-detail 880 (同 list 一致) |
| **kind pill** | 10px uppercase、tool-bg / tool 色背景色块 |

list 和 detail 共享 token，让用户从列表点进去**视觉一致**：同样的状态色带、同样的点、同样的 cancel 形态、同样的宽度阶梯。

---

## 1. Context：6 + 4 个用户反馈

### 1.1 list 页（`TasksPage`）6 个问题

1. **视觉层级扁平** —— task_id / subagent / running badge / description / meta 全在一种字号
   一种字色，主体描述行跟 meta 行视觉上一样重。
2. **running 卡片被 cancel 按钮撑高** —— 按钮 `align-items: stretch` 把整张卡垂直拉满。
3. **状态指示太弱** —— `task-dot` 8x8 纯色小圆点，running/completed 一眼分不出来。
4. **description 跟 meta 都太挤** —— 12px/11px 差 1px 视觉上几乎一样；一行塞 5 个字段糊在一起。
5. **task_id 跟 kind / status 抢戏** —— 三个东西同一行同一字号，谁是元数据谁是主语不分。
6. **page head 简陋** —— `Tasks 1 active ↻ refresh` 一行三个东西平铺。

### 1.2 detail 页（`TaskDetailPage`）4 个问题（用户后续截图）

7. **title 是 task_id 不是 description** —— `t_063a2b1ce69c` (13px) 当标题，
   真正的 description「I2I 风格化 · photo-journal」反而被埋在 meta 里。
8. **meta 单行平铺无主次** —— `running · subagent · parent: monodesk:mu2u... · timeout 30m`
   一行 4 个东西同字号同色。running 跟 parent 谁重要不分。
9. **meta 区用 dashed border + JSON dump** —— `kind: "i2i" template: "photo-journal"`
   像 debug 输出，不像产品 UI。
10. **cancel 是红字文本按钮** —— `cancel` 红字 link 风格，跟 list 卡片右上角 × 圆形按钮不一致。
    同样从「同一任务的不同视图」应该用同一种 cancel 形态。

## 2. 设计

### 2.1 卡片整体重做

**视觉骨架**（参照 `spec/ui/async-task.html` 的设计 token，但更紧凑）：

```
┌──────────────────────────────────────────────────────┐
│ ▎  ●  I2I 风格化 · photo-journal            ⊘ ×    │  ← 4px 左色带 + accent dot + title + cancel
│      5m · running                                    │  ← 副行：elapsed + 状态文字
│                                                      │
│   油画风格转换 · 输入图 http://...                    │  ← 描述（更大）
│                                                      │
│   subagent · monodesk:mu2u · 30m                     │  ← meta 行（最小、最淡）
└──────────────────────────────────────────────────────┘
```

**关键点：**

- **左 4px 色带**：status 决定颜色，running=accent (amber/紫)、completed=ok (绿)、
  failed=error (红)、cancelled/interrupted=text-faint (灰)、timed_out=thinking (amber)。
  跟 conversation 的 `block.tool` 左侧 stripe 一致。
- **accent dot**：8x8 + glow halo（保留现有 `.task-dot` 风格但更突出）。
- **title 行** = `description`，14px 正文 sans + 600 weight，是卡片的视觉锚。
  截断 + hover tooltip 显示完整。
- **status 文字**（running / completed / failed 等）作为 status stripe 颜色的文字色，
  不再是独立 badge —— 跟 stripe 重复反而碎。
- **kind badge**（subagent / bash_long / 等）作为小色块 pill（10px font, padding 1×6,
  bg 浅色，文字色 = 主题色），保留识别度但不抢 title。
- **meta 行**最淡：`<span class="faint">` 12px 灰，含 subagent kind / parent short id /
  timeout 分钟。**砍掉** `kind: "i2i", template: "photo-journal"` 这种 JSON 内部字段
  （详情页可见，卡片里是噪声）。
- **cancel 按钮**：右上角的小 × 圆形 icon button（24x24），不再是拉伸一列的竖条。
  点了 stopPropagation 避免触发行点击。
- **hover**：整张卡 box-shadow 加深 + bg 微微 tint（var(--bg-hover) 的 30%）。

### 2.2 状态色 → CSS 变量映射

| Status | stripe color | dot color | dot halo |
|---|---|---|---|
| `running` | `var(--accent)` | `var(--accent)` | `var(--accent-soft)` |
| `completed` | `var(--ok)` | `var(--ok)` | `var(--ok-bg)` |
| `failed` | `var(--error)` | `var(--error)` | `var(--error-bg)` |
| `cancelled` / `interrupted` | `var(--text-faint)` | `var(--text-faint)` | none |
| `timed_out` | `var(--thinking)` | `var(--thinking)` | `var(--thinking-bg)` |
| `pending` | `var(--text-muted)` | `var(--text-muted)` | none |

running 卡片整体加极轻的「脉动」：dot 用 `@keyframes dot-pulse` 让 box-shadow 慢呼吸，
给「还在跑」的活感（不抢主题，3s 一轮）。

### 2.3 page head 改版

```
┌──────────────────────────────────────────────────┐
│  Tasks                                  ↻ refresh │
│  1 active · 9 total                                │
└──────────────────────────────────────────────────┘
```

- "Tasks" 16px sans 600，单独一行。
- 副行 `1 active · 9 total` 12px muted：active 用 accent 色高亮。
- refresh 按钮：右上 icon-only（24x24 圆形 + 旋转 svg icon），hover 浅 accent 染。
  去掉 `↻ refresh` 文字，icon 已经够清楚。

### 2.4 数据流 / props 不变

只动 `TasksPage.tsx` 的 JSX 结构（`TaskCard` 子组件、page head），不动：

- `TaskEntry` / `TaskSummary` 类型
- `tasksStore`（singleton reactive store）
- `TASK_EVENT_RING` 事件流
- `queryTaskList` / `cancelTask` 协议
- `elapsed()` / `shortId()` / `metaPreview()` helper

`metaPreview` 不再渲染到卡片（详情页有 `TaskDetailPage` 展示完整 meta），
但 helper 函数保留（详情页可能用）。

### 2.5 detail 页改版（list 改完后用户跟进反馈）

detail 页用同一套 design language（§0），结构分三段：

```
┌──────────────────────────────────────────────────────────┐
│ ← Tasks                                                  │  ← back (icon-only / 30x30 round)
│                                                          │
│ ▎  ●  I2I 风格化 · photo-journal                ⊘ ×     │  ← 4px 左色带 + dot + title (description) + cancel
│      t_063a2b1ce69c                                      │  ← task_id mono faint
│                                                          │
│      RUNNING · subagent · parent monodesk:mu2u · 30m     │  ← status text + meta 一行
├──────────────────────────────────────────────────────────┤
│  Meta                                                    │
│   kind        subagent                                   │  ← key-value 网格，不是 JSON dump
│   template    photo-journal                              │
│   prompt      油画风格转换…                              │
├──────────────────────────────────────────────────────────┤
│  Events                                                  │
│   ● THINKING   80 chars                            ⌄     │  ← tool block 流（沿用 Conversation 渲染）
│   ● BASH       error   34ms                        ⌄     │
│   ...                                                    │
└──────────────────────────────────────────────────────────┘
```

**关键点：**

- **back 按钮** = icon-only 圆形按钮（30x30），跟 `.icon-btn-round` 同形态，箭头 icon。
- **title** = `description`（18px/600，跟 list 卡片同色 `var(--text)`），fallback 到
  `shortId(task_id)`。**不再用 task_id 当 title**。
- **task_id** 作为 sub：12px mono faint 在 title 下方一行。
- **status stripe + dot + status text** = 跟 list 卡片完全一致（共用同一段 CSS），
  颜色通过 `s-<status>` className 切换。
- **meta 副行** = status uppercase + kind pill + parent short + timeout 12px faint。
- **cancel** = 右上 30x30 round icon button（同 `.task-cancel` 但放大）。running 时才显示。
- **Meta section** = 标题「Meta」+ key-value 网格（label 11px muted / value 12px text）。
  砍掉 `dashed border + JSON.stringify` 的 debug 风格。
- **width** = 880px（跟 list 同宽，detail 不必更宽，因为 task 流渲染内嵌 Conversation 已经撑开）。

## 3. 文件清单

### 修改（3 个文件）

| 文件 | 修改 |
|---|---|
| `src/components/TasksPage.tsx` | `TaskCard` 重写 JSX；`StatusDot` 简化；page head 改两行结构；移除 `metaPreview` 调用 |
| `src/components/TaskDetailPage.tsx` | page head 三段重做：back icon-btn、title=description、task_id sub、status 行、cancel icon-btn；Meta 区块从 JSON dump 改 key-value 网格 |
| `src/styles.css` | `.task-card` 加 left stripe + hover；`.task-dot` 加 glow + pulse；`.task-status` 移除；`.task-cancel` 改 icon 按钮；新增 `.task-title` / `.task-sub` / `.task-meta` / `.task-kind-pill` / `.page-sub`；`.task-detail` page head 三段结构 + `.task-detail-meta-grid` key-value 布局；`.icon-btn-round` back 按钮 |

### 不动

- `TaskBlock.tsx`（Chat 流里的 task 块走的是另一套样式，不在这次改）
- `Conversation.tsx` / `store/tasks.ts` / `ws/client.ts`（协议 + store 不变）
- `TasksPage.test.tsx`（数据流不变，单测应该继续过）

## 4. 验证

### 4.1 vitest 全跑

```bash
cd MonoDesk && npx vitest run
# 期望：122+ passed（保持现状，TasksPage.test.tsx 关注数据流不受影响）
```

`TasksPage.test.tsx` 重点看：

- 排序（running 在前）不变
- 列表渲染数量 = store size
- 点击 `task-card-main` 触发 `onOpenTask`
- 取消按钮 stopPropagation 不触发行 click
- 空态文案不变

### 4.2 手工 e2e

```bash
cd MonoDesk && npm run dev
# 测：
# 1) 跑一个 fork_task（i2i apply），30s 内 → 看到 running 卡片有色带 + 脉动 dot + 右上 ×
# 2) 任务 completed 后 → 卡片色带变绿，× 消失
# 3) 故意让一个任务 failed → 红色 stripe
# 4) hover 卡片 → 整张卡有 shadow + 浅 hover bg
# 5) 点 × 不跳转；点其他区域跳详情页
# 6) page head 在所有任务都完成后，"active" 字样消失
# 7) 点卡片进详情页 → title 是 description (不是 task_id)，左边有色带、dot 跟 list 一致
# 8) 详情页右上 × 圆形 icon button（跟 list 同形态），cancel 行为正常
# 9) 详情页 Meta 区是 key-value 网格（不是 dashed JSON dump）
# 10) 详情页 back 按钮 = 圆形 icon，回到 list 后状态保留
```

### 4.3 设计检查

前后对比：
- 卡片有清晰的 status 色带（一眼区分 running / completed / failed）
- title（description）比 meta 字号大、字色深
- 整张卡同一高度（running 卡不再被 cancel 按钮撑高）
- page head 两行结构，副行带计数
- 详情页 title = description，task_id 退到 sub 行
- 详情页 meta 是 key-value 网格，不是 JSON dump
- 详情页 cancel = 圆形 icon button，跟 list 同形态

## 5. 关键不变量

- `TaskEntry` / `TaskSummary` 数据模型不动
- `tasksStore` subscribe / getSnapshot / 事件环不变
- `TaskBlock.tsx`（Chat 流里的任务卡）样式独立，不动
- `queryTaskList` / `cancelTask` 协议不变
- cancel 按钮 stopPropagation 行为保留
- sort 规则不变（running 在前，按 created_at 倒序）
- 空态文案 / 行为不变
- `Conversation` 组件的渲染逻辑不动（tool block 流仍复用 Conversation 渲染）

## 6. 不做（明确范围）

- 不重做 `Conversation` 内部 tool block 样式（沿用现有，沿用 list 同 status 色带但样式不改）
- 不动 TaskBlock 组件（Chat 流里的 fork/cancel/poll 块）
- 不引入图标库（继续用内联 SVG，cancel ✕ / refresh / back arrow 都 svg）
- 不改 ws 协议 / 事件流
- 不动 store
- 不重新设计 detail 页的事件流渲染（tool block 流沿用 `Conversation` 组件，不另写 timeline）