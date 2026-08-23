import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MonoDeskWS } from "./ws/client";
import {
  EMPTY_METRICS,
  StreamEngine,
  type Metrics,
  type Msg,
  type Step,
} from "./stream/engine";
import { fmtMs } from "./stream/markdown";
import type { MonoDeskEvent, StatusState } from "./ws/protocol";
import { Conversation } from "./components/Conversation";
import { Composer } from "./components/Composer";
import { SessionList, TopBar } from "./components/Chrome";
import { TraceDrawer } from "./components/TraceDrawer";
import { TraceClient } from "./observability/client";
import {
  buildSessionRoutedSetters,
  type SessionState,
} from "./stream/session_router";
import {
  DEFAULT_SESSION_KEY,
  MAX_SESSIONS,
  loadActiveSession,
  loadHistories,
  loadSessions,
  newSession,
  saveActiveSession,
  saveHistories,
  saveSessions,
  type SessionItem,
} from "./store/sessions";

const WS_URL = (import.meta.env.VITE_WS_URL as string) ?? "ws://127.0.0.1:8765";
const DEBUG_URL =
  (import.meta.env.VITE_DEBUG_URL as string) ?? "http://127.0.0.1:8768";

// 0..1 → "XX.X%"（status bar 用）
function fmtPct(x: number): string {
  return (x * 100).toFixed(1) + "%";
}

// ---- 底部状态栏：把 telemetry 压缩成一行 ----

function StatusBar({
  connected,
  model,
  metrics,
  sessionCache,
  onReconnect,
}: {
  connected: boolean;
  model: string;
  metrics: Metrics;
  // 本次对话所有 assistant msg 的累计 prompt cache 命中率（按 token 数加权）。
  // 没数据 → null（不显示，避免 0.0% 噪声）。
  sessionCache: { ratio: number; prompt: number; cached: number } | null;
  onReconnect: () => void;
}) {
  const m: string[] = [];
  if (metrics.ttft != null) m.push("TTFT " + metrics.ttft + "ms");
  if (metrics.tps != null) m.push(metrics.tps + " tok/s");
  if (metrics.total != null) m.push(fmtMs(metrics.total));
  if (metrics.prompt != null || metrics.completion != null) {
    m.push((metrics.prompt ?? "?") + "/" + (metrics.completion ?? "?") + " tok");
  }
  if (sessionCache) {
    // 加权平均：sum(cached) / sum(prompt)，比单纯平均每个 turn 的 ratio 更准
    // （小 turn 不会过度影响大 turn 的命中率）。
    m.push("⚡ " + fmtPct(sessionCache.ratio) + " cache");
  }
  return (
    <footer id="statusbar">
      <div
        className={"sb-left" + (connected ? "" : " reconnect")}
        onClick={() => !connected && onReconnect()}
        title={connected ? undefined : "offline — click to reconnect"}
      >
        <span className={"sb-dot" + (connected ? " on" : "")} />
        <span>{connected ? "connected" : "offline · reconnect"}</span>
        {model && <span>· {model}</span>}
      </div>
      <div className="sb-right">{m.length ? m.join(" · ") : "ready"}</div>
    </footer>
  );
}

// ---- Per-session 状态 ----
//
// 所有「运行时」状态（status / metrics / steps / model / msgs）都按
// sessionKey 索引到一张 Map；视图状态从 active session 的 entry 派生。
//
// 设计原则：避免「全局状态 + 手动同步」的状态机；每个 session 一份独立 Map entry，
// 切会话时 derive 即可，不需要任何手动清理 / 重置。
//
// `connected` 是 WS 物理连接状态，与会话无关；保留全局。
//
// App 用到的具体类型（Msg / Metrics / Step / StatusState）在 engine.ts / protocol.ts 里；
// 这里只是为了和 session_router 对齐，用 EMPTY_METRICS 填初始值。SessionState 的 schema
// 由 router 统一管理（setter 按字段写单 key），App 负责把这些字段转成本地类型。
const EMPTY_SESSION_STATE = {
  msgs: [] as Msg[],
  status: "idle" as StatusState,
  metrics: EMPTY_METRICS,
  steps: [] as Step[],
  model: "",
} satisfies Omit<SessionState, never>;

function loadSessionStates(): Record<string, typeof EMPTY_SESSION_STATE> {
  // 把 localStorage 的历史灌进 SessionState（其它字段用 default）。
  const histories = loadHistories();
  const out: Record<string, typeof EMPTY_SESSION_STATE> = {};
  for (const [k, msgs] of Object.entries(histories)) {
    out[k] = { ...EMPTY_SESSION_STATE, msgs: msgs as Msg[] };
  }
  return out;
}

