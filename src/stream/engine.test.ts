// StreamEngine 单测：metric / final 携带的 trace_id 必须写到最近一条 assistant Msg。
//
// 关键路径：trace_id 进来到 wait_io 是一次 run；点击 assistant 回复可以看到那一次 run 的 tree。
// 所以 final 事件里携带的 trace_id 必须写到该 turn 对应的 assistant Msg.runId，按钮才能 fetch 到。
//
// #73: 引擎按 event.data.session_key 路由到 per-session callbacks。每个测试
// session 维护独立 state，所以跨 session 串扰可以直接断言。

import { describe, expect, it, vi } from "vitest";
import { StreamEngine, type Msg, type Metrics, type Step, type EngineCallbacks } from "./engine";
import type { MonoDeskEvent, StatusState } from "../ws/protocol";

type Setters = {
  msgs: Msg[];
  status: StatusState;
  metrics: Metrics;
  steps: Step[];
  model: string;
  availableProviders: string[];
  connected: boolean;
};

function makeEmptySetters(): Setters {
  return {
    msgs: [],
    status: "idle",
    metrics: { ttft: null, total: null, tps: null, prompt: null, completion: null },
    steps: [],
    model: "",
    availableProviders: [],
    connected: false,
  };
}

/** Build a router that maintains per-session state, plus shared connected state. */
function makeCallbacks(defaultKey = "s1") {
  const perSession = new Map<string, Setters>();
  const shared = { connected: false };
  const ensure = (key: string): Setters => {
    let s = perSession.get(key);
    if (!s) {
      s = makeEmptySetters();
      perSession.set(key, s);
    }
    return s;
  };
  const router = (key: string): EngineCallbacks => {
    const s = ensure(key);
    return {
      setMsgs: (v) => {
        s.msgs = typeof v === "function" ? (v as any)(s.msgs) : v;
      },
      setStatus: (v) => {
        s.status = typeof v === "function" ? (v as any)(s.status) : v;
      },
      setMetrics: (v) => {
        s.metrics = typeof v === "function" ? (v as any)(s.metrics) : v;
      },
      setSteps: (v) => {
        s.steps = typeof v === "function" ? (v as any)(s.steps) : v;
      },
      setModel: (v) => {
        s.model = typeof v === "function" ? (v as any)(s.model) : v;
      },
      setAvailableProviders: (v) => {
        s.availableProviders = typeof v === "function" ? (v as any)(s.availableProviders) : v;
      },
      setConnected: (v) => {
        shared.connected = typeof v === "function" ? (v as any)(shared.connected) : v;
      },
    };
  };
  return {
    router,
    state: ensure(defaultKey),
    stateOf: (k: string) => ensure(k),
    connected: shared,
  };
}

