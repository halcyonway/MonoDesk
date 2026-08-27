// 与 MonoX extensions/channels/monodesk.py 对齐的 WS 协议类型。
// 信封 { v, type, seq, ts, data }，字段严格对应 events.py。

export type StatusState =
  | "thinking"
  | "tooling"
  | "compressing"
  | "wait_io"
  | "idle"
  | "error";

export interface ToolResultData {
  call_id: string;
  status: "ok" | "error" | "timeout" | "cancelled";
  stdout: string;
  stderr: string;
  exit_code: number;
  artifacts?: { name: string; mime: string; content: string }[];
  truncated: boolean;
  budget_id: string | null;
}

// 可观测性：Run / Turn / Span 节点，对应 MonoX core/observability/types.py 的 dict 形态。
export interface TraceSpan {
  span_id: string;
  parent_id: string | null;
  kind: "reasoning" | "act" | "compress";
  name: string;
  start_ts: number;
  end_ts: number | null;
  status: "ok" | "error" | "cancelled";
  attributes: Record<string, any>;
}

export interface TraceTurn {
  turn_id: string;
  turn_idx: number;
  spans: TraceSpan[];
}

export interface TraceRun {
  run_id: string;
  session_key: string;
  user_text: string;
  final_text: string | null;
  start_ts: number;
  end_ts: number | null;
  status: "running" | "ok" | "error" | "cancelled";
  turns: TraceTurn[];
}

export interface TraceRunSummary {
  run_id: string;
  session_key: string;
  user_text: string;
  start_ts: number;
  end_ts: number | null;
  status: string;
  turn_count: number;
}

export interface Envelope<T = Record<string, unknown>> {
  v: number;
  type: string;
  seq: number;
  ts: number;
  data: T;
}

// 出站事件（MonoX → MonoDesk）
// 可选字段 trace_id / turn_id 透传 MonoX 的可观测性 ID（additive，向后兼容）。
//
// 每个出站 event 的 data 都带 session_key（来自 MonoX RuntimeServer._outbound_consumer）——
// 客户端用它把事件路由到正确的 sessionStates Map entry，避免「A 的 late event 写到 B 的视图」
// 这类跨 session 污染。hello.data.session_key 是 MonoX 的 default_session_key，
// 仅作为参考；实际活跃会话由 MonoDesk 本地管理（用户切会话时改）。
export type MonoDeskEvent =
  | { type: "hello"; data: { session_key: string; model: string; providers?: string[]; model_provider?: string } }
  | { type: "status"; data: { session_key: string; state: StatusState; trace_id?: string; turn_id?: string } }
  | { type: "token"; data: { session_key: string; text: string } }
  | { type: "reasoning"; data: { session_key: string; text: string } }
  | { type: "tool_pending"; data: { session_key: string; call_id: string; name: string; tool_index: number; args_so_far: string } }
  | { type: "tool_start"; data: { session_key: string; name: string; args: Record<string, unknown>; call_id?: string } }
  | { type: "tool_end"; data: { session_key: string; name: string; latency_ms: number; result: ToolResultData } }
  | { type: "metric"; data: { session_key: string; metrics: Record<string, any>; trace_id?: string; turn_id?: string; model?: string } }
  | { type: "final"; data: { session_key: string; text: string; metrics: Record<string, any>; trace_id?: string } }
  | { type: "card"; data: { session_key: string; data: Record<string, any> } }
  | { type: "error"; data: { session_key: string; code: string; msg: string; retryable: boolean } };

// 入站事件（MonoDesk → MonoX）
export type InboundMessage =
  | { type: "user_input"; data: { text: string; session_key?: string; attachments?: Attachment[]; meta?: Record<string, unknown> } }
  | { type: "interrupt"; data: Record<string, never> }
  | { type: "command"; data: { text: string } };

export interface Attachment {
  url: string;      // absolute HTTP URL pointing at MonoX's debug server (e.g. http://127.0.0.1:8768/debug/attachments/<uuid>.png) — backend serves the bytes for both <img> rendering and multimodalunderstand tool
  name: string;     // original filename
  mime: string;     // MIME type, e.g. "image/png"
}
