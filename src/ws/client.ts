import type { Envelope, InboundMessage, MonoDeskEvent } from "./protocol";
import { CHANNEL_NAME, DEFAULT_SESSION_KEY } from "../store/sessions";

export interface WsOptions {
  onEvent: (ev: MonoDeskEvent) => void;
  onConnectionChange?: (open: boolean) => void;
}

const BACKOFF_BASE = 1000;
const BACKOFF_MAX = 8000;

// WebSocket 客户端：解析 NDJSON 信封，断线指数退避重连。
export class MonoDeskWS {
  private ws: WebSocket | null = null;
  private url: string;
  private opts: WsOptions;
  private reconnectDelay = BACKOFF_BASE;
  private shouldReconnect = true;

  constructor(url: string, opts: WsOptions) {
    this.url = url;
    this.opts = opts;
  }

  // HMR 重新挂载时替换 callback（保留底层 socket 不动，避免反复 close/open）
  rebind(opts: WsOptions) {
    this.opts = opts;
  }

  connect() {
    this.shouldReconnect = true;
    this.open();
  }

  private open() {
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectDelay = BACKOFF_BASE;
      this.sendHello();
      this.opts.onConnectionChange?.(true);
    };
    ws.onmessage = (msg) => {
      try {
        const frame = JSON.parse(msg.data) as Envelope;
        this.opts.onEvent({ type: frame.type, data: frame.data } as MonoDeskEvent);
      } catch {
        // 忽略无法解析的帧
      }
    };
    ws.onclose = () => {
      this.opts.onConnectionChange?.(false);
      if (this.shouldReconnect) {
        const d = this.reconnectDelay;
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, BACKOFF_MAX);
        setTimeout(() => this.open(), d);
      }
    };
    ws.onerror = () => {
      // onclose 会接着触发，统一在那里处理
    };
  }

  // 连接建立后先发 hello，声明自己是 monodesk channel（Runtime 按 source 索引连接）。
  // subscribe_async_tasks=true：订阅 async_task_* 全局帧（additive，老 Runtime 忽略）。
  private sendHello() {
    this.ws?.send(
      JSON.stringify({
        v: 1,
        type: "hello",
        seq: 0,
        ts: Date.now() / 1000,
        data: {
          session_key: DEFAULT_SESSION_KEY,
          source: CHANNEL_NAME,
          subscribe_async_tasks: true,
        },
      })
    );
  }

  // ---- async task（对应 MonoX spec/requirements/async-task.md 的 2 个 inbound） ----

  cancelTask(taskId: string) {
    this.send({
      type: "async_task_cancel",
      data: { task_id: taskId, reason: "user" },
    });
  }

  queryTaskList(filter?: { status?: string[] }, sessionKey?: string) {
    this.send({
      type: "async_task_list_query",
      data: {
        session_key: sessionKey ?? DEFAULT_SESSION_KEY,
        filter: filter ?? null,
      },
    });
  }

  send(msg: InboundMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(
        JSON.stringify({
          v: 1,
          type: msg.type,
          seq: 0,
          ts: Date.now() / 1000,
          data: msg.data,
        })
      );
    }
  }

  close() {
    this.shouldReconnect = false;
    this.ws?.close();
  }

  // 手动重连：丢弃旧 socket（摘掉 onclose 避免它再触发退避重连），立即建新连接。
  reconnect() {
    const old = this.ws;
    this.ws = null;
    if (old) {
      old.onclose = null;
      old.close();
    }
    this.shouldReconnect = true;
    this.reconnectDelay = BACKOFF_BASE;
    this.open();
  }
}
