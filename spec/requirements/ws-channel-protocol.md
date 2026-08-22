# ws-channel-protocol: MonoDesk 通信协议

> 目标：把 MonoX 的 `StreamEvent`（出站）与 `InboundEvent`（入站）无损映射到一条 WebSocket 上。

## 1. 传输选型：WebSocket

| 方案 | 双向 | 低延迟流式 | 结论 |
|---|---|---|---|
| **WebSocket** | ✅ 全双工 | ✅ 单 socket 收发 | **采用** |
| SSE + HTTP POST | ⚠️ 半双工(需两条路) | 输入要多一次 POST | 复杂，TTFT 更差 |
| HTTP 轮询 | ✅ | ❌ 延迟大 | 不采用 |

飞书 channel 已经用 WebSocket 入站，说明 WS 是 MonoX 的惯用传输。MonoDesk 本地单用户，
WS 一条连接同时承载「入站输入 + 出站事件流」最简单、TTFT 最低。

## 2. 帧格式：一行一个 JSON 事件

WebSocket 文本帧，每帧一个 JSON 对象（NDJSON 风格，天然对齐 checkpoint 的 JSONL 习惯）。
一个 turn 的事件顺序即 socket 上的帧顺序。

统一信封：

```json
{ "v": 1, "type": "token", "seq": 3, "ts": 1732000000.123, "data": { ... } }
```

| 字段 | 说明 |
|---|---|
| `v` | 协议版本 |
| `type` | 事件类型（见下表） |
| `seq` | 单调递增序号，per-session，用于重连断点续传（v2） |
| `ts` | Unix 时间戳（秒，浮点，毫秒精度） |
| `data` | 事件载荷，字段严格对齐 `events.py` |

## 3. 出站事件（MonoX → MonoDesk）

直接映射 `StreamEvent` union 的 9 个类型，外加 `hello`：

| `type` | 来源 dataclass | `data` 字段 |
|---|---|---|
| `hello` | (握手) | `session_key, model, system` |
| `status` | `StatusChange` | `state` |
| `token` | `TokenChunk` | `text` |
| `reasoning` | `ReasoningChunk` | `text` |
| `tool_start` | `ToolStart` | `name, args` |
| `tool_end` | `ToolEnd` | `name, latency_ms, result` |
| `metric` | `MetricChunk` | `metrics` |
| `final` | `FinalMessage` | `text, metrics` |
| `card` | `Card` | `data` |
| `error` | `ErrorEvent` | `code, msg, retryable` |

示例：

```json
{"v":1,"type":"hello","seq":0,"ts":1732000000.0,"data":{"session_key":"default","model":"gpt-4"}}
{"v":1,"type":"status","seq":1,"ts":1732000000.0,"data":{"state":"thinking"}}
{"v":1,"type":"reasoning","seq":2,"ts":1732000000.1,"data":{"text":"让我先看 core/channel/base.py 的 Channel 协议……"}}
{"v":1,"type":"token","seq":3,"ts":1732000000.2,"data":{"text":"好的"}}
{"v":1,"type":"tool_start","seq":4,"ts":1732000000.3,"data":{"name":"bash","args":{"command":"ls extensions/channels"}}}
{"v":1,"type":"tool_end","seq":5,"ts":1732000000.5,"data":{
  "name":"bash","latency_ms":214,
  "result":{"call_id":"call_1","status":"ok","stdout":"monodesk.py\nfeishu.py\nterminal.py\n","stderr":"","exit_code":0,"truncated":false,"budget_id":null}
}}
{"v":1,"type":"metric","seq":6,"ts":1732000000.6,"data":{"step_idx":1,"latency_ms":812,"tokens":{"prompt_tokens":1200,"completion_tokens":340},"tool_calls_count":1}}
{"v":1,"type":"final","seq":7,"ts":1732000000.7,"data":{"text":"……","metrics":{"steps":1,"total_latency_ms":812,"total_tool_calls":1}}}
{"v":1,"type":"status","seq":8,"ts":1732000000.7,"data":{"state":"wait_io"}}
{"v":1,"type":"error","seq":9,"ts":1732000000.9,"data":{"code":"llm_timeout","msg":"request timeout","retryable":true}}
```

### `tool_end.result` 子 schema（对齐 `ToolResult`）

```json
{
  "call_id": "string",
  "status": "ok | error | timeout | cancelled",
  "stdout": "string",
  "stderr": "string",
  "exit_code": 0,
  "artifacts": [ { "name": "string", "content": "…", "mime": "…" } ],
  "truncated": false,
  "budget_id": null
}
```

### `status.state` 取值（对齐 `StatusChange`）

`thinking | tooling | compressing | wait_io | idle`

## 4. 入站事件（MonoDesk → MonoX）

映射回 `InboundEvent`：

| `type` | `data` 字段 | 映射 |
|---|---|---|
| `user_input` | `text, session_key, attachments` | `kind="message", event_type="user-input", source="monodesk"` |
| `interrupt` | `{}` | `kind="interrupt"` |
| `command` | `text` | `kind="command", event_type="command"` |

```json
{"v":1,"type":"user_input","data":{"text":"帮我在 MonoX 加一个 WS channel","session_key":"default","attachments":[]}}
{"v":1,"type":"command","data":{"text":"/debug on"}}
```

## 5. 时序（单个 turn 的典型帧序）

```
user_input ─►
   status(thinking) ─► reasoning* ─► token* ─► [status(tooling) ─► tool_start ─► tool_end]* ─►
   metric* ─► final ─► status(wait_io)
```

注意两点，UI 必须能正确处理：

1. **`reasoning` 与 `token` 会交错**：模型可能边想边说，UI 要在不同区块里分别累积，不能假设全在前。
2. **`tool_start`/`tool_end` 是配对的**：`tool_start` 挂骨架，`tool_end` 回填结果；工具可串行多个。

## 6. 重连与断点（v2 预留）

- 客户端记录 `seq`，重连后发 `{"type":"resume","data":{"last_seq":N}}`，服务端从 N 之后重放。
- v1 不做，先保证单连接完整。checkpoint 已保证历史可恢复，重连只需补当前 turn 的流。

## 7. 实现位置

- MonoX 侧：`extensions/channels/monodesk.py`（`Channel` 实现，WS server；沿用 feishu 的「同步 WS 跑独立线程」模型）。
- 配置：`[[channels]] kind = "monodesk"`，`[channels.monodesk] host/port`。
- MonoDesk 侧：`src/ws/` 编解码层 + 事件总线。

## 8. 风险

- WS 断线中 turn 仍在跑 → v1 接受丢中间帧（checkpoint 兜底），v2 做 resume。
- 大 `stdout` → `tool_end` 帧很大，UI 对 tool 输出做截断 + 懒展开（同 MonoX `_MAX_TOOL_OUTPUT_CHARS`）。
