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

export interface Envelope<T = Record<string, unknown>> {
  v: number;
  type: string;
  seq: number;
  ts: number;
  data: T;
}

// 出站事件（MonoX → MonoDesk）
export type MonoDeskEvent =
  | { type: "hello"; data: { session_key: string; model: string } }
  | { type: "status"; data: { state: StatusState } }
  | { type: "token"; data: { text: string } }
  | { type: "reasoning"; data: { text: string } }
  | { type: "tool_start"; data: { name: string; args: Record<string, unknown> } }
  | { type: "tool_end"; data: { name: string; latency_ms: number; result: ToolResultData } }
  | { type: "metric"; data: { metrics: Record<string, any> } }
  | { type: "final"; data: { text: string; metrics: Record<string, any> } }
  | { type: "card"; data: { data: Record<string, any> } }
  | { type: "error"; data: { code: string; msg: string; retryable: boolean } };

// 入站事件（MonoDesk → MonoX）
export type InboundMessage =
  | { type: "user_input"; data: { text: string; session_key?: string } }
  | { type: "interrupt"; data: Record<string, never> }
  | { type: "command"; data: { text: string } };