describe("StreamEngine trace_id capture", () => {
  it("writes runId from final.trace_id to the most recent assistant Msg", () => {
    const { router, state } = makeCallbacks();
    const engine = new StreamEngine(router);

    // 模拟 user 发送 → startTurn 产生 user + assistant 两条 Msg
    engine.dispatch({ type: "hello", data: { session_key: "s1", model: "m1" } });
    engine.startTurn("hi", "s1");

    // 模拟服务端发一系列事件
    engine.dispatch({ type: "status", data: { session_key: "s1", state: "thinking" } });
    engine.dispatch({ type: "token", data: { session_key: "s1", text: "hello" } });
    engine.dispatch({ type: "status", data: { session_key: "s1", state: "wait_io" } });
    engine.dispatch({
      type: "final",
      data: { session_key: "s1", text: "hello", metrics: {}, trace_id: "t_abc" },
    });

    const last = state.msgs[state.msgs.length - 1];
    expect(last.role).toBe("assistant");
    expect((last as Extract<Msg, { role: "assistant" }>).runId).toBe("t_abc");
  });

  it("captures trace_id from metric first, then final confirms it", () => {
    const { router, state } = makeCallbacks();
    const engine = new StreamEngine(router);

    engine.startTurn("hi", "s1");
    engine.dispatch({
      type: "metric",
      data: { session_key: "s1", metrics: { step_idx: 1, latency_ms: 100, tokens: { completion_tokens: 5 } }, trace_id: "t_metric", turn_id: "u_1" },
    });
    engine.dispatch({
      type: "final",
      data: { session_key: "s1", text: "done", metrics: {}, trace_id: "t_final" },
    });

    const last = state.msgs[state.msgs.length - 1];
    // final.trace_id 优先（更具体）；metric 阶段可能先有，但 final 一般会带一致的值
    expect((last as Extract<Msg, { role: "assistant" }>).runId).toBe("t_final");
  });

  it("falls back to metric.trace_id when final lacks trace_id", () => {
    const { router, state } = makeCallbacks();
    const engine = new StreamEngine(router);

    engine.startTurn("hi", "s1");
    engine.dispatch({
      type: "metric",
      data: { session_key: "s1", metrics: { step_idx: 1, latency_ms: 100 }, trace_id: "t_metric" },
    });
    engine.dispatch({
      type: "final",
      data: { session_key: "s1", text: "done", metrics: {} }, // 没有 trace_id
    });

    const last = state.msgs[state.msgs.length - 1];
    expect((last as Extract<Msg, { role: "assistant" }>).runId).toBe("t_metric");
  });

  it("leaves runId null when neither metric nor final carry trace_id", () => {
    const { router, state } = makeCallbacks();
    const engine = new StreamEngine(router);

    engine.startTurn("hi", "s1");
    engine.dispatch({ type: "status", data: { session_key: "s1", state: "thinking" } });
    engine.dispatch({ type: "final", data: { session_key: "s1", text: "done", metrics: {} } });

    const last = state.msgs[state.msgs.length - 1];
    expect((last as Extract<Msg, { role: "assistant" }>).runId ?? null).toBe(null);
  });

  it("resetTurn() clears currentRunId so next run starts fresh", () => {
    const { router, state } = makeCallbacks();
    const engine = new StreamEngine(router);

    // 第一轮：写 runId
    engine.startTurn("a", "s1");
    engine.dispatch({ type: "final", data: { session_key: "s1", text: "ok", metrics: {}, trace_id: "t_1" } });
    const first = state.msgs[state.msgs.length - 1];
    expect((first as Extract<Msg, { role: "assistant" }>).runId).toBe("t_1");

    // 第二轮：没有 trace_id → runId 应该是 null 而非复用 t_1
    engine.startTurn("b", "s1");
    engine.dispatch({ type: "final", data: { session_key: "s1", text: "ok", metrics: {} } });
    const second = state.msgs[state.msgs.length - 1];
    expect((second as Extract<Msg, { role: "assistant" }>).runId ?? null).toBe(null);
  });

  it("writes runId to the correct assistant when multiple are present", () => {
    const { router, state } = makeCallbacks();
    const engine = new StreamEngine(router);

    engine.startTurn("a", "s1");
    engine.dispatch({ type: "final", data: { session_key: "s1", text: "ok", metrics: {}, trace_id: "t_1" } });
    engine.startTurn("b", "s1");
    engine.dispatch({ type: "final", data: { session_key: "s1", text: "ok", metrics: {}, trace_id: "t_2" } });

    // 至少 4 条 Msg: [user-a, assistant-a, user-b, assistant-b]
    expect(state.msgs.length).toBeGreaterThanOrEqual(4);
    const last = state.msgs[state.msgs.length - 1];
    expect((last as Extract<Msg, { role: "assistant" }>).runId).toBe("t_2");

    // 找前一个 assistant 验证它仍然是 t_1
    const prevAssistant = [...state.msgs].reverse().find((m) => m.role === "assistant" && m !== last);
    expect(prevAssistant).toBeDefined();
    expect((prevAssistant as Extract<Msg, { role: "assistant" }>).runId).toBe("t_1");
  });

  it("writes inline tokens + latencyMs from latest metric to assistant Msg on final", () => {
    // #70: agent label 下方显示 "X tok · Yms · ⚡ Z% · [trace]"，
    // 数据来源：final 之前最后一条 MetricChunk 的 tokens + latency_ms。
    const { router, state } = makeCallbacks();
    const engine = new StreamEngine(router);

    engine.startTurn("hi", "s1");
    engine.dispatch({ type: "status", data: { session_key: "s1", state: "thinking" } });
    engine.dispatch({ type: "token", data: { session_key: "s1", text: "hello" } });
    // 第一条 metric：3000 tok prompt, 200 completion, 2400 cached, 800ms
    engine.dispatch({
      type: "metric",
      data: {
        session_key: "s1",
        metrics: { step_idx: 1, latency_ms: 800, tokens: { prompt_tokens: 3000, completion_tokens: 200, cached_tokens: 2400 } },
        trace_id: "t_1",
        turn_id: "u_1",
      },
    });
    // 第二条 metric：最后一个 turn 的数据 → 应该被采纳
    engine.dispatch({
      type: "metric",
      data: {
        session_key: "s1",
        metrics: { step_idx: 2, latency_ms: 412, tokens: { prompt_tokens: 3500, completion_tokens: 80, cached_tokens: 3000 } },
        trace_id: "t_1",
        turn_id: "u_2",
      },
    });
    engine.dispatch({ type: "status", data: { session_key: "s1", state: "wait_io" } });
    engine.dispatch({
      type: "final",
      data: { session_key: "s1", text: "hello", metrics: {}, trace_id: "t_1" },
    });

    const last = state.msgs[state.msgs.length - 1];
    expect(last.role).toBe("assistant");
    const m = last as Extract<Msg, { role: "assistant" }>;
    expect(m.tokens).toEqual({ prompt: 3500, completion: 80, cached: 3000 });
    expect(m.latencyMs).toBe(412);
    expect(m.runId).toBe("t_1");
  });

  it("writes metric even when final lacks trace_id", () => {
    const { router, state } = makeCallbacks();
    const engine = new StreamEngine(router);

    engine.startTurn("hi", "s1");
    engine.dispatch({ type: "metric", data: { session_key: "s1", metrics: { step_idx: 1, latency_ms: 100, tokens: { prompt_tokens: 100, completion_tokens: 10, cached_tokens: 50 } }, trace_id: "t_m" } });
    engine.dispatch({ type: "final", data: { session_key: "s1", text: "done", metrics: {} } });

    const last = state.msgs[state.msgs.length - 1] as Extract<Msg, { role: "assistant" }>;
    expect(last.tokens).toEqual({ prompt: 100, completion: 10, cached: 50 });
    expect(last.latencyMs).toBe(100);
    expect(last.runId).toBe("t_m"); // 来自 metric 阶段
  });

  it("omits cached field when LLM reports cached_tokens=0 (avoids 0% UI noise)", () => {
    // MiniMax 实测：cache miss 时 cached_tokens=0 仍会出现。engine 不能把这个 0 写到 msg.tokens.cached，
    // 否则 UI 会显示 ⚡ 0.0% 噪声。应当**省略** cached 字段。
    const { router, state } = makeCallbacks();
    const engine = new StreamEngine(router);

    engine.startTurn("hi", "s1");
    engine.dispatch({
      type: "metric",
      data: {
        session_key: "s1",
        metrics: { step_idx: 1, latency_ms: 100, tokens: { prompt_tokens: 500, completion_tokens: 30, cached_tokens: 0 } },
      },
    });
    engine.dispatch({ type: "final", data: { session_key: "s1", text: "done", metrics: {} } });

    const last = state.msgs[state.msgs.length - 1] as Extract<Msg, { role: "assistant" }>;
    // tokens 应该只有 prompt/completion，没有 cached 字段
    expect(last.tokens).toEqual({ prompt: 500, completion: 30 });
    expect("cached" in (last.tokens ?? {})).toBe(false);
  });

  it("omits cached field when LLM did not report cached_tokens at all", () => {
    // MiniMax 实测：< 512 token prompt / cache build-up 阶段的 usage chunk 完全不带
    // prompt_tokens_details.cached_tokens 字段。engine 应当**省略** cached，
    // 而不是强行写 0（避免 UI 显示 0.0%）。
    const { router, state } = makeCallbacks();
    const engine = new StreamEngine(router);

    engine.startTurn("hi", "s1");
    engine.dispatch({
      type: "metric",
      data: {
        session_key: "s1",
        metrics: { step_idx: 1, latency_ms: 100, tokens: { prompt_tokens: 200, completion_tokens: 30 } },
        // 没有 cached_tokens
      },
    });
    engine.dispatch({ type: "final", data: { session_key: "s1", text: "done", metrics: {} } });

    const last = state.msgs[state.msgs.length - 1] as Extract<Msg, { role: "assistant" }>;
    expect(last.tokens).toEqual({ prompt: 200, completion: 30 });
    expect("cached" in (last.tokens ?? {})).toBe(false);
  });

  it("resets currentMetric on startTurn so previous run's tokens don't leak", () => {
    const { router, state } = makeCallbacks();
    const engine = new StreamEngine(router);

    // 第一轮：写 tokens
    engine.startTurn("a", "s1");
    engine.dispatch({ type: "metric", data: { session_key: "s1", metrics: { step_idx: 1, latency_ms: 100, tokens: { prompt_tokens: 100, completion_tokens: 10, cached_tokens: 80 } } } });
    engine.dispatch({ type: "final", data: { session_key: "s1", text: "ok", metrics: {} } });
    const first = state.msgs[state.msgs.length - 1] as Extract<Msg, { role: "assistant" }>;
    expect(first.tokens).toEqual({ prompt: 100, completion: 10, cached: 80 });

    // 第二轮：没 metric，直接 final → tokens 应该是 null（没数据），不能复用上轮的
    engine.startTurn("b", "s1");
    engine.dispatch({ type: "final", data: { session_key: "s1", text: "ok", metrics: {} } });
    const second = state.msgs[state.msgs.length - 1] as Extract<Msg, { role: "assistant" }>;
    expect(second.tokens ?? null).toBe(null);
    expect(second.latencyMs ?? null).toBe(null);
  });
});

