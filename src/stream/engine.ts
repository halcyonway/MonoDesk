// StreamEngine：MonoDesk 的流式渲染中枢。
//
// 核心原则（与 preview 一致）：token / reasoning 不做逐字 React setState，
// 而是 token 缓冲 + requestAnimationFrame 合并 → 直接写 DOM 文本节点，每帧最多一次重绘。
// React 只负责"结构性块"（turn / reasoning 开关 / tool 起止 / final / error / metric）。
//
// 结构性块用 key 稳定 + 组件浅 props 不变，React 跳过重渲染，因此引擎直接改的
// innerHTML / class 不会被打断。
//
// 文本内容在「冻结」（freeze）时写回 Child.text，用于本地持久化 + 切会话后静态渲染。
//
// #74：所有运行时缓冲（tokenBuf / jbQueue / currentRunId / currentMetric / DOM 绑定 / 定时器）
// 都按 sessionKey 隔离到 PerSessionStream。同一 StreamEngine 实例维护一张 Map，
// dispatch(ev) 按 ev.data.session_key 选对应 stream，late event 永远不会污染别的 session
// （之前根因：所有字段都是 this.X 全局共享，A 没流完就切到 B 发 → A 的 token 写到 B 的 buffer）。

import { CARET, esc, fmtMs, renderMarkdown, truncate } from "./markdown";

