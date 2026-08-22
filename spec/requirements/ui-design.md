# ui-design: MonoDesk 界面设计

> 目标：极简分割、类 CodeX 排版；极简但不简陋。本文件是 UI 的权威说明，`preview/index.html` 是它的可执行版本。

## 1. 布局：极简分割

```
┌──────┬──────────────────────────────────────────┬────────────┐
│ rail │  conversation（居中，max-width ~760px）    │  monitor   │
│ 52px │   ┌ user ─────────────────────────┐      │ (可折叠)    │
│      │   ┌ reasoning ▸ thinking ────────┐│      │  status    │
│      │   ┌ ● bash · ls · 214ms ─────────┐│      │  TTFT      │
│      │   ┌ streaming assistant ▍ ───────┐│      │  tokens/s  │
│      │   ...                                 │  steps     │
│      │   [ composer ────────────────────── ] │            │
│      └────────────────────────────────────────┴────────────┘
│                 [ status bar: ●connected · model · session ]  │
```

- **rail**：极窄图标栏（会话 / 历史 / 记忆 / 设置），无文字，悬停有 tooltip。
- **conversation**：唯一滚动区。左对齐、单列、max-width 居中，留白是界面的一部分。
- **monitor**：右栏遥测（TTFT / tokens/s / step 时间线），可整体折叠。默认收起，点开才看细节。
- **status bar**：连接状态 + model + session，一条灰线。

## 2. 排版

单色为主，**颜色只给「状态」**（这是「极简不简陋」的关键）。

| 变量 | 用途 |
|---|---|
| 正文（sans） | 助手回复、用户消息正文，`system-ui` 栈 |
| 等宽（mono） | 工具名/参数/stdout、代码、指标数字，`ui-monospace/SF Mono/JetBrains Mono` |
| `--text` / `--text-muted` / `--text-faint` | 三级灰阶，建立层次 |
| `--accent`（单一色） | 光标、聚焦、活动态、链接 —— 全 app 只此一色 |
| 状态色 | `thinking=amber` `tooling=blue` `ok=green` `error=red`，**只出现在状态 pill / 状态图标上** |

- 助手正文用 sans（可读性），代码/工具用 mono（终端感）—— 类 CodeX 的排版分层。
- 字号 14px 正文 / 13px 等宽 / 11px 标签，行高 1.6。

## 3. agent monitor 元素

这些是「看 agent 干活」的核心，各自是独立的可折叠块，内联在 conversation 流里。

### 3.1 reasoning（`ReasoningChunk` → `reasoning`）

```
┌ (collapsed) ──────────────────────────────┐
│ ▸ thinking · 1.2s · 240 chars             │   ← 收起的默认形态
└────────────────────────────────────────────┘
┌ (expanded) ───────────────────────────────┐
│ ▾ thinking · 1.2s                         │
│ ┃ 让我先看 core/channel/base.py 的协议……   │   ← amber 左边线 + 斜体灰字，实时流式
└────────────────────────────────────────────┘
```

- 收到 `reasoning` 就新建；**流式累积**，斜体 `--text-muted`。
- 收到下一个非 `reasoning` 事件 → 自动收起成一行摘要（时长 + 字数）。
- 状态色 amber，但只用一根 2px 左边线 + 小圆点，不上整块底色。

### 3.2 tool call（`tool_start` → `tool_end`）

```
┌ ───────────────────────────────────────────┐
│ ● bash · ls extensions/channels · 214ms    │   ← header：spinner→✓，名字+参数+计时
│   $ ls extensions/channels                  │   ← body：mono，stdout 截断 + 懒展开
│   monodesk.py  feishu.py  terminal.py       │
│   ✓ exit 0                                  │   ← 结果徽标：0=green ✓，非 0=red ✕
└─────────────────────────────────────────────┘
```

- `tool_start`：挂骨架，header 显示 name + 参数摘要（mono，截断），右侧计时器从 0 往上走（spinner 态）。
- `tool_end`：回填 stdout（mono，超 2000 字符截断 + 「展开 N more」），
  `stderr` 黄字，`exit_code` 徽标，计时定格为 `latency_ms`。
- 状态色 blue，2px 左边线；执行中圆点脉动，结束变静态 ✓/✕。

### 3.3 metric / status（`metric` / `status`）

- `status`：只更新两处 —— 顶栏状态 pill + 流里一条极淡的分隔（`⟫ tooling`）。
- `metric`：tool 块下一条极淡 footnote：`step 2 · 812ms · 143 tok · 1 tool`（`--text-faint` mono）。

### 3.4 streaming assistant（`token` → `token`）

- 打字机：正文尾部跟一个 `▍` 块光标（accent 色，blink）。
- 收 `final` 时冻结：移除光标、定格 metrics、状态回 `wait_io`。

## 4. 流式渲染管线（流畅度的根）

**核心原则：token 每帧只写一个文本节点，绝不每 token 触发 React 重渲染。**

```
WS 帧 → parse → token buffer（纯 append，O(1)）
            → requestAnimationFrame 合并（一帧最多渲染一次）
            → 直接更新文本节点 / 光标位置
```

- 参考 MonoX `AssistantMessage.call_after_refresh`：把 N 个 token 合并到一帧 ~60fps。
- markdown 全量 reparse 也要节流（一帧一次），大段输出可降频到 30fps。
- 这条管线是 `src/stream/` 独立模块，React 只负责挂载容器，不参与 token 路径。

## 5. 遥测（monitor 栏）

| 项 | 来源事件 | 说明 |
|---|---|---|
| TTFT | 首次 `token` − `user_input` 发送时刻 | 大字显示，最关注的指标 |
| tokens/s | `token` 累计 / 时间 | 滚动速率 |
| step latency | `metric` | 每步耗时 |
| tokens in/out | `metric.tokens` | prompt / completion |

## 6. 主题

- 亮色为主（CodeX 观感），带暗色切换（`data-theme` + CSS 变量）。
- 状态色在暗色下做亮度补偿，保持可读。
