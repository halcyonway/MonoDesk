// StreamEngine：MonoDesk 的流式渲染中枢。
//
// 核心原则（与 preview 一致）：token / reasoning 不做逐字 React setState，
// 而是 token 缓冲 + requestAnimationFrame 合并 → 直接写 DOM 文本节点，每帧最多一次重绘。
// React 只负责“结构性块”（turn / reasoning 开关 / tool 起止 / final / error / metric）。
//
// 结构性块用 key 稳定 + 组件浅 props 不变，React 跳过重渲染，因此引擎直接改的
// innerHTML / class 不会被打断。

import { CARET, esc, fmtMs, renderMarkdown, truncate } from "./markdown";
import type { MonoDeskEvent, StatusState, ToolResultData } from "../ws/protocol";

type Setter<T> = (v: T | ((prev: T) => T)) => void;

export type Child =
  | { id: string; kind: "reasoning" }
  | { id: string; kind: "text" }
  | {
      id: string;
      kind: "tool";
      name: string;
      args: string;
      state: "running" | "done";
      result?: ToolResultData;
      latencyMs?: number;
    }
  | { id: string; kind: "note"; text: string }
  | { id: string; kind: "error"; text: string };

export type Msg =
  | { id: string; role: "user"; text: string }
  | { id: string; role: "assistant"; children: Child[] };

export interface Step {
  idx: number;
  latencyMs: number;
  tokens: number;
  tools: number;
}

export interface Metrics {
  ttft: number | null; // ms
  total: number | null; // ms
  tps: number | null;
  prompt: number | null;
  completion: number | null;
}

export interface EngineCallbacks {
  setMsgs: Setter<Msg[]>;
  setStatus: Setter<StatusState>;
  setMetrics: Setter<Metrics>;
  setSteps: Setter<Step[]>;
  setConnected: Setter<boolean>;
  setModel: Setter<string>;
  setSession: Setter<string>;
}

export interface ReasoningEls {
  container: HTMLElement;
  head: HTMLElement;
  body: HTMLElement;
}

export const EMPTY_METRICS: Metrics = {
  ttft: null,
  total: null,
  tps: null,
  prompt: null,
  completion: null,
};

let idSeq = 0;
const nextId = () => "b" + ++idSeq;
const now = () => performance.now();

export class StreamEngine {
  private cb: EngineCallbacks;

  // 流式缓冲
  private tokenBuf = "";
  private reasoningBuf = "";
  private reasoningStart = 0;
  private rafPending = false;

  // 活跃流式目标（由组件 mount 时绑定）
  private reasoningEls: ReasoningEls | null = null;
  private assistantEl: HTMLElement | null = null;
  private scrollEl: HTMLElement | null = null;

  // 回合统计
  private userSendTime = 0;
  private firstTokenAt = 0;
  private tokenCount = 0;
  private streaming = false;
  private turnOpen = false;
  private curToolId: string | null = null;

  constructor(cb: EngineCallbacks) {
    this.cb = cb;
  }

  // ---- 组件挂载绑定 ----

  bindScroll(el: HTMLElement | null) {
    this.scrollEl = el;
  }
  bindReasoning(els: ReasoningEls) {
    this.reasoningEls = els;
    this.scheduleFlush();
  }
  unbindReasoning() {
    this.reasoningEls = null;
  }
  bindAssistant(el: HTMLElement | null) {
    this.assistantEl = el;
    this.scheduleFlush();
  }

  // ---- 用户动作 ----

  startTurn(text: string) {
    this.cb.setMsgs((prev) => [
      ...prev,
      { id: nextId(), role: "user", text },
      { id: nextId(), role: "assistant", children: [] },
    ]);
    this.resetTurn();
    this.turnOpen = true;
    this.streaming = true;
    this.userSendTime = now();
    this.cb.setStatus("thinking");
  }

