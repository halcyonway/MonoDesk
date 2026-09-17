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
// v2 协议（schema_version=2）：kind 扩到 8 个；Run 多 spans[] 字段（bootstrap / loop /
// finalize）；attributes 走 OTel 风格扁平 key（gen_ai.* / tool.* / loop.* / error.*）。
export type SpanKind =
  | "bootstrap" | "loop" | "finalize"   // phase spans（每 run 固定各 1 个）
  | "turn"                              // logical container
  | "reasoning" | "act" | "compress" | "tool";  // work spans

export interface TraceSpan {
  span_id: string;
  parent_id: string | null;
  kind: SpanKind;
  name: string;
  start_ts: number;
  end_ts: number | null;
  status: "ok" | "error" | "cancelled";
  // OTel 风格扁平 attr：tool.call.arguments / tool.result 是 JSON 字符串；
  // 嵌套 dict 由 UI 端 JSON.parse 后渲染。
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
  // v2 协议：list 必带。v1 数据归档后不会出现
  schema_version: number;
  // run-level spans：bootstrap / loop / finalize
  spans: TraceSpan[];
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
  schema_version: number;
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
  | { type: "error"; data: { session_key: string; code: string; msg: string; retryable: boolean } }
  // ---- async task（wire 层专用帧，对应 MonoX wire_frames.ASYNC_TASK_OUTBOUND_TYPES） ----
  | { type: "async_task_created"; data: AsyncTaskCreatedData }
  | { type: "async_task_event"; data: AsyncTaskEventData }
  | { type: "async_task_status"; data: AsyncTaskStatusData }
  | { type: "async_task_list"; data: AsyncTaskListData }
  | { type: "async_task_snapshot"; data: AsyncTaskSnapshotData };

// 入站事件（MonoDesk → MonoX）
export type InboundMessage =
  | { type: "user_input"; data: { text: string; session_key?: string; attachments?: Attachment[]; meta?: Record<string, unknown> } }
  | { type: "interrupt"; data: { session_key: string } }
  | { type: "command"; data: { text: string } }
  | { type: "async_task_cancel"; data: { task_id: string; reason: "user" } }
  | { type: "async_task_list_query"; data: { session_key: string; filter: { status?: string[] } | null } };
  // 注：async_task_snapshot_query 是预留 type（MonoX spec 只声明 2 个 inbound），
  // Phase 3 详情页用 list + 推流即可满足；实装时两侧同步加。

// ---- async task 类型（与 MonoX spec/requirements/async-task.md 一字不差） ----

export type AsyncTaskStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "interrupted";

// interrupted 是 Runtime 重启时对 running task 补的终态，只出现在 list / snapshot
export type AsyncTaskLiveStatus = Exclude<AsyncTaskStatus, "pending" | "running" | "interrupted">;

export interface AsyncTaskSummary {
  task_id: string;
  kind: string;
  description: string;
  status: AsyncTaskStatus;
  parent_session_key: string;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  timeout_sec: number;
  meta: Record<string, unknown>;
  final_text: string | null;
  error: string | null;
}

export interface AsyncTaskCreatedData {
  session_key: string;          // 父 session_key（Chat 流 cross-link 用）
  task_id: string;
  kind: string;
  description: string;
  meta: Record<string, unknown>;
  parent_session_key: string;
  timeout_sec: number;
  created_at: number;
}

// child StreamEvent 的内嵌 payload：RuntimeServer 用 to_frame 序列化后剥掉信封，
// 只剩 {"type", "data"}——data 里 session_key 是 child 的 sk，客户端通常忽略。
export type AsyncTaskInnerEvent =
  | { type: "status"; data: { session_key?: string; state: StatusState; trace_id?: string; turn_id?: string } }
  | { type: "token"; data: { session_key?: string; text: string } }
  | { type: "reasoning"; data: { session_key?: string; text: string } }
  | { type: "tool_pending"; data: { session_key?: string; call_id: string; name: string; tool_index: number; args_so_far: string } }
  | { type: "tool_start"; data: { session_key?: string; name: string; args: Record<string, unknown>; call_id?: string } }
  | { type: "tool_end"; data: { session_key?: string; name: string; latency_ms: number; result: ToolResultData } }
  | { type: "metric"; data: { session_key?: string; metrics: Record<string, any>; trace_id?: string; turn_id?: string; model?: string } }
  | { type: "final"; data: { session_key?: string; text: string; metrics: Record<string, any>; trace_id?: string } }
  | { type: "card"; data: { session_key?: string; data: Record<string, any> } }
  | { type: "error"; data: { session_key?: string; code: string; msg: string; retryable: boolean } };

export interface AsyncTaskEventData {
  session_key: string;
  task_id: string;
  event: AsyncTaskInnerEvent;
}

export interface AsyncTaskStatusData {
  session_key: string;
  task_id: string;
  status: AsyncTaskLiveStatus;
  finished_at: number;
  duration_sec: number;
  final_text: string | null;
  error: string | null;
  cancel_reason: string | null;
}

export interface AsyncTaskListData {
  session_key: string;
  tasks: AsyncTaskSummary[];
}

export interface AsyncTaskSnapshotData {
  session_key: string;
  task: AsyncTaskSummary;
  recent_events: Array<Record<string, unknown>>;
}

export interface Attachment {
  path: string;     // absolute local path on disk (MonoX tmp dir) — Tauri desktop loads via convertFileSrc(path); tools (read_doc / multimodalunderstand) read directly
  name: string;     // original filename
  mime: string;     // MIME type, e.g. "image/png"
}