export default function App() {
  const [connected, setConnected] = useState(false);
  const [session, setSession] = useState<string>(() => loadActiveSession());
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [turnStartAt, setTurnStartAt] = useState(0);
  const [sessions, setSessions] = useState<SessionItem[]>(() => loadSessions());
  // 所有会话运行时状态都在这张 Map 里。视图状态完全 derive。
  const [sessionStates, setSessionStates] = useState<Record<string, SessionState>>(
    () => loadSessionStates()
  );

  // 路由策略：每个 WS event 都带 data.session_key（来自 MonoX RuntimeServer），
  // 引擎按这个 key 把 callback 写到对应 sessionStates entry。**不再**用全局
  // ref 跟踪「当前在看哪个 session」来猜测 —— 那是之前出 bug 的根因。

  const engineRef = useRef<StreamEngine>();
  if (!engineRef.current) {
    // 引擎 callback 全部按 event.data.session_key 路由到对应 session entry。
    // 关键简化：setter 写「单字段更新」，不关心 key —— 路由由 router 统一负责。
    //
    // router 是 (sessionKey) => EngineCallbacks 的纯函数。engine 在 dispatch()
    // 里读 ev.data.session_key 调 router 拿到本帧要用的 callbacks。
    // startTurn / pauseStream 由 App 主动调用，需显式传入 sessionKey（因为
    // 它们不在 dispatch 路径上）。
    const router = (sessionKey: string) => {
      const routed = buildSessionRoutedSetters(
        (updater) => setSessionStates((s) => updater(s as Record<string, SessionState>)),
        () => sessionKey, // 闭包内固定到本 session —— 路由由 router 负责
        EMPTY_SESSION_STATE as unknown as SessionState
      );
      return {
        // router 的 Setter<K> 是 any-typed，转成 StreamEngine 期望的强类型签名。
        setMsgs: routed.msgs as any,
        setStatus: routed.status as any,
        setMetrics: routed.metrics as any,
        setSteps: routed.steps as any,
        setModel: routed.model as any,
        setConnected, // 全局，不分 session
      };
    };
    engineRef.current = new StreamEngine(router);
  }
  const engine = engineRef.current;

  // 视图状态完全 derive：active session 没 entry 就是空 default，
  // 绝不可能拿到上一个会话的内容。
  const view = sessionStates[session] ?? EMPTY_SESSION_STATE;
  const viewMsgs: Msg[] = view.msgs;
  const status: StatusState = view.status as StatusState;
  const metrics: Metrics = view.metrics as Metrics;
  const steps: Step[] = view.steps;
  const model: string = view.model;

  // 本 session 累计 prompt cache 命中率（按 token 数加权）。
  // 只在 msg.tokens.cached > 0 时计入（缺字段 / 0 都不算，避免 0.0% 噪声）。
  // 没数据 → null，UI 不显示 ⚡。
  const sessionCache = useMemo(() => {
    let prompt = 0, cached = 0;
    for (const m of viewMsgs) {
      if (m.role !== "assistant") continue;
      if (!m.tokens || typeof m.tokens.cached !== "number") continue;
      if (m.tokens.cached <= 0) continue;
      prompt += m.tokens.prompt;
      cached += m.tokens.cached;
    }
    return prompt > 0 ? { ratio: cached / prompt, prompt, cached } : null;
  }, [viewMsgs]);

  const wsRef = useRef<MonoDeskWS>();

  // Trace 抽屉状态：点击 assistant 旁的 trace 按钮 → 打开 drawer 拉取 run。
  const [inspectRunId, setInspectRunId] = useState<string | null>(null);
  const traceClientRef = useRef<TraceClient>();
  if (!traceClientRef.current) traceClientRef.current = TraceClient.shared(DEBUG_URL);
  const onInspectRun = useCallback((id: string) => setInspectRunId(id), []);
  const onCloseDrawer = useCallback(() => setInspectRunId(null), []);
  useEffect(() => {
    // HMR / Fast Refresh 会在每次文件改动时卸载并重新跑 effect，
    // 这会关闭老 WS、再建一个新 WS。后端日志会看到高频「connection open / close」。
    // 修复：dev 模式下把 WS 挂在 window 上，跨 HMR 复用同一实例。
    const w = window as unknown as { __monodeskWs?: MonoDeskWS };
    if (import.meta.env.DEV && w.__monodeskWs) {
      wsRef.current = w.__monodeskWs;
      // HMR 重新挂载时，重新接 engine / setConnected，否则旧 callback 指向旧 setState
      w.__monodeskWs.rebind({
        onEvent: (ev: MonoDeskEvent) => engine.dispatch(ev),
        onConnectionChange: (open: boolean) => setConnected(open),
      });
      return;
    }
    const ws = new MonoDeskWS(WS_URL, {
      onEvent: (ev) => engine.dispatch(ev),
      onConnectionChange: (open) => setConnected(open),
    });
    ws.connect();
    wsRef.current = ws;
    if (import.meta.env.DEV) w.__monodeskWs = ws;
    return () => {
      // dev HMR：保留实例不关；prod：组件卸载时正常关闭
      if (!import.meta.env.DEV) ws.close();
    };
  }, [engine]);

  // prod 真正卸载（页面关闭）时清掉 window 引用（dev 永不卸载就不需要）
  useEffect(() => {
    return () => {
      if (!import.meta.env.DEV) {
        (window as any).__monodeskWs = undefined;
      }
    };
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      const copy = t.closest?.(".codeblock .copy") as HTMLElement | null;
      if (!copy) return;
      const code = copy.closest(".codeblock")?.querySelector("code")?.innerText || "";
      navigator.clipboard?.writeText(code);
      const o = copy.textContent;
      copy.textContent = "copied";
      setTimeout(() => {
        copy.textContent = o;
      }, 900);
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);

  // 持久化：每个 session 只存 msgs。其它运行态字段（status / metrics / steps / model）
  // 都是从 server 流过来的「临时态」，重启后用 default 即可，没必要写入 localStorage。
  useEffect(() => {
    const histories = Object.fromEntries(
      Object.entries(sessionStates).map(([k, v]) => [k, v.msgs])
    );
    saveHistories(histories);
  }, [sessionStates]);

  const running = status === "thinking" || status === "tooling" || status === "compressing";

  const onSend = (text: string) => {
    setTurnStartAt(performance.now());
    // 不打断 Runtime：Runtime 的 LoopEngine 在每个 turn 开始时会 drain input_queue，
    // 把新进来的 user_input 聚合到 messages 后再调 LLM。当前 turn 跑完后下一轮
    // 会自动处理这条（用户连续发多条时模型能看到完整上下文）。
    //
    // startTurn 需要 sessionKey —— App 知道这条 user_input 进哪个 session。
    engine.startTurn(text, session);
    wsRef.current?.send({ type: "user_input", data: { text, session_key: session } });
  };

  const onStop = () => {
    // MonoX 的 LoopEngine 收到 interrupt 后会停在该 session 等待下一轮。
    // interrupt 现在不带 session_key（wire 协议约定），MonoX 端按 default_session_key
    // 解释 —— 跨 session 中断需要后续协议升级，#73 阶段先保留现状。
    wsRef.current?.send({ type: "interrupt", data: {} });
  };

  // 切会话：视图状态从 sessionStates derive，新会话没 entry 就是 EMPTY_SESSION_STATE
  // （status="idle", msgs=[], metrics=空），所以「切到新会话残留 compressing」这类
  // bug 在结构上就不可能存在 —— 不需要任何手动 reset 逻辑。
  const switchSession = (key: string) => {
    if (key === session) return;
    // 冻结 OLD session 的流（不是新 session —— 旧 session 的 token/reasoning
    // 还要写回去）。session 仍是「当前 active」的那个，因为 setSession 还没跑。
    engine.pauseStream(session);
    setSession(key);
    saveActiveSession(key);
  };

  const onSelectSession = (key: string) => {
    if (key === session) return;
    switchSession(key);
  };

  const onCreateSession = () => {
    if (sessions.length >= MAX_SESSIONS) return; // 达上限，UI 侧卡住
    const created = newSession();
    const next = [...sessions, created];
    setSessions(next);
    saveSessions(next);
    switchSession(created.key); // 新 session 没 entry → derive 出空状态
  };

  const onDeleteSession = (key: string) => {
    if (key === DEFAULT_SESSION_KEY) return; // 主会话不可删
    const next = sessions.filter((s) => s.key !== key);
    setSessions(next);
    saveSessions(next);
    setSessionStates((s) => {
      const { [key]: _drop, ...rest } = s;
      return rest;
    });
    if (key === session) switchSession(DEFAULT_SESSION_KEY);
  };

  const onReconnect = () => {
    wsRef.current?.reconnect();
  };

  return (
    <div id="app">
      <SessionList
        sessions={sessions}
        activeKey={session}
        onSelect={onSelectSession}
        onCreate={onCreateSession}
        onDelete={onDeleteSession}
        canCreate={sessions.length < MAX_SESSIONS}
      />
      <div id="main-col">
        <TopBar
          theme={theme}
          onToggleTheme={() => setTheme((t) => (t === "light" ? "dark" : "light"))}
        />
        <div id="body">
          <Conversation
            sessionKey={session}
            msgs={viewMsgs}
            engine={engine}
            onSend={onSend}
            onInspectRun={onInspectRun}
          />
          <Composer
            running={running}
            status={status}
            model={model}
            turnStartAt={turnStartAt}
            onSend={onSend}
            onStop={onStop}
          />
        </div>
        <StatusBar connected={connected} model={model} metrics={metrics} sessionCache={sessionCache} onReconnect={onReconnect} />
        <TraceDrawer
          runId={inspectRunId}
          sessionKey={session}
          client={traceClientRef.current}
          onClose={onCloseDrawer}
        />
      </div>
    </div>
  );
}