  private resetTurn() {
    this.tokenBuf = "";
    this.reasoningBuf = "";
    this.reasoningStart = 0;
    this.firstTokenAt = 0;
    this.tokenCount = 0;
    this.streaming = false;
    this.turnOpen = false;
    this.curToolId = null;
    this.reasoningEls = null;
    this.assistantEl = null;
    this.cb.setMetrics(EMPTY_METRICS);
    this.cb.setSteps([]);
  }

  // ---- WS 事件分发 ----

  dispatch(ev: MonoDeskEvent) {
    switch (ev.type) {
      case "hello":
        this.cb.setConnected(true);
        this.cb.setModel(ev.data.model);
        this.cb.setSession(ev.data.session_key);
        break;
      case "status":
        this.onStatus(ev.data.state);
        break;
      case "reasoning":
        this.onReasoning(ev.data.text);
        break;
      case "token":
        this.onToken(ev.data.text);
        break;
      case "tool_start":
        this.onToolStart(ev.data.name, ev.data.args);
        break;
      case "tool_end":
        this.onToolEnd(ev.data.result, ev.data.latency_ms);
        break;
      case "metric":
        this.onMetric(ev.data.metrics);
        break;
      case "final":
        this.onFinal();
        break;
      case "card":
        this.onCard(ev.data.data);
        break;
      case "error":
        this.onError(ev.data.code, ev.data.msg);
        break;
    }
  }

  // ---- 事件处理 ----

  private onStatus(state: StatusState) {
    this.cb.setStatus(state);
    if (state === "thinking") {
      if (!this.turnOpen) this.ensureTurn();
    } else {
      this.freezeText();
      this.freezeReasoning();
      if (state === "wait_io" || state === "idle") this.turnOpen = false;
    }
  }

