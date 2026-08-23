// StreamEngine：MonoDesk 的流式渲染中枢。
//
// 核心原则（与 preview 一致）：token / reasoning 不做逐字 React setState，
// 而是 token 缓冲 + requestAnimationFrame 合并 → 直接写 DOM 文本节点，每帧最多一次重绘。
// React 只负责“结构性块”（turn / reasoning 开关 / tool 起止 / final / error / metric）。
//
// 结构性块用 key 稳定 + 组件浅 props 不变，React 跳过重渲染，因此引擎直接改的
// innerHTML / class 不会被打断。
//
// 文本内容在「冻结」（freeze）时写回 Child.text，用于本地持久化 + 切会话后静态渲染。

import { CARET, esc, fmtMs, renderMarkdown, truncate } from "./markdown";
import type { MonoDeskEvent, StatusState, ToolResultData } from "../ws/protocol";

type Setter<T> = (v: T | ((prev: T) => T)) => void;

export type Child =
  | { id: string; kind: "reasoning"; text?: string }
  | { id: string; kind: "text"; text?: string }
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
}

export interface ReasoningEls {
  id: string;          // 对应 child.id，bind 时验证一致性（防 React 重渲染期间绑错块）
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

// 打字机平滑：Jitter Buffer + 单字淡入
// ------------------------------------------------------------
// 1) 接收端拆字：每个 token 字符单独打 arriveAt 时间戳入队
// 2) 消费端按固定速率（每帧 ~3-5 字）从 queue 解锁，写到 paintedBuf
// 3) DOM 上每个新解锁的字符包成 <span class="ch fresh">，CSS animation 0→1
//    透明渐入。已稳定（动画结束）的字符合并为文本节点。
//
// 用户感知：一个字一个字从左到右半透明慢慢浮现，整体速率可控不急。
// ------------------------------------------------------------
const TARGET_RATE_CPS = 90;      // 单字渲染：每秒 ~9 字（中文等宽算一个字）
const TARGET_BUFFER_MS = 120;    // 希望维持的 buffer 积压
const MAX_BUFFER_MS = 1500;      // 积压过大则跳过（模型太快）
const TICK_MS = 33;              // 30fps tick
const CHARS_PER_TICK = 3;        // 每 tick 解锁 3 个字符（≈ 90 cps @ 30fps）

export class StreamEngine {
  private cb: EngineCallbacks;

  // 流式缓冲
  private tokenBuf = "";
  private reasoningBuf = "";
  private reasoningStart = 0;
  // 最近写入的字符 DOM span 列表（动画结束后合并成 text node 释放）
  private freshSpans: HTMLSpanElement[] = [];

  // 当前活跃的 text / reasoning 子块 id（freeze 时把内容写回 model）
  private curTextId: string | null = null;
  private curReasoningId: string | null = null;

  // Jitter buffer 状态
  // - queue: 还没到「虚拟播放时间」的字符（每字符带 arriveAt）
  // - paintedBuf: 已上屏的字符（按 arriveAt 顺序累计）
  // - painted: paintedBuf 长度（冗余存，避免每次 length 计算）
  // - playhead: 虚拟播放时间（ms），按 rate 匀速推进
  // - lastFlushAt: 上一帧实际 wall 时间，用来计算本帧 dt
  // - lastWriteIndex: 已写入 DOM 的 paintedBuf 切片位置（增量写）
  // - pendingChunk: 本帧从 queue 解锁出来的字符串（增量追加到 DOM）
  private jbQueue: Array<{ ch: string; arriveAt: number }> = [];
  private paintedBuf = "";
  private painted = 0;
  private jbPlayhead = 0;
  private jbLastFlushAt = 0;
  private lastWriteIndex = 0;
  private pendingChunk = "";

  // 活跃流式目标（由组件 mount 时绑定）
  private reasoningEls: ReasoningEls | null = null;
  private assistantEl: HTMLElement | null = null;
  private scrollEl: HTMLElement | null = null;

