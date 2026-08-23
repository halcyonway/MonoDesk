# ui-design: MonoDesk 界面设计

> 目标：极简分割、类 CodeX 排版；极简但不简陋。本文件是 UI 的权威说明，`src/components/*` 是它的实现。

## 1. 布局：左 session + 中 conversation + 底 statusbar

```
┌──────────────┬──────────────────────────────────────────────────────┐
│ sessions     │   conversation（居中，max-width ~760px）               │
│              │     ┌ user ─────────────────────────────────┐       │
│  ● default   │     ┌ reasoning ▾ thinking · 22 chars ──────┐│       │
│  ○ refactor  │     ┌ ● bash · ls · 214ms ──────────────────┐│       │
│  ○ review    │     ┌ streaming assistant ▍ ────────────────┐│       │
│              │     ...                                          │       │
│  [+ new]     │                                                  │       │
│              │                                                  │       │
│              │     ┌ composer ────────────────────────────────┐ │       │
│              │     └───────────────────────────────────────────┘ │       │
├──────────────┴──────────────────────────────────────────────────────┤
│ ●connected · MiniMax-M2.7    ·    TTFT 312ms · 18 tok/s · 1.4s    │
└────────────────────────────────────────────────────────────────────┘
```

- **session list**（左栏，220px）：多 session 切换。新建会话（`+` 按钮）+ 删除（hover 显示 ✕）。
  主会话（`default`）不可删。
- **conversation**：唯一滚动区。左对齐、单列、max-width 居中，留白是界面的一部分。
- **composer**：底部输入框。圆角 + 浅阴影；focus 时 accent 边 + soft 光晕。Footer 显示
  模型 + 运行状态 + elapsed。
- **status bar**：连接状态 + model + TTFT / tokens/s / total / prompt·completion
  一条灰线。

> 早期版本的右侧 `monitor` 栏（296px，可折叠）已被合并到 statusbar（紧凑一行），
> 详见 `OVERVIEW.md` §5 v2 阶段。理由：少一个面板 = 少一次注意力跳转，TTFT/tok/s
> 这种高频指标放最底更顺手。

## 2. 排版

单色为主，**颜色只给「状态」**（这是「极简不简陋」的关键）。

| 变量 | 用途 |
|---|---|
| 正文（sans） | 助手回复、用户消息正文，`system-ui` 栈 |
| 等宽（mono） | 工具名/参数/stdout、代码、指标数字，`ui-monospace/SF Mono/JetBrains Mono` |
| `--text` / `--text-muted` / `--text-faint` | 三级灰阶，建立层次 |
| `--accent`（单一色） | 光标、聚焦、活动态、链接、用户气泡 —— 全 app 只此一色 |
| 状态色 | `thinking=amber` `tooling=blue` `ok=green` `error=red`，**只出现在状态 pill / 状态图标上** |

- 助手正文用 sans（可读性），代码/工具用 mono（终端感）—— 类 CodeX 的排版分层。
- 字号 14px 正文 / 13px 等宽 / 11px 标签，行高 1.6。

## 3. agent 流元素（内联在 conversation 流里）

这些是「看 agent 干活」的核心，各自是独立的可折叠块。

### 3.1 reasoning（`ReasoningChunk` → `reasoning`）

```
┌ (collapsed) ──────────────────────────────┐
│ ● THINKING · 22 chars                   ▾  │   ← 收起 / 展开 toggle
└────────────────────────────────────────────┘
┌ (expanded) ───────────────────────────────┐
│ ● THINKING · 1.2s                         ▾ │
│ ┃ 让我先看 core/channel/base.py 的协议……   │   ← amber 左边线 + 斜体灰字，实时流式
└────────────────────────────────────────────┘
```

- 收到 `reasoning` 就新建；**流式累积**，斜体 `--text-muted`。
- 下一个非 `reasoning` 事件到达 → 自动收起成一行摘要（字数 + 时长）。
- 状态色 amber，但只用一根 2px 左边线 + 小圆点，不上整块底色。
- **稳定性保证**（修过 bug）：用 child 的稳定 `id` 绑定 React ref，而不是依赖 React 生命周期内的
 临时 DOM 引用。React 重渲染/卸载期间错位的 bind 会被忽略，避免出现「两个 thinking」。

### 3.2 tool call（`tool_start` → `tool_end`）

```
┌ ───────────────────────────────────────────┐
│ ● bash · ls extensions/channels · 214ms   ▾ │   ← header：name + 参数 + 计时
│   $ ls extensions/channels                  │   ← body：mono，stdout 截断 + 懒展开
│   monodesk.py  feishu.py  terminal.py       │
│   ✓ exit 0                                  │
└────────────────────────────────────────────┘
```

- `tool_start`：挂骨架，header 显示 name + 参数摘要（mono，截断），右侧计时器从 0 往上走（spinner 态）。
- `tool_end`：回填 stdout（mono，超 2000 字符截断 + 「展开 N more」），
  `stderr` 黄字，`exit_code` 徽标，计时定格为 `latency_ms`。
- 状态色 blue，2px 左边线；执行中圆点脉动，结束变静态 ✓/✕。
- done 时**自动折叠**，节省纵向空间（用户可点 head 重新展开）。

### 3.3 metric / status（`metric` / `status`）

- `status`：驱动 composer footer 的状态文字（`thinking` / `tooling` / `compressing`）+ 脉动圆点。
- `metric`：tool 块下一条极淡 footnote：`step 2 · 812ms · 143 tok · 1 tool`（`--text-faint` mono）。