describe("StreamEngine per-session isolation (#73 + #74)", () => {
  // #73 修了 callback 路由：每个事件自带 session_key，引擎按它写到对应 sessionStates
  // entry —— 解决「late event 写到错会话」的现象（status / msgs / metrics）。
  //
  // #74 修了 buffer 路由：tokenBuf / curTextId / jbQueue / currentRunId / currentMetric
  // 等所有运行时缓冲也按 sessionKey 隔离到 PerSessionStream Map —— 解决「并发流串
  // buffer」（Chat 13 的 agent 回复表格里混着 Default 的「你好！很高兴见到你！」）。
  // 之前这些字段是 this.X 全局共享，A 没流完就切 B 发 → A 的 token 写进 B 的 buffer。
  //
  // 这组测试用 makeCallbacks() 的 router 按 key 隔离 sessionStates，再用 freeze 后
  // Child.text 的内容 / final 后 Msg.runId 来验证 buffer / trace_id 也是 per-session 的。
  it("routes token / status / metric to the event's session_key entry, never to others", () => {
    const { router, stateOf } = makeCallbacks();
    const engine = new StreamEngine(router);

    // 用户先在 A 发，A 流完一轮
    engine.startTurn("a-msg", "A");
    engine.dispatch({ type: "status", data: { session_key: "A", state: "thinking" } });
    engine.dispatch({ type: "token", data: { session_key: "A", text: "A's reply" } });
    engine.dispatch({ type: "final", data: { session_key: "A", text: "A done", metrics: {}, trace_id: "t_a" } });

    // 用户切到 B 发，B 流完一轮
    engine.startTurn("b-msg", "B");
    engine.dispatch({ type: "status", data: { session_key: "B", state: "thinking" } });
    engine.dispatch({ type: "token", data: { session_key: "B", text: "B's reply" } });
    engine.dispatch({ type: "final", data: { session_key: "B", text: "B done", metrics: {}, trace_id: "t_b" } });

    // late event：A 的 reply 实际 late 才到 —— 应该写到 A 不写 B
    engine.dispatch({ type: "token", data: { session_key: "A", text: " A-more" } });

    const a = stateOf("A");
    const b = stateOf("B");

    // A 应该有 final 写入了 runId t_a
    const aLast = a.msgs[a.msgs.length - 1] as Extract<Msg, { role: "assistant" }>;
    expect(aLast.runId).toBe("t_a");
    // B 应该有 B 自己的 runId t_b（绝不可能是 t_a）
    const bLast = b.msgs[b.msgs.length - 1] as Extract<Msg, { role: "assistant" }>;
    expect(bLast.runId).toBe("t_b");

    // msgs 数量也独立：A 是 [user, assistant]，B 是 [user, assistant]
    expect(a.msgs).toHaveLength(2);
    expect(b.msgs).toHaveLength(2);

    // A 的 user msg 是 a-msg，B 的 user msg 是 b-msg
    expect((a.msgs[0] as Extract<Msg, { role: "user" }>).text).toBe("a-msg");
    expect((b.msgs[0] as Extract<Msg, { role: "user" }>).text).toBe("b-msg");
  });

  it("startTurn(text, sk) writes user+assistant pair to the named session only", () => {
    const { router, stateOf } = makeCallbacks();
    const engine = new StreamEngine(router);

    engine.startTurn("a-msg", "A");
    engine.startTurn("b-msg", "B");
    engine.startTurn("a-msg-2", "A");

    const a = stateOf("A");
    const b = stateOf("B");
    // A: [user-a-msg, assistant, user-a-msg-2, assistant]
    expect(a.msgs).toHaveLength(4);
    expect((a.msgs[0] as Extract<Msg, { role: "user" }>).text).toBe("a-msg");
    expect((a.msgs[2] as Extract<Msg, { role: "user" }>).text).toBe("a-msg-2");

    // B: [user-b-msg, assistant]
    expect(b.msgs).toHaveLength(2);
    expect((b.msgs[0] as Extract<Msg, { role: "user" }>).text).toBe("b-msg");
  });

  it("metrics / prompt_tokens / completion_tokens are isolated per session_key", () => {
    const { router, stateOf } = makeCallbacks();
    const engine = new StreamEngine(router);

    engine.dispatch({ type: "status", data: { session_key: "A", state: "thinking" } });
    engine.dispatch({ type: "status", data: { session_key: "B", state: "tooling" } });
    engine.dispatch({
      type: "metric",
      data: { session_key: "A", metrics: { step_idx: 1, latency_ms: 100, tokens: { prompt_tokens: 100, completion_tokens: 10 } } },
    });
    engine.dispatch({
      type: "metric",
      data: { session_key: "B", metrics: { step_idx: 2, latency_ms: 200, tokens: { prompt_tokens: 200, completion_tokens: 20 } } },
    });

    const a = stateOf("A");
    const b = stateOf("B");
    expect(a.status).toBe("thinking");
    expect(b.status).toBe("tooling");
    expect(a.metrics.prompt).toBe(100);
    expect(a.metrics.completion).toBe(10);
    expect(b.metrics.prompt).toBe(200);
    expect(b.metrics.completion).toBe(20);
  });

  // #74 修复验证：并发流式下 A 的 tokenBuf / B 的 tokenBuf 互不污染。
  // 验证方式：dispatch(token) 不调 freezeText，所以 child.text 不会被 patch；切到 final
  // （或 status=wait_io）触发 freezeText 时，那一帧的 child.text 应该只含本 session
  // 的 token 拼接，不含另一 session 的字符。
  //
  // 之前 tokenBuf 是 this.X 全局 → A 的 tokenBuf += "B1" → freeze 时 child.text 错位。
  it("concurrent token streams: each session's text child has only its own tokens after freeze", () => {
    const { router, stateOf } = makeCallbacks();
    const engine = new StreamEngine(router);

    // A 流一段 → startTurn + status(thinking) 让 turnOpen=true
    engine.startTurn("a", "A");
    engine.dispatch({ type: "status", data: { session_key: "A", state: "thinking" } });
    engine.dispatch({ type: "token", data: { session_key: "A", text: "A1" } });
    engine.dispatch({ type: "token", data: { session_key: "A", text: "A2" } });

    // B 流一段
    engine.startTurn("b", "B");
    engine.dispatch({ type: "status", data: { session_key: "B", state: "thinking" } });
    engine.dispatch({ type: "token", data: { session_key: "B", text: "B1" } });

    // late token 回到 A —— 之前这里会污染 B
    engine.dispatch({ type: "token", data: { session_key: "A", text: "A3" } });

    // 各自触发 freeze（用 status 切到 wait_io 走 freezeText 路径）
    engine.dispatch({ type: "status", data: { session_key: "A", state: "wait_io" } });
    engine.dispatch({ type: "status", data: { session_key: "B", state: "wait_io" } });

    const aLast = stateOf("A").msgs[stateOf("A").msgs.length - 1] as Extract<Msg, { role: "assistant" }>;
    const bLast = stateOf("B").msgs[stateOf("B").msgs.length - 1] as Extract<Msg, { role: "assistant" }>;
    // 测试环境下没有 DOM 绑定 → onToken 每次都新建 text child。freezeText 时 patch
    // 当前 curTextId（最后那个），所以取最后一个 text child 来断言。
    const aText = aLast.children.filter((c) => c.kind === "text").pop();
    const bText = bLast.children.filter((c) => c.kind === "text").pop();

    // A 的 tokenBuf 应该只有 A 的字符拼接，绝不含 B 的 "B1"
    expect(aText?.text).toBe("A1A2A3");
    expect(aText?.text).not.toContain("B");
    // B 的 tokenBuf 应该只有 B 的字符
    expect(bText?.text).toBe("B1");
    expect(bText?.text).not.toContain("A");
  });

  // #74 修复验证：currentRunId 按 session 隔离。
  // metric(A) → metric(B) → final(A) → final(B) 时，A 的 assistant.runId 是 t_a，
  // B 的 assistant.runId 是 t_b，互不串。之前 currentRunId 是 this.X 全局，
  // B 的 metric 后会覆盖 A 的 currentRunId，A 的 final 时拿到的是 t_b（错位）。
  it("interleaved metric/final keeps currentRunId per session", () => {
    const { router, stateOf } = makeCallbacks();
    const engine = new StreamEngine(router);

    engine.startTurn("a", "A");
    engine.startTurn("b", "B");

    // metric 交错到达 —— currentRunId 应按 sk 各自记录
    engine.dispatch({
      type: "metric",
      data: { session_key: "A", metrics: { step_idx: 1, latency_ms: 100 }, trace_id: "t_a" },
    });
    engine.dispatch({
      type: "metric",
      data: { session_key: "B", metrics: { step_idx: 1, latency_ms: 100 }, trace_id: "t_b" },
    });
    engine.dispatch({
      type: "metric",
      data: { session_key: "A", metrics: { step_idx: 2, latency_ms: 200 }, trace_id: "t_a" },
    });

    // final 也交错到达 —— A 的 final 应该拿到 A 的 runId，B 的 final 拿 B 的
    engine.dispatch({ type: "final", data: { session_key: "A", text: "A done", metrics: {} } });
    engine.dispatch({ type: "final", data: { session_key: "B", text: "B done", metrics: {} } });

    const aLast = stateOf("A").msgs[stateOf("A").msgs.length - 1] as Extract<Msg, { role: "assistant" }>;
    const bLast = stateOf("B").msgs[stateOf("B").msgs.length - 1] as Extract<Msg, { role: "assistant" }>;
    expect(aLast.runId).toBe("t_a");
    expect(bLast.runId).toBe("t_b");
  });

  // #74 修复验证：currentMetric 也按 session 隔离（A 的 latency_ms 不写到 B 的 assistant）。
  it("interleaved metric keeps currentMetric per session", () => {
    const { router, stateOf } = makeCallbacks();
    const engine = new StreamEngine(router);

    engine.startTurn("a", "A");
    engine.startTurn("b", "B");

    engine.dispatch({
      type: "metric",
      data: { session_key: "A", metrics: { step_idx: 1, latency_ms: 800, tokens: { prompt_tokens: 100, completion_tokens: 10 } } },
    });
    engine.dispatch({
      type: "metric",
      data: { session_key: "B", metrics: { step_idx: 1, latency_ms: 412, tokens: { prompt_tokens: 200, completion_tokens: 20 } } },
    });

    engine.dispatch({ type: "final", data: { session_key: "A", text: "A done", metrics: {} } });
    engine.dispatch({ type: "final", data: { session_key: "B", text: "B done", metrics: {} } });

    const aLast = stateOf("A").msgs[stateOf("A").msgs.length - 1] as Extract<Msg, { role: "assistant" }>;
    const bLast = stateOf("B").msgs[stateOf("B").msgs.length - 1] as Extract<Msg, { role: "assistant" }>;
    expect(aLast.latencyMs).toBe(800);
    // LLM 没报 cached_tokens → cached 字段省略（不写 0，避免 UI 0.0% 噪声）
    expect(aLast.tokens).toEqual({ prompt: 100, completion: 10 });
    expect(bLast.latencyMs).toBe(412);
    expect(bLast.tokens).toEqual({ prompt: 200, completion: 20 });
  });

  // #77: 模拟用户的实际场景 ——「切到有历史的会话 B 时，A 的 late token 不会
  // 污染 B 的 msgs」。Chat 14 已经有股票数据 → 切过去之后 Default 还在继续流
  // → Default 的 token 应该写到 Default，不能写到 Chat 14。
  //
  // 此前如果 callback / buffer 路由有任何一环用了「UI 当前看的 session」来兜底，
  // 切到 Chat 14 的瞬间 Default 的流还在继续，那些 token 就会被写到 Chat 14 的
  // msgs 里 —— 用户报告的「Chat 14 往上翻看到 Default 的内容」就是这个 bug。
  it("background-streaming session A's late tokens do not pollute session B's msgs (which has prior content)", () => {
    const { router, stateOf } = makeCallbacks();
    const engine = new StreamEngine(router);

    // 1) Chat 14（B）已经有上一轮的股票数据回复 —— 直接给 B 一个完整 round
    engine.startTurn("previous-stock-query", "B");
    engine.dispatch({ type: "status", data: { session_key: "B", state: "thinking" } });
    engine.dispatch({ type: "token", data: { session_key: "B", text: "STOCK-DATA-ROW" } });
    engine.dispatch({ type: "final", data: { session_key: "B", text: "STOCK-DATA-ROW", metrics: {}, trace_id: "t_b_prev" } });

    const bBefore = stateOf("B").msgs.slice();
    expect(bBefore).toHaveLength(2);
    expect((bBefore[0] as Extract<Msg, { role: "user" }>).text).toBe("previous-stock-query");
    expect((bBefore[1] as Extract<Msg, { role: "assistant" }>).children[0]).toMatchObject({
      kind: "text",
      text: "STOCK-DATA-ROW",
    });

    // 2) 用户切到 Default（A），Default 开始新的一轮流式
    engine.startTurn("default-query", "A");
    engine.dispatch({ type: "status", data: { session_key: "A", state: "thinking" } });
    engine.dispatch({ type: "token", data: { session_key: "A", text: "DEFAULT-REPLY-A1" } });

    // 3) 用户切到 Chat 14（B）—— 但 Default（A）的流还没完，late token 还会继续来
    //    关键断言：B 的 msgs 在「切会话时 + 切会话后」都不能有 A 的字符。
    const bBeforeSwitch = stateOf("B").msgs;
    const aBeforeSwitch = stateOf("A").msgs;

    engine.dispatch({ type: "token", data: { session_key: "A", text: "DEFAULT-REPLY-A2" } });
    engine.dispatch({ type: "token", data: { session_key: "A", text: "DEFAULT-REPLY-A3" } });

    // 4) 用户在 Chat 14（B）里发新消息，B 开始流式
    engine.startTurn("chat14-new-query", "B");
    engine.dispatch({ type: "status", data: { session_key: "B", state: "thinking" } });
    engine.dispatch({ type: "token", data: { session_key: "B", text: "CHAT14-NEW-REPLY" } });

    // 5) Default（A）的 late token 还在来 + B 的流也并行 —— 模拟两个 session 同时活跃
    engine.dispatch({ type: "token", data: { session_key: "A", text: "DEFAULT-REPLY-A4" } });
    engine.dispatch({ type: "token", data: { session_key: "B", text: "-MORE" } });

    // 6) 各自 final
    engine.dispatch({ type: "final", data: { session_key: "A", text: "A done", metrics: {}, trace_id: "t_a" } });
    engine.dispatch({ type: "final", data: { session_key: "B", text: "B done", metrics: {}, trace_id: "t_b_new" } });

    // ---- 断言 ----

    // A 的 msgs：A 是 [user-default-query, assistant-A] —— 只能有 A 自己的内容
    const aMsgs = stateOf("A").msgs;
    expect(aMsgs).toHaveLength(2);
    expect((aMsgs[0] as Extract<Msg, { role: "user" }>).text).toBe("default-query");
    const aLast = aMsgs[aMsgs.length - 1] as Extract<Msg, { role: "assistant" }>;
    expect(aLast.runId).toBe("t_a");
    // A 的 text child 拼起来必须只含 DEFAULT-REPLY-* —— 不含 STOCK-DATA / CHAT14-NEW
    const aTexts = aLast.children.filter((c) => c.kind === "text").map((c) => (c as any).text ?? "").join("");
    expect(aTexts).toContain("DEFAULT-REPLY");
    expect(aTexts).not.toContain("STOCK-DATA");
    expect(aTexts).not.toContain("CHAT14-NEW");

    // B 的 msgs：B 是 [user-prev, assistant-prev, user-new, assistant-new] —— 关键：
    // 不应该有 A 的字符 DEFAULT-REPLY 出现在 B 的任何 child text 里。
    const bMsgs = stateOf("B").msgs;
    expect(bMsgs).toHaveLength(4);
    expect((bMsgs[0] as Extract<Msg, { role: "user" }>).text).toBe("previous-stock-query");
    expect((bMsgs[2] as Extract<Msg, { role: "user" }>).text).toBe("chat14-new-query");
    const bNewLast = bMsgs[3] as Extract<Msg, { role: "assistant" }>;
    expect(bNewLast.runId).toBe("t_b_new");
    const bNewTexts = bNewLast.children.filter((c) => c.kind === "text").map((c) => (c as any).text ?? "").join("");
    expect(bNewTexts).toContain("CHAT14-NEW");
    expect(bNewTexts).not.toContain("DEFAULT-REPLY");

    // 旧 assistant（B 第一轮）的内容也不能被 A 的 token 改写
    const bPrevLast = bMsgs[1] as Extract<Msg, { role: "assistant" }>;
    const bPrevTexts = bPrevLast.children.filter((c) => c.kind === "text").map((c) => (c as any).text ?? "").join("");
    expect(bPrevTexts).toBe("STOCK-DATA-ROW");
    expect(bPrevTexts).not.toContain("DEFAULT-REPLY");

    // 关键：bBeforeSwitch（旧 B 的 msgs）和 bMsgs 应该共享前两个 msg 的 id 与 content。
    // 注意：不能要求严格的 .toBe 引用相等 —— 中间 dispatch(freezeText) / dispatch(final)
    // 会走 patchChild 的 prev.map(...) 路径，它对每个 assistant 生成 `{ ...m, ... }`，
    // 引用会换但内容不变。这是正常的不可变更新，不影响路由正确性。
    // 真正要紧的断言是：B 的 children 文本里绝对不能混入 A 的字符。
    expect(bBeforeSwitch[0].id).toBe(bMsgs[0].id);
    expect(bBeforeSwitch[1].id).toBe(bMsgs[1].id);
    expect(aBeforeSwitch[0].id).toBe(aMsgs[0].id);
    expect(aBeforeSwitch[1].id).toBe(aMsgs[1].id);
  });
});