// partial args JSON → dict（容错：解析失败返回空对象）。
// 用于 ToolPending 收到 args_so_far 但没 call_id 的回退路径。
function _parseArgsString(s: string): Record<string, unknown> {
  if (!s) return {};
  try {
    const v = JSON.parse(s);
    return typeof v === "object" && v ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
import type { Attachment, MonoDeskEvent, StatusState, ToolResultData } from "../ws/protocol";

type Setter<T> = (v: T | ((prev: T) => T)) => void;

export type Child =
  | { id: string; kind: "reasoning"; text?: string }
  | { id: string; kind: "text"; text?: string }
  | {
      id: string;
      kind: "tool";
      name: string;
      // 完整参数字符串（不再 truncation）；UI 自行决定如何压缩展示。
      args: string;
      state: "running" | "done";
      result?: ToolResultData;
      latencyMs?: number;
      // callId 用于把 ToolPending（先发的）和 ToolStart 配对成同一个块，避免双卡片。
      // 缺失（老 server）也能跑 —— onToolStart 检测不到匹配就走「创建新块」路径。
      callId?: string;
    }
  | { id: string; kind: "note"; text: string }
  | { id: string; kind: "error"; text: string };

export type Msg =
  | {
      id: string;
      role: "user";
      text: string;
      attachments?: Attachment[];
      // Fork session 首条 user msg 会把 snippet + parent context 拼到 text 里发出去
      // （给 agent 看上下文用）。这里存「用户实际输入的纯净问题」，UI 渲染时
      // 优先显示这个，隐藏 prefix 那一坨 `[From session...] [Selected snippet] [Your question]` 标签。
      // 非 fork / 后续追问没有这个字段，UI 退回到显示 msg.text。
      forkQuestion?: string;
    }
  | {
      id: string;
      role: "assistant";
      children: Child[];
      // pending: 等待首帧内容（token/reasoning/tool）到达时为 true，
      // 期间 UI 显示 loading 指示器；首帧到达后（或 error/final），清除此标记。
      pending?: boolean;
      runId?: string | null;
      // 行内指标（final 时从最新 metric 写回，用于 agent label 下方一行：
      // "X tok · Yms · ⚡ Z% · [trace]"）。
      //
      // `cached` 是 optional：LLM 流式响应有时候不带 `prompt_tokens_details.cached_tokens`
      // 字段（实测 MiniMax：< 512 token 的 prompt / cache build-up 阶段都会缺失），
      // 缺失时整个字段不写，让 UI 能区分「服务端没报告」和「报告了 0」。
      tokens?: { prompt: number; completion: number; cached?: number } | null;
      latencyMs?: number | null;
    };

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
  setAvailableProviders: Setter<string[]>;
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
const REASONING_CPS = 30;        // reasoning 字符打字机：~1 字/tick @ 30fps（每个字视觉独占一帧）

// ---- Per-session stream state (#74 + #78) ----
//
// 每个活跃 session 一份独立的运行时状态。包含流式 token 缓冲、jitter buffer、
// 当前活跃 child id、DOM 元素引用、定时器。
//
// #78：移除「trace 捕获」字段（currentRunId / currentMetric）。
// 之前的设计是「metric → 累积到 currentRunId/currentMetric → final 时挂到 msg」，
// 这要求 engine 持有「跨事件累积」状态，对调试和隔离都不友好。
// 新设计：metric 事件直接写 msg（最后一条 metric 覆盖前一条），final 不再管这些。
// 这也意味着 trace_id / tokens / latencyMs 都是「单事件写入」，没有跨事件状态。
//
// 关键不变量：engine 实例只有一个，stream 有 N 个，每个 stream 完全独立。
// engine 本身没有任何跨 session 的共享字段（this.cb / this.activeSessionKey 都没了），
// dispatch / startTurn / pauseStream / bind* 都接受 sessionKey 显式定位到对应 stream。
interface PerSessionStream {
  // DOM 绑定（Conversation 在 mount/unmount 时设/清；background session 这里为 null，
  // token 仍可通过 dispatch 进入，但 paintText 看到 null 就跳过 DOM 写）。
  assistantEl: HTMLElement | null;
  reasoningEls: ReasoningEls | null;
  scrollEl: HTMLElement | null;

  // 回合状态
  turnOpen: boolean;
  streaming: boolean;
  userSendTime: number;
  firstTokenAt: number;
  tokenCount: number;
  curToolId: string | null;

  // 文本 / 推理缓冲
  tokenBuf: string;
  reasoningBuf: string;         // 完整 reasoning 文本（freeze 时写 msg 用）
  reasoningStart: number;
  reasoningQueue: Array<{ ch: string; arriveAt: number }>;  // reasoning jitter buffer
  reasoningPainted: number;    // 已渲染到 DOM 的字符数（增量写入用）
  reasoningLastFlushAt: number;
  curTextId: string | null;
  curReasoningId: string | null;

  // Jitter buffer 状态
  jbQueue: Array<{ ch: string; arriveAt: number }>;
  paintedBuf: string;
  painted: number;
  jbPlayhead: number;
  jbLastFlushAt: number;
  freshSpans: HTMLSpanElement[];

  // 每 stream 独立的 timer（background session 不能 flush 进死掉的 DOM；
  // 两个 session 同时活跃也要各自 tick）。
  flushTimer: number | null;
  mergeTimer: number | null;

  // 「请滚到底」标记
  scrollRequest: boolean;

  // ToolPending → ToolStart 配对：call_id → 已建好的 child.id
  // ToolPending 立刻创一个 running block，args 来了 ToolStart 找到它只更新 args，
  // 不再新建第二个卡片。没匹配上（老 server 或 race）就当作 legacy 路径新建。
  pendingToolByCallId: Map<string, string>;
}

function emptyStream(): PerSessionStream {
  return {
    assistantEl: null,
    reasoningEls: null,
    scrollEl: null,
    turnOpen: false,
    streaming: false,
    userSendTime: 0,
    firstTokenAt: 0,
    tokenCount: 0,
    curToolId: null,
    tokenBuf: "",
    reasoningBuf: "",
    reasoningStart: 0,
    reasoningQueue: [],
    reasoningPainted: 0,
    reasoningLastFlushAt: 0,
    curTextId: null,
    curReasoningId: null,
    jbQueue: [],
    paintedBuf: "",
    painted: 0,
    jbPlayhead: 0,
    jbLastFlushAt: 0,
    freshSpans: [],
    flushTimer: null,
    mergeTimer: null,
    scrollRequest: false,
    pendingToolByCallId: new Map(),
  };
}

export class StreamEngine {
  private router: (sessionKey: string) => EngineCallbacks;
  // #78：engine 实例上**没有任何**跨 session 的共享字段（this.cb / this.activeSessionKey
  // 都删了）。每个 handler 接收 (cb, sk) 作为入参 —— cb 是这次调用从 router(sk) 拿到的
  // 一次性 setter 集，sk 是显式传入的 sessionKey。dispatch 完全自包含，没有任何
  // 「上次 event 的状态影响这次 event」的可能。
  private streams = new Map<string, PerSessionStream>();

  constructor(router: (sessionKey: string) => EngineCallbacks) {
    this.router = router;
  }

  private streamFor(sk: string): PerSessionStream {
    let s = this.streams.get(sk);
    if (!s) {
      s = emptyStream();
      this.streams.set(sk, s);
    }
    return s;
  }

  // ---- 组件挂载绑定 ----
  //
  // 所有 binding 函数都接收 sessionKey（App 把 `session` 传给 Conversation，
  // Conversation 透传给 TextStream / ReasonBlock）。这样 unmount 时 cleanup
  // 也能精准清掉对应 stream 的 DOM ref，不会误清当前 active session。

  bindScroll(sessionKey: string, el: HTMLElement | null) {
    this.streamFor(sessionKey).scrollEl = el;
  }

  /** 由外部消费 scrollRequest（当前未在 Conversation 中使用 —— Conversation 直接靠
   * msgs 引用变化触发 useEffect 滚到底）。保留 API 以备将来切到「引擎驱动滚动」时用。 */
  consumeScrollRequest(sessionKey: string): boolean {
    const s = this.streamFor(sessionKey);
    const r = s.scrollRequest;
    s.scrollRequest = false;
    return r;
  }

  bindReasoning(sessionKey: string, els: ReasoningEls | null) {
    const s = this.streamFor(sessionKey);
    if (els) {
      // 只在 id 匹配 curReasoningId 时才绑定。React 重渲染时可能短暂 mount
      // 别的 block（children 列表变化）——忽略那些，避免 reasoningEls 错位。
      if (els.id === s.curReasoningId) {
        s.reasoningEls = els;
        // rebind 时若有积压，立刻 drain（queue 保留着，flush 会追上）
        this.scheduleFlush(s);
      }
    } else {
      // reasoning 组件 unmount：立刻合并所有未完成的 fresh span
      //（DOM 还在，mergeTimer 会在下一个 flush 前或独立触发）
      this.consolidateFreshSpans(s);
      s.reasoningEls = null;
    }
  }

  unbindReasoning(sessionKey: string) {
    this.streamFor(sessionKey).reasoningEls = null;
  }

  bindAssistant(sessionKey: string, el: HTMLElement | null) {
    const s = this.streamFor(sessionKey);
    s.assistantEl = el;
    if (el) this.scheduleFlush(s);
  }

  // ---- 用户动作 ----

  startTurn(text: string, sessionKey: string, attachments?: Attachment[], opts?: { forkQuestion?: string }) {
    // startTurn 由 App 主动调用（不在 dispatch 路径上），所以没有 ev.data.session_key
    // 可读 —— 必须由 App 显式传入「这条 user_input 要进哪个 session」。
    //
    // forkQuestion：fork session 首条 user msg 会把 snippet + parent context 拼到 text 里
    // 发给 agent；这里存「用户实际输入的纯净问题」，UI 渲染时优先显示这个（详见 Msg type）。
    const cb = this.router(sessionKey);
    cb.setMsgs((prev) => [
      ...prev,
      { id: nextId(), role: "user", text, attachments, forkQuestion: opts?.forkQuestion },
      { id: nextId(), role: "assistant", children: [], pending: true },
    ]);
    this.resetTurn(cb, sessionKey);
    const s = this.streamFor(sessionKey);
    s.turnOpen = true;
    s.streaming = true;
    s.userSendTime = now();
    cb.setStatus("thinking");
  }

  // 暂停当前流（切会话 / 视图离开时调用）：把已缓冲内容冻结写回 model。
  // 必须由 App 显式传入 sessionKey —— 每次调用都从 router(sk) 拿新的 cb，
  // 不会误写到别的 session。
  pauseStream(sessionKey: string) {
    const cb = this.router(sessionKey);
    this.freezeText(cb, sessionKey);
    this.freezeReasoning(cb, sessionKey);
  }

  private resetTurn(cb: EngineCallbacks, sessionKey: string) {
    const s = this.streamFor(sessionKey);
    s.tokenBuf = "";
    s.reasoningBuf = "";
    s.reasoningStart = 0;
    s.reasoningQueue = [];
    s.reasoningPainted = 0;
    s.reasoningLastFlushAt = 0;
    s.firstTokenAt = 0;
    s.tokenCount = 0;
    s.streaming = false;
    s.turnOpen = false;
    s.curToolId = null;
    s.curTextId = null;
    s.curReasoningId = null;
    s.painted = 0;
    s.paintedBuf = "";
    s.jbQueue = [];
    s.jbPlayhead = 0;
    s.jbLastFlushAt = 0;
    s.freshSpans = [];
    s.reasoningEls = null;
    s.assistantEl = null;
    // #78：移除了 currentRunId / currentMetric —— 新一轮对话的 metric 由
    // onMetric 直接写到 msg，不需要「清累积状态」这一步。
    cb.setMetrics(EMPTY_METRICS);
    cb.setSteps([]);
  }

  // ---- WS 事件分发 ----

  dispatch(ev: MonoDeskEvent) {
    // #78：每次 dispatch 完全自包含 —— 从 router(sk) 拿一次性 cb，把 cb + sk
    // 显式传给 handler。engine 实例本身没有任何「上次 event 状态影响这次 event」
    // 的字段（this.cb / this.activeSessionKey 都删了）。
    const sk = ev.data.session_key ?? "__default__";
    const cb = this.router(sk);
    switch (ev.type) {
      case "hello":
        cb.setConnected(true);
        // 服务端报告的模型只在尚未选择时回填；session_key 由 MonoDesk 本地管理，
        // 不能覆盖用户当前选中的会话。
        cb.setModel((m) => m || ev.data.model);
        // providers 列表来自 RuntimeServer 的 hello 帧
        if (ev.data.providers) {
          cb.setAvailableProviders(ev.data.providers);
        }
        break;
      case "status":
        this.onStatus(cb, sk, ev.data.state);
        break;
      case "reasoning":
        this.onReasoning(cb, sk, ev.data.text);
        break;
      case "token":
        this.onToken(cb, sk, ev.data.text);
        break;
      case "tool_pending":
        this.onToolPending(cb, sk, ev.data.call_id, ev.data.name, ev.data.tool_index, ev.data.args_so_far);
        break;
      case "tool_start":
        this.onToolStart(cb, sk, ev.data.name, ev.data.args, ev.data.call_id);
        break;
      case "tool_end":
        this.onToolEnd(cb, sk, ev.data.result, ev.data.latency_ms);
        break;
      case "metric":
        this.onMetric(cb, sk, ev.data.metrics, ev.data.trace_id, ev.data.model);
        break;
      case "final":
        this.onFinal(cb, sk, ev.data.trace_id);
        break;
      case "card":
        this.onCard(cb, sk, ev.data.data);
        break;
      case "error":
        this.onError(cb, sk, ev.data.code, ev.data.msg);
        break;
    }
  }

  // ---- 事件处理 ----

  private onStatus(cb: EngineCallbacks, sk: string, state: StatusState) {
    cb.setStatus(state);
    const s = this.streamFor(sk);
    if (state === "thinking") {
      if (!s.turnOpen) this.ensureTurn(cb, sk);
    } else {
      this.freezeText(cb, sk);
      this.freezeReasoning(cb, sk);
      if (state === "wait_io" || state === "idle") s.turnOpen = false;
    }
  }

  private ensureTurn(cb: EngineCallbacks, sk: string) {
    cb.setMsgs((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.role === "assistant") return prev;
      return [...prev, { id: nextId(), role: "assistant", children: [], pending: true }];
    });
    const s = this.streamFor(sk);
    s.turnOpen = true;
  }

  private onReasoning(cb: EngineCallbacks, sk: string, text: string) {
    const s = this.streamFor(sk);
    if (!s.turnOpen) this.ensureTurn(cb, sk);
    // 用稳定的 child id (curReasoningId) 判断，不再用 reasoningEls（它是临时绑定，
    // 会被 React 重渲染清掉）。
    if (s.curReasoningId == null) {
      const id = nextId();
      s.curReasoningId = id;
      this.appendChild(cb, sk, { id, kind: "reasoning" });
      s.reasoningStart = now();
      s.reasoningQueue = [];
      s.reasoningPainted = 0;
      s.reasoningLastFlushAt = 0;
    }
    // 记录每个字符的到达时间（jitter buffer 用）
    const t = now();
    for (const ch of text) {
      s.reasoningQueue.push({ ch, arriveAt: t });
    }
    s.reasoningBuf += text;
    this.scheduleFlush(s);
  }

  private onToken(cb: EngineCallbacks, sk: string, text: string) {
    const s = this.streamFor(sk);
    if (!s.turnOpen) this.ensureTurn(cb, sk);
    if (!s.assistantEl) {
      this.freezeReasoning(cb, sk);
      const id = nextId();
      s.curTextId = id;
      this.appendChild(cb, sk, { id, kind: "text" });
      s.streaming = true;
      s.painted = 0;
      s.paintedBuf = "";
      s.jbQueue = [];
      s.jbPlayhead = 0;
      s.jbLastFlushAt = 0;
    }
    if (s.firstTokenAt === 0) {
      s.firstTokenAt = now();
      const ttft = s.firstTokenAt - s.userSendTime;
      cb.setMetrics((m) => ({ ...m, ttft: Math.round(ttft) }));
      // 第一个 token 到达：初始化虚拟播放头 = 当前时间 + TARGET_BUFFER_MS 积压
      s.jbPlayhead = s.firstTokenAt + TARGET_BUFFER_MS;
      s.jbLastFlushAt = s.firstTokenAt;
      // 流式路径（assistantEl 已绑定）时 appendChild 不被调用，需在此清除 pending
      if (s.assistantEl) {
        cb.setMsgs((prev) => {
          for (let i = prev.length - 1; i >= 0; i--) {
            const m = prev[i];
            if (m.role !== "assistant") continue;
            if (m.pending) {
              const next = [...prev];
              next[i] = { ...m, pending: false };
              return next;
            }
            break;
          }
          return prev;
        });
      }
    }
    // 每个字符打上"到达时间戳"，进入 jitter queue。
    // tokenBuf 始终是「已上屏 + 队列里全部」的总拼接，方便 freeze 时拿到完整文本。
    const t = now();
    for (const ch of text) {
      s.jbQueue.push({ ch, arriveAt: t });
    }
    s.tokenBuf += text;
    s.tokenCount += text.length;
    const elapsed = (now() - s.firstTokenAt) / 1000;
    if (elapsed > 0) {
      cb.setMetrics((m) => ({ ...m, tps: Math.round(s.tokenCount / elapsed) }));
    }
    this.scheduleFlush(s);
  }

  private onToolStart(cb: EngineCallbacks, sk: string, name: string, args: Record<string, unknown>, callId?: string) {
    this.freezeText(cb, sk);
    this.freezeReasoning(cb, sk);
    // 把 args dict 序列化为合法 JSON 字符串存到 child.args。
    // 之前用 "k=v k=v" 形式（key=value pairs），bashSummary() 那边 JSON.parse 失败 → target
    // 永远渲染不出来。改成 JSON.stringify(args) 后 bashSummary 能正确 JSON.parse 解出 target。
    // child.kind === "tool" 的消费者（Conversation.tsx 的 ToolBlock / TaskBlock）都按 JSON 解析。
    const argsStr = JSON.stringify(args || {});
    const s = this.streamFor(sk);

    // 有 call_id + 之前有 ToolPending 创过块 → 找到它，只更新 args/name。
    // 没有匹配（legacy server / race / 网络丢包）→ 走老路径新建块。
    if (callId && s.pendingToolByCallId.has(callId)) {
      const targetId = s.pendingToolByCallId.get(callId)!;
      s.pendingToolByCallId.delete(callId);
      s.curToolId = targetId;
      cb.setMsgs((prev) =>
        prev.map((m) =>
          m.role !== "assistant"
            ? m
            : {
                ...m,
                children: m.children.map((c) =>
                  c.id === targetId
                    ? ({ ...c, name, args: argsStr, state: "running" } as Child)
                    : c
                ),
              }
        )
      );
      return;
    }

    const id = nextId();
    s.curToolId = id;
    this.appendChild(cb, sk, {
      id,
      kind: "tool",
      name,
      args: argsStr,
      state: "running",
      callId,
    });
  }

  private onToolPending(cb: EngineCallbacks, sk: string, callId: string, name: string, toolIndex: number, argsSoFar: string) {
    // 收到 ToolPending 立刻创建一个 running 块（args 可能为空）。
    // ToolStart 之后会带完整 args 过来配对 update，避免 args 出完之前 UI 是空的。
    //
    // 注意：不 freezeText / freezeReasoning —— ToolPending 通常和 token 流同帧到达，
    // 强制 freeze 会把刚到的 token 切掉。ToolStart 再 freeze 就行。
    void toolIndex; // 暂用不到；future: 并行 tool 时排序
    if (!callId) {
      // 没有 call_id（异常路径）→ 走 legacy：把 args_so_far 当完整 args 处理
      this.onToolStart(cb, sk, name, _parseArgsString(argsSoFar));
      return;
    }
    const s = this.streamFor(sk);
    // 同 call_id 不重复创（防御性：server 偶尔重复发）
    if (s.pendingToolByCallId.has(callId)) return;
    const id = nextId();
    s.curToolId = id;
    s.pendingToolByCallId.set(callId, id);
    this.appendChild(cb, sk, {
      id,
      kind: "tool",
      name,
      args: argsSoFar || "",
      state: "running",
      callId,
    });
  }

  private onToolEnd(cb: EngineCallbacks, sk: string, result: ToolResultData, latencyMs: number) {
    const s = this.streamFor(sk);
    const id = s.curToolId;
    s.curToolId = null;
    if (id) this.patchChild(cb, sk, id, { state: "done", result, latencyMs });
  }

  // #78：metric 事件直接写 msg 的 runId / tokens / latencyMs —— 最后一条 metric
  // 覆盖前一条。完全去掉 currentRunId / currentMetric 这种「跨事件累积状态」，
  // engine 实例本身不再持有任何「上次 event 影响这次 event」的字段。
  // 数据写到最近一条 assistant msg（一定是 metric 之前的某次 startTurn / ensureTurn 创建的）。
  private onMetric(
    cb: EngineCallbacks,
    sk: string,
    m: Record<string, any>,
    traceId?: string,
    model?: string
  ) {
    this.freezeText(cb, sk);
    // 真实调用 model 名：来自 MetricChunk.model（provider 解析后的真实字符串）。
    // 切 provider 后下个 turn 即生效，覆盖 hello.model 默认值。
    if (model) cb.setModel(model);
    const tok = m.tokens || {};
    // #polish：删除 step N · Xms · Ytok · Ztool 的 note child。
    // step_idx 顺序错乱、tool_calls_count 字段语义不明（per-step vs 累计），
    // msg.tokens / msg.latencyMs / step sidebar 已经承载这部分信息，不应在 children 里再出现一次。
    cb.setSteps((prev) => [
      ...prev,
      { idx: m.step_idx, latencyMs: m.latency_ms, tokens: tok.completion_tokens ?? 0, tools: m.tool_calls_count || 0 },
    ]);
    if (tok.prompt_tokens != null) cb.setMetrics((mm) => ({ ...mm, prompt: tok.prompt_tokens }));
    if (tok.completion_tokens != null) cb.setMetrics((mm) => ({ ...mm, completion: tok.completion_tokens }));

    // #78：直接把 runId + 最新 metric 写到最近一条 assistant msg。
    // 用 cb.setMsgs 的 (prev) => ... 函数式更新，保证 immutable（不修改 prev）。
    //
    // cached 是 optional：只有 LLM 真的给了 cached_tokens（>0）才写这个字段，
    // 缺失或 0 都让 cached 不出现在 msg.tokens 上 —— UI 看到 undefined 就隐藏 pill，
    // 避免 0% 噪声。
    const update: {
      runId?: string;
      tokens?: { prompt: number; completion: number; cached?: number };
      latencyMs?: number;
    } = {};
    if (traceId) update.runId = traceId;
    if (typeof m.latency_ms === "number") {
      const tokensUpdate: { prompt: number; completion: number; cached?: number } = {
        prompt: typeof tok.prompt_tokens === "number" ? tok.prompt_tokens : 0,
        completion: typeof tok.completion_tokens === "number" ? tok.completion_tokens : 0,
      };
      // 只有 cached_tokens > 0 才写 cached 字段；缺失或 0 都跳过（让 UI 隐藏 pill）。
      if (typeof tok.cached_tokens === "number" && tok.cached_tokens > 0) {
        tokensUpdate.cached = tok.cached_tokens;
      }
      update.tokens = tokensUpdate;
      update.latencyMs = m.latency_ms;
    }
    if (Object.keys(update).length > 0) {
      cb.setMsgs((prev) => {
        for (let i = prev.length - 1; i >= 0; i--) {
          if (prev[i].role === "assistant") {
            const next = [...prev];
            next[i] = { ...next[i], ...update };
            return next;
          }
        }
        return prev;
      });
    }
  }

  private onFinal(cb: EngineCallbacks, sk: string, traceId?: string) {
    this.freezeText(cb, sk);
    this.freezeReasoning(cb, sk);
    const s = this.streamFor(sk);
    s.streaming = false;
    const total = now() - s.userSendTime;
    cb.setMetrics((m) => ({ ...m, total: Math.round(total) }));
    // #78：runId 已由 onMetric 直接写到 msg。这里 final 自带 trace_id 时**覆盖**——
    // 因为 final 是 run 终结的权威信号，server 通常会用跟 metric 一致的值，
    // 但若 server 重新生成（比如同一 turn 多个 metric 中间换 trace），final 的
    // 才是 run 真正的 ID。
    // 同时，无论是否有 traceId，都清除 pending（turn 结束，loading 必须消失）。
    cb.setMsgs((prev) => {
      for (let i = prev.length - 1; i >= 0; i--) {
        const m = prev[i];
        if (m.role !== "assistant") continue;
        const next = [...prev];
        next[i] = { ...m, pending: false, ...(traceId ? { runId: traceId } : {}) };
        return next;
      }
      return prev;
    });
    // 不再有 s.currentMetric = null —— 那个字段已删。
  }

  private onCard(cb: EngineCallbacks, sk: string, data: Record<string, any>) {
    this.freezeText(cb, sk);
    this.appendChild(cb, sk, {
      id: nextId(),
      kind: "note",
      text: "card · " + truncate(JSON.stringify(data), 200),
    });
  }

  private onError(cb: EngineCallbacks, sk: string, code: string, msg: string) {
    this.freezeText(cb, sk);
    this.freezeReasoning(cb, sk);
    this.appendChild(cb, sk, { id: nextId(), kind: "error", text: code + " — " + msg });
    cb.setStatus("error");
    // error 也是"终态"，loading 必须消失
    cb.setMsgs((prev) => {
      for (let i = prev.length - 1; i >= 0; i--) {
        const m = prev[i];
        if (m.role !== "assistant") continue;
        if (m.pending) {
          const next = [...prev];
          next[i] = { ...m, pending: false };
          return next;
        }
        break;
      }
      return prev;
    });
  }

  // ---- 结构性块列表变更 ----
  // setMsgs 由 cb 提供，cb 已按 dispatch / startTurn 的 sk 路由，写入 sessionStates[sk]。
  // #78：cb 是显式参数，不再读 this.cb —— engine 实例完全 stateless。

  private appendChild(cb: EngineCallbacks, sk: string, child: Child) {
    void sk; // 参数留作可读性标注（这条 child 属于哪个 session）
    cb.setMsgs((prev) => {
      const next = [...prev];
      const last = next[next.length - 1];
      if (last && last.role === "assistant") {
        // 首帧内容到达时清除 pending（loading 指示器）
        next[next.length - 1] = { ...last, pending: false, children: [...last.children, child] };
      }
      return next;
    });
  }

  private patchChild(cb: EngineCallbacks, sk: string, id: string, patch: Partial<Child>) {
    void sk;
    cb.setMsgs((prev) =>
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
  // 每个 stream 独立 scheduleFlush —— timer 也存到 stream 上，避免两个 session 互踩。

  private scheduleFlush(stream: PerSessionStream) {
    if (stream.flushTimer != null) return;
    stream.flushTimer = window.setTimeout(() => {
      stream.flushTimer = null;
      this.flush(stream);
    }, TICK_MS);
  }

  private flush(stream: PerSessionStream) {
    if (stream.reasoningEls) this.paintReasoning(stream);
    if (stream.assistantEl) this.paintText(stream);
    if (stream.scrollEl) stream.scrollRequest = true;
  }

  // reasoning 的 jitter buffer 渲染：按 90cps 固定速率从 queue 解锁字符，
  // 增量追加到 DOM（不再每次 innerHTML 全量重写），避免 burst 时一卡一卡。
  private paintReasoning(stream: PerSessionStream) {
    const body = stream.reasoningEls!.body;
    const t = now();

    // 初始化播放头
    if (stream.reasoningLastFlushAt === 0) stream.reasoningLastFlushAt = t;

    // 推进虚拟播放头（每 ms 推进 REASONING_CPS / 1000 chars）
    const dtMs = Math.max(0, t - stream.reasoningLastFlushAt);
    stream.reasoningLastFlushAt = t;

    // drain 过大的积压（模型太快时跳过等待）
    if (stream.reasoningQueue.length > 0) {
      const headLag = t - stream.reasoningQueue[0].arriveAt;
      if (headLag > MAX_BUFFER_MS) {
        // 把播放头追上最新到达的字符 + TARGET_BUFFER_MS 积压
        const latestArrive = stream.reasoningQueue[stream.reasoningQueue.length - 1].arriveAt;
        stream.reasoningLastFlushAt = latestArrive + TARGET_BUFFER_MS;
      }
    }

    // 每 tick 解锁 chars = dtMs * REASONING_CPS / 1000
    const charsToRelease = Math.floor((dtMs * REASONING_CPS) / 1000);
    let released = "";
    for (let i = 0; i < charsToRelease && stream.reasoningQueue.length > 0; i++) {
      released += stream.reasoningQueue.shift()!.ch;
    }

    if (released.length > 0) {
      // 增量写入：把新解锁的字符追加到 DOM
      const frag = document.createDocumentFragment();
      for (const ch of released) {
        const span = document.createElement("span");
        span.className = "ch fresh";
        span.textContent = ch;
        frag.appendChild(span);
        stream.freshSpans.push(span);
      }
      // 移除旧 caret，追加新内容
      const oldCaret = body.querySelector(".caret");
      if (oldCaret) oldCaret.remove();
      body.appendChild(frag);
      // 追加新 caret
      const c = document.createElement("span");
      c.className = "caret";
      body.appendChild(c);
      stream.reasoningPainted += released.length;
    }

    // 更新 meta
    const dur = now() - stream.reasoningStart;
    const meta = stream.reasoningEls!.head.querySelector(".meta");
    if (meta) meta.textContent = stream.reasoningBuf.length + " chars · " + fmtMs(dur);

    // 还有积压则继续 schedule
    if (stream.reasoningQueue.length > 0) this.scheduleFlush(stream);
  }

  private paintText(stream: PerSessionStream) {
    const el = stream.assistantEl;
    if (!el) return;
    if (!stream.streaming || stream.tokenBuf.length === 0) {
      // 流结束（被 freeze 调过）：最后一次渲染（一次性 innerHTML），DOM 收敛到稳定状态
      // 顺手把残留 caret 移除 —— 之前 appendCaret 让 caret 永远停在 DOM 末尾，
      // 流结束后还在闪烁（用户截图：assistant 文本流完后 caret 卡在中间位置）。
      this.consolidateFreshSpans(stream);
      el.innerHTML = renderMarkdown(stream.paintedBuf);
      return;
    }

    // 1) 推进虚拟播放头
    const t = now();
    if (stream.jbLastFlushAt === 0) stream.jbLastFlushAt = t;
    const dtMs = Math.max(0, t - stream.jbLastFlushAt);
    stream.jbLastFlushAt = t;
    stream.jbPlayhead += dtMs;

    // 2) 积压过大时跳过积压（drain）
    if (stream.jbQueue.length > 0) {
      const headLag = stream.jbPlayhead - stream.jbQueue[0].arriveAt;
      if (headLag > MAX_BUFFER_MS) {
        stream.jbPlayhead = stream.jbQueue[0].arriveAt + TARGET_BUFFER_MS;
      }
    }

    // 3) 消费 queue：每 tick 最多解锁 CHARS_PER_TICK 个字符
    let released = "";
    for (let i = 0; i < CHARS_PER_TICK && stream.jbQueue.length > 0 && stream.jbQueue[0].arriveAt <= stream.jbPlayhead; i++) {
      released += stream.jbQueue.shift()!.ch;
    }
    if (released.length === 0) {
      if (stream.jbQueue.length > 0) this.scheduleFlush(stream);
      return;
    }

    // 4) 累加到 paintedBuf
    stream.paintedBuf += released;
    stream.painted = stream.paintedBuf.length;

    // 5) 代理对守卫
    if (stream.painted > 0 && stream.paintedBuf.length > stream.painted) {
      const tail = stream.paintedBuf.charCodeAt(stream.painted - 1);
      if (tail >= 0xd800 && tail <= 0xdbff) {
        stream.painted--;
        stream.paintedBuf = stream.paintedBuf.slice(0, stream.painted);
        released = released.slice(0, released.length - 1);
      }
    }

    // 6) 单字淡入写入：每个新解锁的字符包成 span.ch.fresh，CSS animation 渐入
    this.appendFreshChars(stream, el, released);

    // 7) 旧 fresh span 动画结束后合并成文本节点，控制 DOM 大小
    this.mergeFinishedSpans(stream, el);

    if (stream.jbQueue.length > 0) this.scheduleFlush(stream);
  }

  // 把刚解锁的字符追加为 fresh span（带淡入动画）
  private appendFreshChars(stream: PerSessionStream, el: HTMLElement, chars: string) {
    if (!chars) return;
    const caret = el.querySelector(".caret");
    if (caret) caret.remove();

    const host = el.lastElementChild as HTMLElement | null;
    // 跨越 markdown 块边界（\n\n）→ 整段重渲
    if (/\n\n/.test(chars) || !host || host.tagName.toLowerCase() !== "p") {
      el.innerHTML = renderMarkdown(stream.paintedBuf);
      this.appendCaret(el);
      return;
    }
    // 普通段落内：每个字符一个 span.ch.fresh
    for (const ch of chars) {
      const span = document.createElement("span");
      span.className = "ch fresh";
      span.textContent = ch;
      host.appendChild(span);
      stream.freshSpans.push(span);
    }
    this.appendCaret(el);
  }

  // 把动画已结束的 fresh span 合并成文本节点（释放 DOM）
  // 通过 animationend 事件在每个 span 上处理更优雅，但简单起见用延迟合并：
  // 200ms 后（动画结束）所有未合并的 fresh span 一起合并。
  private mergeFinishedSpans(stream: PerSessionStream, el: HTMLElement) {
    if (stream.freshSpans.length === 0) return;
    if (stream.mergeTimer != null) return;
    stream.mergeTimer = window.setTimeout(() => {
      stream.mergeTimer = null;
      this.consolidateFreshSpans(stream);
    }, 220); // CSS animation ~180ms
  }

  private consolidateFreshSpans(stream: PerSessionStream) {
    if (stream.freshSpans.length === 0) return;
    // 找到 fresh span 的父节点（通常是 .stream > p），把每个 span 替换成 text node
    for (const span of stream.freshSpans) {
      if (!span.parentNode) continue;
      span.parentNode.replaceChild(document.createTextNode(span.textContent || ""), span);
    }
    stream.freshSpans = [];
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

  private freezeText(cb: EngineCallbacks, sk: string) {
    const s = this.streamFor(sk);
    if (s.curTextId != null && s.tokenBuf) {
      this.patchChild(cb, sk, s.curTextId, { text: s.tokenBuf });
    }
    s.curTextId = null;
    s.assistantEl = null;
    s.tokenBuf = "";
    s.painted = 0;
    s.paintedBuf = "";
    s.jbQueue = [];
    s.jbPlayhead = 0;
    s.jbLastFlushAt = 0;
    s.freshSpans = [];
    if (s.mergeTimer != null) { clearTimeout(s.mergeTimer); s.mergeTimer = null; }
    s.streaming = false;
  }

  private freezeReasoning(cb: EngineCallbacks, sk: string) {
    const s = this.streamFor(sk);
    if (s.curReasoningId != null && s.reasoningBuf) {
      this.patchChild(cb, sk, s.curReasoningId, { text: s.reasoningBuf });
    }
    s.curReasoningId = null;
    s.reasoningEls = null;
    s.reasoningBuf = "";
    s.reasoningStart = 0;
    s.reasoningQueue = [];
    s.reasoningPainted = 0;
    s.reasoningLastFlushAt = 0;
  }

  /** 外部触发一次「请滚到底」请求。
   *
   * 用法：App 启动时若 loadHistories() 已有内容（不是全新空会话），
   * 调用一次，使 Conversation 在 mount 后滚到最下方。
   * 后续 flush 也会自动触发，正常流式响应不被影响。
   */
  requestScrollToBottom(sessionKey: string) {
    // #78：必须由调用方显式传 sessionKey —— 不再有 this.activeSessionKey。
    // 不传 → 静默忽略（不再退回 __default__ 这种「猜默认」行为，避免误导）。
    if (!sessionKey) return;
    this.streamFor(sessionKey).scrollRequest = true;
  }
}