### 3.4 streaming assistant（`token` → `token`）

- 打字机：正文尾部跟一个 `▍` 块光标（accent 色，blink）。
- 收 `final` 时冻结：移除光标、定格 metrics、状态回 `wait_io`。

## 4. 流式渲染管线（流畅度的根）

**核心原则：token 每帧只写一个文本节点，绝不每 token 触发 React 重渲染。**

```
WS 帧 → parse → token 字符入 jitter buffer（O(1) per char）
            → 30fps tick（setTimeout 33ms）合并
              → 解锁 CHARS_PER_TICK 个字符进 paintedBuf
                → DOM 增量写：每个新字符一个 <span class="ch fresh">
                   CSS animation opacity 0→1, blur 0, translateX 0 → 3
            → 动画结束（180ms）后合并为文本节点，释放 DOM 节点
```

### 4.1 Jitter Buffer（v0.2+ 引入）

按 WebRTC JB 风格设计：

- **接收端拆字**：每个字符打 arriveAt 时间戳入队（队列：`{ ch, arriveAt }[]`）
- **虚拟播放头**：以首次 token 时间为锚，按 ~90cps 匀速推进
- **TARGET_BUFFER_MS = 120**：希望维持的缓冲积压（够吞掉模型突发）
- **MAX_BUFFER_MS = 1500**：积压过大时强制追平（不让 JB 把播放延迟越拖越久）
- **CHARS_PER_TICK = 3 @ 33ms tick** ≈ 90 cps（中英文混合时的经验值）

效果：模型突发产出 N 个字符不会瞬间「砸」到 UI，而是按 9 字/秒稳定铺开；
模型慢的时候也不会出现「停 1 秒突然蹦 5 个字」的卡顿感。

### 4.2 单字淡入（豆包风格）

每个刚解锁的字符被包成 `<span class="ch fresh">`：

```css
.stream .ch.fresh {
  display: inline-block;
  opacity: 0;
  filter: blur(2px);
  transform: translateX(-3px);
  animation: ch-fade-in 180ms ease-out forwards;
}
@keyframes ch-fade-in { to { opacity: 1; filter: blur(0); transform: translateX(0); } }
```

180ms 后 `animationend` 触发 span → 文本节点合并（`consolidateFreshSpans`），
避免 span 数量无限增长。

### 4.3 流尾 mask（不是行遮罩）

```css
.stream.streaming {
  -webkit-mask-image: linear-gradient(to bottom, #000 96%, transparent 100%);
  mask-image: linear-gradient(to bottom, #000 96%, transparent 100%);
}
```

注意 96%：mask 只盖住最后 4%，**不会遮住一行**。早期版本是 82% 导致「笑话3：」这种末尾行
完全看不见，已修。

### 4.4 scroll 自动锚定 + 留白

`Conversation.tsx` 的滚动策略：

- **内容不足一屏** → `scrollTop = 0`（不滚），最后一条消息停在视口偏上，下方自然留白给 composer。
  这就是豆包效果。
- **内容溢出** → 滚到底 + 多留 140px（composer 高度 + 一行呼吸），最后一条不被 composer 压住。

## 5. 遥测（statusbar 一行）

| 项 | 来源事件 | 说明 |
|---|---|---|
| TTFT | 首次 `token` − `user_input` 发送时刻 | 第一位 token 的延迟，最关注的指标 |
| tokens/s | `token` 累计 / 时间 | 滚动速率 |
| total | `final` − `user_input` | turn 总时长 |
| prompt / completion | `metric.tokens` | 累计入 / 出 token |

完整指标在 `[llm.metric]` 里。MonoDesk 只显示 4 个最关键的；更多细节走 Runtime 的 debug mode。

## 6. 主题

- 亮色为主（CodeX 观感），带暗色切换（`data-theme="dark"` + CSS 变量）。
- 状态色在暗色下做亮度补偿，保持可读。
- 切换按钮在 TopBar 右角（太阳 / 月亮 SVG）。

## 7. 多 session（v0.3+）

- session list 在左栏，每个 session 一个 `session_key`（`default` 或 `monodesk:<uuid>`）。
- 每 session 一份独立 history，存在 `localStorage`（`monodesk:histories`）。
- 切换 session 时**不打断**正在跑的 agent —— 后台 session 的 token 仍写回它自己的 history，
  前台只是切到看另一份（用 `streamKeyRef` 路由 setMsgs 到正确的 key）。
- 主会话（`default`）不可删；最多 `MAX_SESSIONS` 个。

## 8. IME + 中文输入（v0.3+ 修过）

macOS 中文输入法下「按 Enter 应该是确认候选字母而非发送」：

- `onCompositionStart/End` 维护 `composingRef`
- `onKeyDown` 检查 `composingRef.current` + `nativeEvent.isComposing` + `keyCode === 229` + `key === "Process"`
- 任一命中 → return，不 preventDefault，让 IME 正常处理 Enter

## 9. WS 重连（HMR 优化，v0.3+）

dev 模式下 Vite HMR 会卸载组件树 → `useEffect` cleanup 关闭 ws → 立即重新挂载建新 ws，
后端会看到「每 ~1 秒 connection open」刷屏。

修复：`App.tsx` 在 dev 模式下把 ws 实例挂在 `window.__monodeskWs`，跨 HMR 复用，
加 `rebind()` 方法替换 callback（engine / setConnected 引用变了也不重建 socket）。
prod 行为不变：组件卸载正常 close。