describe("paintReasoning release rate (#polish)", () => {
  // #polish: REASONING_CPS 从 90 → 30，让 reasoning 走「字符打字机」节奏（~1 字/tick @ 33ms）。
  // 之前的 90 cps ≈ 2 字/tick 视觉上 burst，用户反馈「不是一字一字出来」。
  //
  // 测试策略：用 fake timer 跑 60 个 33ms tick，量 reasoningPainted 增量。
  // 60 ticks @ 33ms = 1980ms wall-clock；REASONING_CPS=30 → ~60 chars 释放。
  it("releases ~1 char per 33ms tick (REASONING_CPS=30)", () => {
    const { router } = makeCallbacks();
    const engine = new StreamEngine(router);

    // 先开 turn 并切到 thinking 状态
    engine.startTurn("hi", "s1");
    engine.dispatch({ type: "status", data: { session_key: "s1", state: "thinking" } });

    // 切到 fake timers —— 必须在 dispatch 之前，否则 scheduleFlush 的 setTimeout
    // 已经用真实 timer 排队了，fake advance 抓不到。
    vi.useFakeTimers();

    // 注入 ~80 字 reasoning —— queue 里 80 个字符 + 触发 scheduleFlush
    const text = "让我先看 core/channel/base.py 的协议，让我先看 core/channel/base.py 的协议，让";
    engine.dispatch({ type: "reasoning", data: { session_key: "s1", text } });

    // 取出 reasoning child id（curReasoningId）用于 bind —— bind 校验一致性
    const internal = engine as unknown as {
      streams: Map<string, {
        reasoningPainted: number;
        reasoningQueue: { ch: string }[];
        curReasoningId: string | null;
      }>;
    };
    const stream = internal.streams.get("s1")!;
    expect(stream).toBeDefined();
    const rid = stream.curReasoningId;
    expect(rid).toBeTruthy();

    // 用 jsdom 元素 bind reasoning DOM，让 paintReasoning 能跑
    const container = document.createElement("div");
    const head = document.createElement("div");
    const body = document.createElement("div");
    engine.bindReasoning("s1", { id: rid!, container, head, body });

    const before = stream.reasoningPainted;
    // 60 ticks @ 33ms ≈ 2s wall-clock；30 cps → ~60 chars
    for (let i = 0; i < 60; i++) {
      vi.advanceTimersByTime(33);
    }
    vi.useRealTimers();
    const after = stream.reasoningPainted;

    // 容忍 ±15 chars（首/尾 flush 边界、fake timer 跳变）。
    expect(after - before).toBeGreaterThan(45);
    expect(after - before).toBeLessThan(75);
    // 关键否定：如果退回到 90 cps，应释放 ~180 chars
    expect(after - before).toBeLessThan(120);
  });

  it("starts with empty queue and zero painted chars when no reasoning dispatched", () => {
    const { router } = makeCallbacks();
    const engine = new StreamEngine(router);
    engine.startTurn("hi", "s1");
    engine.dispatch({ type: "status", data: { session_key: "s1", state: "thinking" } });

    const internal = engine as unknown as {
      streams: Map<string, { reasoningPainted: number; reasoningQueue: unknown[] }>;
    };
    const stream = internal.streams.get("s1")!;
    expect(stream.reasoningQueue.length).toBe(0);
    expect(stream.reasoningPainted).toBe(0);
  });
});