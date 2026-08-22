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
│  LoopEngine ──StreamEvent──► MultiChannelGateway ──► MonoDeskChannel│
│                                                    (WS server)     │
│       ▲ InboundEvent ◄────────────────────────────────┘            │
└──────────────────────────────────────────────┬─────────────────────┘
                                               │ WebSocket (JSON/NDJSON)
┌──────────────────────────────────────────────▼─────────────────────┐
│                    MonoDesk（Tauri + TypeScript）                   │
│  ws-client ──► event bus ──► renderer（token buffer → rAF 合并）     │
│                              └─► React 组件（conversation/monitor） │
└─────────────────────────────────────────────────────────────────────┘
```

- **MonoX 侧**：`extensions/channels/monodesk.py`，实现 `Channel`，开一个本地 WS 端口。
  进 `config.toml`：`[[channels]] kind = "monodesk"`。
- **MonoDesk 侧**：Tauri 桌面壳 + React 前端。WS 客户端把事件投到一个事件总线，
  渲染层独立于 React，负责流式合并与打字机效果。

依赖方向强制：MonoDesk 只依赖 MonoX 的**协议**（events.py 的字段），不依赖实现。

---

## 3. 语言选型：TypeScript

结论：**TypeScript（前端）+ Tauri v2（桌面壳，Rust 只做窗口）**。

| 方案 | 流式排版/打字机 | 冷启动(TTFT 感知) | 富文本/markdown | 二进制 | 结论 |
|---|---|---|---|---|---|
| Electron + TS | ★★★★ | 慢(1–2s) | 好 | ~150MB | 能用，重 |
| **Tauri v2 + TS** | ★★★★ | **快(<300ms)** | 好 | ~8MB | **推荐** |
| SwiftUI 原生 | ★★(富文本难) | 快 | 差 | 原生 | 单平台 |
| Rust egui/iced | ★(流式富文本极难) | 快 | 差 | 小 | 不推荐 |

理由：

1. **流式打字机 / markdown / 代码高亮**是 web 技术的绝对主场，TS 生态最全。
2. 你要长期打磨 **TTFT 与流畅度**，需要精确控制渲染管线（`requestAnimationFrame` 合并、
   直接操作文本节点），web 平台把这件事做到最细粒度。
3. Tauri 只把 Rust 当「窗口 + 原生能力」壳，逻辑全在 TS，起步快、二进制小、冷启动快，
   冷启动本身就是 TTFT 感知的一部分。
4. 前端框架选 **React + TypeScript + Tailwind**（生态最稳、组件最全），
   但**流式渲染层不依赖 React 重渲染**（见 `ui-design.md`），token 每帧只写一个文本节点。

> 为什么不是纯 Electron：功能一样，但 150MB + 1–2s 冷启动与「流畅度」目标相悖。
> 为什么不用原生 SwiftUI：跨平台 + 富文本流式渲染成本高，迭代慢。

---

## 4. 目录结构（目标形态）

```
MonoDesk/
├── src/
│   ├── ws/            # WS client + 协议编解码（对齐 events.py）
│   ├── stream/        # token buffer → rAF 合并 → 文本节点（核心资产，与 React 解耦）
│   ├── ui/            # React 组件：conversation / monitor / composer / rail
│   └── store/         # 会话状态、metrics、theme
├── src-tauri/         # Tauri 壳（窗口、托盘、自动连本地 MonoX）
├── spec/              # 本文档
└── preview/index.html # 无构建高保真 mockup
```

v0 只有 `spec/` + `preview/`，用于先定 UI 与协议观感。
