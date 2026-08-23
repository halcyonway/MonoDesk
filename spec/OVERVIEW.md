# MonoDesk 概览

MonoDesk 是 MonoX 的桌面端。MonoX 的架构原则是「系统 = 模块 + 协议」，
MonoDesk 完全遵循这条线：**它是 `Channel` 协议的一个实现 + 一层 WS 传输**，
不改 `core/`，不碰 `loop/`。

---

## 1. 与 MonoX 的关系

MonoX 已经把 channel 抽象得很干净：

```python
# core/channel/base.py
class Channel(Protocol):
    async def start(self) -> None: ...
    async def stop(self) -> None: ...
    def listen(self) -> AsyncIterator[InboundEvent]: ...   # 入站
    async def send(self, event: StreamEvent) -> None: ...   # 出站
```

`StreamEvent` 是 9 个 frozen dataclass 的 union：

| 事件 | 字段 | 含义 |
|---|---|---|
| `TokenChunk` | `text` | 流式正文 token |
| `ReasoningChunk` | `text` | LLM 内部推理（o1/R1） |
| `ToolStart` | `name, args` | 工具调用开始 |
| `ToolEnd` | `name, result, latency_ms` | 工具结果 |
| `StatusChange` | `state` | `thinking/tooling/compressing/wait_io/idle` |
| `MetricChunk` | `metrics` | `step_idx/latency_ms/tokens/tool_calls_count` |
| `FinalMessage` | `text, metrics` | 最终回复 + session 汇总 |
| `Card` | `data` | 结构化卡片 |
| `ErrorEvent` | `code, msg, retryable` | 错误 |

所以 MonoDesk 要做的只有两件事：

1. **把 `StreamEvent` 序列化成 JSON 帧**推给桌面端（出站）；
2. **把桌面端输入反序列化成 `InboundEvent`** 喂回 loop（入站）。

其余（ReAct 循环、工具执行、checkpoint、memory）全部是 MonoX 已有的。

---

## 2. 架构

```
┌────────────────────────── MonoX（Python）──────────────────────────┐
│  LoopEngine ──StreamEvent──► MultiChannelGateway                   │
│                                                    │               │
│  RuntimeServer ◄──InboundEvent──┘                  │               │
│       ▲                                           │               │
│       │ ws :8765 (JSON / NDJSON)                  │               │
└───────┼───────────────────────────────────────────┼───────────────┘
        │                                           │
        │                                           ▼
┌───────┴────────────────────────────────────────────────────────────┐
│                    MonoDesk（Tauri + TypeScript）                   │
│  ws-client ──► StreamEngine (jitter buffer + 单字淡入)              │
│                       │                                            │
│                       ├─► DOM 直写（token / reasoning / 光标）       │
│                       └─► React 状态（结构块：turn / tool / metric）│
└────────────────────────────────────────────────────────────────────┘
```

- **MonoX 侧**：MonoDesk 在 MonoX 进程里没有独立 adapter —— RuntimeServer 监听 :8765，
  MonoDesk 通过标准 ws client 直接连。具体 channel（terminal / feishu / textual）作为独立进程
  共享同一个 Runtime；MonoDesk 是桌面 UI，独立走 ws。
- **MonoDesk 侧**：Tauri 桌面壳 + React 前端。WS 客户端把帧投到 `StreamEngine`，渲染层独立于 React，
  负责 jitter buffer + 单字淡入 + DOM 直写。

依赖方向强制：MonoDesk 只依赖 MonoX 的**协议**（events.py 的字段），不依赖实现。

---

## 3. 语言选型：TypeScript

结论：**TypeScript（前端）+ Tauri v2（桌面壳，Rust 只做窗口）**。

| 方案 | 流式排版/打字机 | 冷启动(TTFT 感知) | 富文本/markdown | 二进制 | 结论 |
|---|---|---|---|---|---|
| Electron + TS | ★★★★ | 慢(1–2s) | 好 | ~150MB | 能用，重 |
| **Tauri v2 + TS** | ★★★★ | **快(<300ms)** | 好 | ~8MB | **采用** |
| SwiftUI 原生 | ★★(富文本难) | 快 | 差 | 原生 | 单平台 |
| Rust egui/iced | ★(流式富文本极难) | 快 | 差 | 小 | 不推荐 |

理由：

1. **流式打字机 / markdown / 代码高亮**是 web 技术的绝对主场，TS 生态最全。
2. 你要长期打磨 **TTFT 与流畅度**，需要精确控制渲染管线（固定 30fps tick + 直接操作文本节点），
   web 平台把这件事做到最细粒度。
3. Tauri 只把 Rust 当「窗口 + 原生能力」壳，逻辑全在 TS，起步快、二进制小、冷启动快，
   冷启动本身就是 TTFT 感知的一部分。
4. 前端框架选 **React + TypeScript**，但**流式渲染层不依赖 React 重渲染**（见 `ui-design.md` §4），
   token 每帧只写一个文本节点。

> 为什么不是纯 Electron：功能一样，但 150MB + 1–2s 冷启动与「流畅度」目标相悖。
> 为什么不用原生 SwiftUI：跨平台 + 富文本流式渲染成本高，迭代慢。

---

## 4. 目录结构（当前形态）

```
MonoDesk/
├── src/
│   ├── ws/                # WS client + 协议编解码（对齐 events.py）
│   ├── stream/            # StreamEngine：jitter buffer + 单字淡入（核心资产，与 React 解耦）
│   │   ├── engine.ts        #   状态机 + token/reasoning/tool 累积 + 渲染调度
│   │   └── markdown.ts      #   markdown / table / codeblock / escape
│   ├── components/        # React 组件（结构块）
│   │   ├── Chrome.tsx       #   TopBar + SessionList
│   │   ├── Conversation.tsx #   TextStream / ReasonBlock / ToolBlock / MsgView
│   │   └── Composer.tsx     #   输入框 + IME
│   ├── store/             # 本地持久化（localStorage：会话列表 + 每会话历史）
│   ├── App.tsx            # 装配 + WS 生命周期（HMR 保留 socket 实例）
│   ├── main.tsx
│   └── styles.css         # 单文件 CSS（CSS 变量 + 主题）
├── src-tauri/             # Tauri 壳（窗口、托盘、原生能力）
├── spec/                  # 本文档
└── preview/index.html     # v0 时期的纯 HTML mockup（保留参考，已不再是权威）
```

> `spec/OVERVIEW.md` 是设计文档，`src/` 是当前实现；目录偶有偏离时以 `src/` 为准。

---

## 5. 当前进度

| 阶段 | 内容 | 状态 |
|---|---|---|
| v0 | 纯 HTML mockup | ✅ 完成（`preview/` 保留） |
| v1 | MonoX Runtime ws server + MonoDesk Tauri/React 真客户端 | ✅ 端到端打通 |
| v2 | 流畅度仪表（TTFT / tok/s 实时显示）+ jitter buffer + 单字淡入 | ✅ 基础完成（侧栏 monitor 已移除，metrics 内联到 statusbar） |
| v3 | 多 session 隔离 + 历史持久化 + 跨会话上下文 | ✅ 完成（`store/sessions.ts`） |

详细 UI 决策见 `spec/requirements/ui-design.md`。