  // 「请求滚到底」标记：每次 flush 置 true；Conversation 在 DOM 更新后
  // 调 consumeScrollRequest() 取走，根据用户当前是否在底部决定真的滚。
  private scrollRequest = false;

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
  // 由 Conversation 在每次 React render 后调用：返回自上次以来是否「请求过滚到底」。
  // 引擎不会自己改 DOM scrollTop；具体策略（跟随 / 脱离 / 浮按钮）由 UI 决定。
  consumeScrollRequest(): boolean {
    const r = this.scrollRequest;
    this.scrollRequest = false;
    return r;
  }
  bindReasoning(els: ReasoningEls) {
    // 只在 id 匹配 curReasoningId 时才绑定。React 重渲染时可能短暂 mount
    // 别的 block（children 列表变化）——忽略那些，避免 reasoningEls 错位。
    if (els.id === this.curReasoningId) {
      this.reasoningEls = els;
      this.scheduleFlush();
    }
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

  // 暂停当前流（切会话 / 视图离开时调用）：把已缓冲内容冻结写回 model。
  pauseStream() {
    this.freezeText();
    this.freezeReasoning();
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
    this.curTextId = null;
    this.curReasoningId = null;
    this.painted = 0;
    this.paintedBuf = "";
    this.jbQueue = [];
    this.jbPlayhead = 0;
    this.jbLastFlushAt = 0;
    this.freshSpans = [];
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
        // 服务端报告的模型只在尚未选择时回填；session_key 由 MonoDesk 本地管理，
        // 不能覆盖用户当前选中的会话。
        this.cb.setModel((m) => m || ev.data.model);
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
    // 用稳定的 child id (curReasoningId) 判断，不再用 reasoningEls（它是临时绑定，
    // 会被 React 重渲染清掉）。
    if (this.curReasoningId == null) {
      const id = nextId();
      this.curReasoningId = id;
      this.appendChild({ id, kind: "reasoning" });
      this.reasoningStart = now();
    }
    this.reasoningBuf += text;
    this.scheduleFlush();
  }

  private onToken(text: string) {
    if (!this.turnOpen) this.ensureTurn();
    if (!this.assistantEl) {
      this.freezeReasoning();
      const id = nextId();
      this.curTextId = id;
      this.appendChild({ id, kind: "text" });
      this.streaming = true;
      this.painted = 0;
      this.paintedBuf = "";
      this.jbQueue = [];
      this.jbPlayhead = 0;
      this.jbLastFlushAt = 0;
    }
    if (this.firstTokenAt === 0) {
      this.firstTokenAt = now();
      const ttft = this.firstTokenAt - this.userSendTime;
      this.cb.setMetrics((m) => ({ ...m, ttft: Math.round(ttft) }));
      // 第一个 token 到达：初始化虚拟播放头 = 当前时间 + TARGET_BUFFER_MS 积压
      this.jbPlayhead = this.firstTokenAt + TARGET_BUFFER_MS;
      this.jbLastFlushAt = this.firstTokenAt;
    }
    // 每个字符打上"到达时间戳"，进入 jitter queue。
    // tokenBuf 始终是「已上屏 + 队列里全部」的总拼接，方便 freeze 时拿到完整文本。
    const t = now();
    for (const ch of text) {
      this.jbQueue.push({ ch, arriveAt: t });
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
  // 固定 30fps（不用 rAF），rAF 在 120Hz 屏上每秒重画 120 次 markdown 全量，浪费。
  // 增量写：只把"本帧从 queue 解锁"的字符串 append 到 DOM，不重新解析整个 paintedBuf。

  private flushTimer: number | null = null;
  private mergeTimer: number | null = null;

  private scheduleFlush() {
    if (this.flushTimer != null) return;
    this.flushTimer = window.setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, TICK_MS);
  }

  private flush() {
    if (this.reasoningEls) {
      this.reasoningEls.body.innerHTML = esc(this.reasoningBuf) + CARET;
      const dur = now() - this.reasoningStart;
      const meta = this.reasoningEls.head.querySelector(".meta");
      if (meta) meta.textContent = this.reasoningBuf.length + " chars · " + fmtMs(dur);
    }
    if (this.assistantEl) this.paintText();
    this.requestScrollToBottom();
  }

  private paintText() {
    const el = this.assistantEl;
    if (!el) return;
    if (!this.streaming || this.tokenBuf.length === 0) {
      // 流结束（被 freeze 调过）：最后一次渲染（一次性 innerHTML），DOM 收敛到稳定状态
      this.consolidateFreshSpans();
      el.innerHTML = renderMarkdown(this.paintedBuf);
      this.appendCaret(el);
      return;
    }

    // 1) 推进虚拟播放头
    const t = now();
    if (this.jbLastFlushAt === 0) this.jbLastFlushAt = t;
    const dtMs = Math.max(0, t - this.jbLastFlushAt);
    this.jbLastFlushAt = t;
    this.jbPlayhead += dtMs;

    // 2) 积压过大时跳过积压（drain）
    if (this.jbQueue.length > 0) {
      const headLag = this.jbPlayhead - this.jbQueue[0].arriveAt;
      if (headLag > MAX_BUFFER_MS) {
        this.jbPlayhead = this.jbQueue[0].arriveAt + TARGET_BUFFER_MS;
      }
    }

    // 3) 消费 queue：每 tick 最多解锁 CHARS_PER_TICK 个字符
    let released = "";
    for (let i = 0; i < CHARS_PER_TICK && this.jbQueue.length > 0 && this.jbQueue[0].arriveAt <= this.jbPlayhead; i++) {
      released += this.jbQueue.shift()!.ch;
    }
    if (released.length === 0) {
      if (this.jbQueue.length > 0) this.scheduleFlush();
      return;
    }

    // 4) 累加到 paintedBuf
    this.paintedBuf += released;
    this.painted = this.paintedBuf.length;

    // 5) 代理对守卫
    if (this.painted > 0 && this.paintedBuf.length > this.painted) {
      const tail = this.paintedBuf.charCodeAt(this.painted - 1);
      if (tail >= 0xd800 && tail <= 0xdbff) {
        this.painted--;
        this.paintedBuf = this.paintedBuf.slice(0, this.painted);
        released = released.slice(0, released.length - 1);
      }
    }

    // 6) 单字淡入写入：每个新解锁的字符包成 span.ch.fresh，CSS animation 渐入
    this.appendFreshChars(el, released);

    // 7) 旧 fresh span 动画结束后合并成文本节点，控制 DOM 大小
    this.mergeFinishedSpans(el);

    if (this.jbQueue.length > 0) this.scheduleFlush();
  }

  // 把刚解锁的字符追加为 fresh span（带淡入动画）
  private appendFreshChars(el: HTMLElement, chars: string) {
    if (!chars) return;
    const caret = el.querySelector(".caret");
    if (caret) caret.remove();

    const host = el.lastElementChild as HTMLElement | null;
    // 跨越 markdown 块边界（\n\n）→ 整段重渲
    if (/\n\n/.test(chars) || !host || host.tagName.toLowerCase() !== "p") {
      el.innerHTML = renderMarkdown(this.paintedBuf);
      this.appendCaret(el);
      return;
    }
    // 普通段落内：每个字符一个 span.ch.fresh
    for (const ch of chars) {
      const span = document.createElement("span");
      span.className = "ch fresh";
      span.textContent = ch;
      host.appendChild(span);
      this.freshSpans.push(span);
    }
    this.appendCaret(el);
  }

  // 把动画已结束的 fresh span 合并成文本节点（释放 DOM）
  // 通过 animationend 事件在每个 span 上处理更优雅，但简单起见用延迟合并：
  // 200ms 后（动画结束）所有未合并的 fresh span 一起合并。
  private mergeFinishedSpans(el: HTMLElement) {
    if (this.freshSpans.length === 0) return;
    if (this.mergeTimer != null) return;
    this.mergeTimer = window.setTimeout(() => {
      this.mergeTimer = null;
      this.consolidateFreshSpans();
    }, 220); // CSS animation ~180ms
  }

  private consolidateFreshSpans() {
    if (this.freshSpans.length === 0) return;
    // 找到 fresh span 的父节点（通常是 .stream > p），把每个 span 替换成 text node
    for (const span of this.freshSpans) {
      if (!span.parentNode) continue;
      span.parentNode.replaceChild(document.createTextNode(span.textContent || ""), span);
    }
    this.freshSpans = [];
  }

  private appendCaret(el: HTMLElement) {
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
    if (this.curTextId != null && this.tokenBuf) {
      this.patchChild(this.curTextId, { text: this.tokenBuf });
    }
    this.curTextId = null;
    this.assistantEl = null;
    this.tokenBuf = "";
    this.painted = 0;
    this.paintedBuf = "";
    this.jbQueue = [];
    this.jbPlayhead = 0;
    this.jbLastFlushAt = 0;
    this.freshSpans = [];
    if (this.mergeTimer != null) { clearTimeout(this.mergeTimer); this.mergeTimer = null; }
    this.streaming = false;
  }

  private freezeReasoning() {
    if (this.curReasoningId != null && this.reasoningBuf) {
      this.patchChild(this.curReasoningId, { text: this.reasoningBuf });
    }
    this.curReasoningId = null;
    this.reasoningEls = null;
    this.reasoningBuf = "";
    this.reasoningStart = 0;
  }

  private requestScrollToBottom() {
    this.scrollRequest = true;
  }
}
