import { useEffect, useRef, useState } from "react";
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

// ---- 底部状态栏：把 telemetry 压缩成一行 ----

function StatusBar({
  connected,
  model,
  metrics,
  onReconnect,
}: {
  connected: boolean;
  model: string;
  metrics: Metrics;
  onReconnect: () => void;
}) {
  const m: string[] = [];
  if (metrics.ttft != null) m.push("TTFT " + metrics.ttft + "ms");
  if (metrics.tps != null) m.push(metrics.tps + " tok/s");
  if (metrics.total != null) m.push(fmtMs(metrics.total));
  if (metrics.prompt != null || metrics.completion != null) {
    m.push((metrics.prompt ?? "?") + "/" + (metrics.completion ?? "?") + " tok");
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

export default function App() {
  const [status, setStatus] = useState<StatusState>("idle");
  const [metrics, setMetrics] = useState<Metrics>(EMPTY_METRICS);
  const [steps, setSteps] = useState<Step[]>([]);
  const [connected, setConnected] = useState(false);
  const [model, setModel] = useState("");
  const [session, setSession] = useState<string>(() => loadActiveSession());
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [turnStartAt, setTurnStartAt] = useState(0);
  const [sessions, setSessions] = useState<SessionItem[]>(() => loadSessions());
  const [histories, setHistories] = useState<Record<string, Msg[]>>(() => loadHistories());

  // 当前「流式」所属的会话。切视图不改变它，只在发消息（startTurn）时更新——
  // 这样会话1的 agent 还在后台跑时，它的 token 仍写回会话1，不会串到正在看的会话2。
  const streamKeyRef = useRef<string>(session);

  const engineRef = useRef<StreamEngine>();
  if (!engineRef.current) {
    engineRef.current = new StreamEngine({
      setMsgs: (updater) => {
        const key = streamKeyRef.current;
        setHistories((h) => {
          const prev = h[key] ?? [];
          const next = typeof updater === "function" ? updater(prev) : updater;
          return { ...h, [key]: next };
        });
      },
      setStatus,
      setMetrics,
      setSteps,
      setConnected,
      setModel,
    });
  }
  const engine = engineRef.current;

  // 视图：当前选中会话的 history。如果 histories 里还没这个 key（首次切到新会话），
  // 视为空数组，UI 走空状态；绝不退回到"上一个会话"的内容。
  const viewMsgs = histories[session] ?? [];

  const wsRef = useRef<MonoDeskWS>();
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

  // 历史一变就写 localStorage（每会话一份，切会话不丢）
  useEffect(() => {
    saveHistories(histories);
  }, [histories]);

  const running = status === "thinking" || status === "tooling" || status === "compressing";

  const onSend = (text: string) => {
    setTurnStartAt(performance.now());
    streamKeyRef.current = session;
    // 不打断 Runtime：Runtime 的 LoopEngine 在每个 turn 开始时会 drain input_queue，
    // 把新进来的 user_input 聚合到 messages 后再调 LLM。当前 turn 跑完后下一轮
    // 会自动处理这条（用户连续发多条时模型能看到完整上下文）。
    engine.startTurn(text);
    wsRef.current?.send({ type: "user_input", data: { text, session_key: session } });
  };

  const onStop = () => {
    wsRef.current?.send({ type: "interrupt", data: {} });
  };

  const switchSession = (key: string) => {
    if (key === session) return;
    engine.pauseStream(); // 把当前流式缓冲冻结写回所属会话
    // 流关闭 + 视图切换：避免新视图渲染出 stale 历史
    setHistories((h) => (h[key] ? h : { ...h, [key]: [] }));
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
    // 新会话：保证 histories[newKey] = []，避免渲染时拿到上一次的历史。
    setHistories((h) => (h[created.key] ? h : { ...h, [created.key]: [] }));
    switchSession(created.key);
  };

  const onDeleteSession = (key: string) => {
    if (key === DEFAULT_SESSION_KEY) return; // 主会话不可删
    const next = sessions.filter((s) => s.key !== key);
    setSessions(next);
    saveSessions(next);
    setHistories((h) => {
      const { [key]: _drop, ...rest } = h;
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
          <Conversation msgs={viewMsgs} engine={engine} onSend={onSend} />
          <Composer
            running={running}
            status={status}
            model={model}
            turnStartAt={turnStartAt}
            onSend={onSend}
            onStop={onStop}
          />
        </div>
        <StatusBar connected={connected} model={model} metrics={metrics} onReconnect={onReconnect} />
      </div>
    </div>
  );
}