  private ensureTurn() {
    this.cb.setMsgs((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.role === "assistant") return prev;
      return [...prev, { id: nextId(), role: "assistant", children: [] }];
    });
    this.turnOpen = true;
  }

  private onReasoning(text: string) {
    if (!this.turnOpen) this.ensureTurn();
    if (!this.reasoningEls) {
      this.appendChild({ id: nextId(), kind: "reasoning" });
      this.reasoningStart = now();
    }
    this.reasoningBuf += text;
    this.scheduleFlush();
  }

  private onToken(text: string) {
    if (!this.turnOpen) this.ensureTurn();
    if (!this.assistantEl) {
      this.freezeReasoning();
      this.appendChild({ id: nextId(), kind: "text" });
    }
    if (this.firstTokenAt === 0) {
      this.firstTokenAt = now();
      const ttft = this.firstTokenAt - this.userSendTime;
      this.cb.setMetrics((m) => ({ ...m, ttft: Math.round(ttft) }));
    }
    this.tokenBuf += text;
    this.tokenCount += text.length;
    const elapsed = (now() - this.firstTokenAt) / 1000;
    if (elapsed > 0) {
      this.cb.setMetrics((m) => ({ ...m, tps: Math.round(this.tokenCount / elapsed) }));
    }
    this.scheduleFlush();
  }

  private onToolStart(name: string, args: Record<string, unknown>) {
    this.freezeText();
    this.freezeReasoning();
    const argsStr = Object.entries(args || {})
      .map(([k, v]) => k + "=" + JSON.stringify(v))
      .join(" ");
    const id = nextId();
    this.curToolId = id;
    this.appendChild({
      id,
      kind: "tool",
      name,
      args: truncate(argsStr, 40),
      state: "running",
    });
  }

  private onToolEnd(result: ToolResultData, latencyMs: number) {
    const id = this.curToolId;
    this.curToolId = null;
    if (id) this.patchChild(id, { state: "done", result, latencyMs });
  }

  private onMetric(m: Record<string, any>) {
    this.freezeText();
    const tok = m.tokens || {};
    const text =
      "step " + m.step_idx + " · " + fmtMs(m.latency_ms) + " · " +
      (tok.completion_tokens ?? "?") + " tok · " + (m.tool_calls_count || 0) + " tool";
    this.appendChild({ id: nextId(), kind: "note", text });
    this.cb.setSteps((prev) => [
      ...prev,
      { idx: m.step_idx, latencyMs: m.latency_ms, tokens: tok.completion_tokens ?? 0, tools: m.tool_calls_count || 0 },
    ]);
    if (tok.prompt_tokens != null) this.cb.setMetrics((mm) => ({ ...mm, prompt: tok.prompt_tokens }));
    if (tok.completion_tokens != null) this.cb.setMetrics((mm) => ({ ...mm, completion: tok.completion_tokens }));
  }

  private onFinal() {
    this.freezeText();
    this.freezeReasoning();
    this.streaming = false;
    const total = now() - this.userSendTime;
    this.cb.setMetrics((m) => ({ ...m, total: Math.round(total) }));
  }

  private onCard(data: Record<string, any>) {
    this.freezeText();
    this.appendChild({
      id: nextId(),
      kind: "note",
      text: "card · " + truncate(JSON.stringify(data), 200),
    });
  }

  private onError(code: string, msg: string) {
    this.freezeText();
    this.freezeReasoning();
    this.appendChild({ id: nextId(), kind: "error", text: code + " — " + msg });
    this.cb.setStatus("error");
  }

  // ---- 结构性块列表变更 ----

  private appendChild(child: Child) {
    this.cb.setMsgs((prev) => {
      const next = [...prev];
      const last = next[next.length - 1];
      if (last && last.role === "assistant") {
        next[next.length - 1] = { ...last, children: [...last.children, child] };
      }
      return next;
    });
  }

  private patchChild(id: string, patch: Partial<Child>) {
    this.cb.setMsgs((prev) =>
      prev.map((m) =>
        m.role !== "assistant"
          ? m
          : {
              ...m,
              children: m.children.map((c) => (c.id === id ? ({ ...c, ...patch } as Child) : c)),
            }
      )
    );
  }

  // ---- 流式重绘 ----

  private scheduleFlush() {
    if (this.rafPending) return;
    this.rafPending = true;
    requestAnimationFrame(() => {
      this.rafPending = false;
      this.flush();
    });
  }

  private flush() {
    if (this.reasoningEls) {
      this.reasoningEls.body.innerHTML = esc(this.reasoningBuf) + CARET;
      const dur = now() - this.reasoningStart;
      const meta = this.reasoningEls.head.querySelector(".meta");
      if (meta) meta.textContent = this.reasoningBuf.length + " chars · " + fmtMs(dur);
    }
    if (this.assistantEl) this.paintText();
    this.scrollBottom();
  }

  private paintText() {
    const el = this.assistantEl;
    if (!el) return;
    el.innerHTML = renderMarkdown(this.tokenBuf);
    if (!this.streaming) return;
    let host = el.lastElementChild as HTMLElement | null;
    if (host && host.classList.contains("codeblock")) {
      host = host.querySelector("code") || host;
    }
    if (!host) host = el;
    const c = document.createElement("span");
    c.className = "caret";
    host.appendChild(c);
  }

  private freezeText() {
    if (this.assistantEl) {
      this.assistantEl.innerHTML = renderMarkdown(this.tokenBuf);
      this.assistantEl = null;
      this.tokenBuf = "";
    }
    this.streaming = false;
  }

  private freezeReasoning() {
    if (this.reasoningEls) {
      this.reasoningEls.body.innerHTML = esc(this.reasoningBuf);
      if (this.reasoningBuf.length > 60) this.reasoningEls.container.classList.remove("open");
      this.reasoningEls = null;
      this.reasoningBuf = "";
    }
  }

  private scrollBottom() {
    if (this.scrollEl) this.scrollEl.scrollTop = this.scrollEl.scrollHeight;
  }
}
