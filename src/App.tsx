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
import type { Attachment, MonoDeskEvent, StatusState } from "./ws/protocol";
import { Conversation } from "./components/Conversation";
import { Composer } from "./components/Composer";
import { TopBar } from "./components/Chrome";
import { Sidebar, type SidebarPage } from "./components/Sidebar";
import { SkillsPage } from "./components/SkillsPage";
import { TasksPage } from "./components/TasksPage";
import { TaskDetailPage } from "./components/TaskDetailPage";
import { SelectionFab } from "./components/SelectionFab";
import { FloatingAgentPanel } from "./components/FloatingAgentPanel";
import { tasksStore } from "./store/tasks";
import { TraceDrawer } from "./components/TraceDrawer";
import { TraceClient } from "./observability/client";
import { SkillsClient } from "./skills/client";
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
  newForkSession,
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
  runningTasks = 0,
  onOpenTasks,
}: {
  connected: boolean;
  model: string;
  metrics: Metrics;
  // 本次对话所有 assistant msg 的累计 prompt cache 命中率（按 token 数加权）。
  // 没数据 → null（不显示，避免 0.0% 噪声）。
  sessionCache: { ratio: number; prompt: number; cached: number } | null;
  onReconnect: () => void;
  runningTasks?: number;
  onOpenTasks?: () => void;
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
      <div className="sb-right">
        {runningTasks > 0 && (
          <button className="sb-tasks" onClick={onOpenTasks} title="open Tasks">
            {runningTasks} task{runningTasks > 1 ? "s" : ""} running
          </button>
        )}
        {m.length ? m.join(" · ") : "ready"}
      </div>
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
  availableProviders: [] as string[],
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
  // 当前页：chat（默认）/ skills / tasks。Sidebar 上的 rail 按钮切这个。
  const [currentPage, setCurrentPage] = useState<SidebarPage>("chat");
  // Tasks 页当前打开详情的 task（null = 列表页）
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  // 用户选中的模型 provider；空串 = 跟随服务端默认。
  // 全局一份（跨 session 共享选择），下一个 user_input 的 meta 带给 Runtime。
  const [selectedProvider, setSelectedProvider] = useState("");
  // 所有会话运行时状态都在这张 Map 里。视图状态完全 derive。
  const [sessionStates, setSessionStates] = useState<Record<string, SessionState>>(
    () => loadSessionStates()
  );

  // Floating agent panel：选中片段 → 弹窗 → 起新 fork session
  // null 表示 panel 关着。parentKey 是当前主 session，forkKey 是新 session。
  // session 列表里 fork session 是真实存在的（sidebar 可见）—— 即使关掉 panel
  // 也只是隐藏窗口，session 留着不丢。
  const [floatingPanel, setFloatingPanel] = useState<
    | {
        parentKey: string;
        parentTitle: string;
        parentLastMsg: string | null;
        snippet: string;
        forkKey: string;
        forkTitle: string;
      }
    | null
  >(null);

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
        setAvailableProviders: routed.availableProviders as any,
        setConnected, // 全局，不分 session
      };
    };
    engineRef.current = new StreamEngine(router);
  }
  const engine = engineRef.current;

  // Runtime 级握手信息（hello 帧）：providers 列表 + 默认模型。
  // hello 不属于任何 session —— 不进 sessionStates Map，直接放全局，
  // 否则写进了 "default" entry 而当前视图是别的会话时永远看不到。
  const [serverProviders, setServerProviders] = useState<string[]>([]);
  const [helloModel, setHelloModel] = useState("");
  const handleEvent = useCallback(
    (ev: MonoDeskEvent) => {
      if (ev.type === "hello") {
        if (ev.data.providers) setServerProviders(ev.data.providers);
        if (ev.data.model) setHelloModel((m) => m || ev.data.model);
        // 每次（重）连后拉一次全量任务列表（增量靠后续 ws 推帧）
        wsRef.current?.queryTaskList();
      }
      if (ev.type.startsWith("async_task_")) {
        tasksStore.ingest(ev);
        return; // async 帧不进主 Chat 流的 engine
      }
      engine.dispatch(ev);
    },
    [engine]
  );

  // 视图状态完全 derive：active session 没 entry 就是空 default，
  // 绝不可能拿到上一个会话的内容。
  const view = sessionStates[session] ?? EMPTY_SESSION_STATE;
  const viewMsgs: Msg[] = view.msgs;
  const status: StatusState = view.status as StatusState;
  const metrics: Metrics = view.metrics as Metrics;
  const steps: Step[] = view.steps;
  const model: string = view.model;
  const availableProviders: string[] = view.availableProviders ?? [];

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
  const skillsClientRef = useRef<SkillsClient>();
  if (!skillsClientRef.current) skillsClientRef.current = SkillsClient.shared(DEBUG_URL);
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
        onEvent: handleEvent,
        onConnectionChange: (open: boolean) => setConnected(open),
      });
      return;
    }
    const ws = new MonoDeskWS(WS_URL, {
      onEvent: handleEvent,
      onConnectionChange: (open) => setConnected(open),
    });
    ws.connect();
    wsRef.current = ws;
    if (import.meta.env.DEV) w.__monodeskWs = ws;
    return () => {
      // dev HMR：保留实例不关；prod：组件卸载时正常关闭
      if (!import.meta.env.DEV) ws.close();
    };
  }, [engine, handleEvent]);

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

  const onSend = (text: string, attachments?: Attachment[]) => {
    setTurnStartAt(performance.now());
    // 不打断 Runtime：Runtime 的 LoopEngine 在每个 turn 开始时会 drain input_queue，
    // 把新进来的 user_input 聚合到 messages 后再调 LLM。当前 turn 跑完后下一轮
    // 会自动处理这条（用户连续发多条时模型能看到完整上下文）。
    //
    // startTurn 需要 sessionKey —— App 知道这条 user_input 进哪个 session。
    engine.startTurn(text, session, attachments);
    wsRef.current?.send({
      type: "user_input",
      data: {
        text,
        session_key: session,
        attachments,
        // 模型切换：选了 provider 就随请求透传，LlmProxy 自己解析；空串 = 服务端默认
        meta: selectedProvider ? { model_provider: selectedProvider } : undefined,
      },
    });
  };

  const onStop = () => {
    // Optimistic update: 立即把该 session 切成 idle 态，LLM 真正中断后的
    // StatusChange(idle) 帧到来时不再重复更新（状态相同）。这样用户点 STOP 后
    // 能瞬间看到 thinking 消失，而不是等 5s 网络往返 + interrupt 处理。
    setSessionStates((s) => {
      const cur = s[session];
      if (!cur || cur.status === "idle") return s;
      return { ...s, [session]: { ...cur, status: "idle" } };
    });
    // 发到当前活跃 session（不能硬编码 default——agent 可能在 monodesk:xxx 里跑）
    wsRef.current?.send({
      type: "interrupt",
      data: { session_key: session },
    });
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

  // 清除当前会话的聊天历史（只删 desk 本地，agent runtime 不支持删除会话）
  const onClearSession = (key: string) => {
    setSessionStates((s) => ({
      ...s,
      [key]: { ...s[key], msgs: [] },
    }));
  };

  const onReconnect = () => {
    wsRef.current?.reconnect();
  };

  // Chat 流 TaskBlock → Tasks 详情页的 cross-link
  const onOpenTask = useCallback((taskId: string) => {
    setActiveTaskId(taskId);
    setCurrentPage("tasks");
  }, []);

  // Floating agent panel — 选中片段后从 #conversation 拉起
  const onBranchFromSelection = useCallback(
    (snippet: string) => {
      if (!snippet.trim()) return;
      const s = snippet.trim().slice(0, 4000); // 上限 4000 字避免 user_input 过大
      const parentTitle =
        sessions.find((x) => x.key === session)?.title ?? session;
      // 取主会话最近一条 assistant msg（≤200 字）作为上下文锚。
      // 注意：assistant msg 没有 .text 字段，只有 children —— 拼接所有 text child 的文本。
      const parentMsgs = sessionStates[session]?.msgs ?? [];
      const lastAssistant = [...parentMsgs]
        .reverse()
        .find((m): m is Extract<Msg, { role: "assistant" }> => m.role === "assistant");
      const assistantText = lastAssistant
        ? lastAssistant.children
            .filter((c): c is { id: string; kind: "text"; text?: string } => c.kind === "text")
            .map((c) => c.text ?? "")
            .join("")
            .trim()
        : "";
      const parentLastMsg = assistantText
        ? assistantText.slice(0, 200) + (assistantText.length > 200 ? "…" : "")
        : null;
      const fork = newForkSession(session, s);
      // Fork session 不进 sidebar —— 它是「临时」对话，Panel 关闭就消失。
      // 也不同步到 localStorage（关掉即丢，避免污染会话列表）。
      setFloatingPanel({
        parentKey: session,
        parentTitle,
        parentLastMsg,
        snippet: s,
        forkKey: fork.key,
        forkTitle: fork.title,
      });
    },
    [session, sessions, sessionStates]
  );

  const onCloseFloatingPanel = useCallback(() => {
    setFloatingPanel(null);
  }, []);

  // ⤢ 按钮不再切走主对话。改为：组件内部 toggle expanded 状态（放大面板）。
  // 这里只负责清浮窗指向交给 FloatingAgentPanel 自己的内部状态。
  const onExpandFloatingPanel = useCallback(() => {
    // no-op：面板内部管理 expanded 尺寸切换
  }, []);

  // Panel 内的 send：只有第一条 user_input 带 snippet + parent context（让 agent
  // 第一次看到上下文）。后续追问就是纯文本，跟普通 session 一致 —— 上下文由
  // agent 在 server 端的历史消息里维护。这样多轮对话不会被这坨 prefix 污染。
  const onPanelSend = useCallback(
    (text: string, attachments?: Attachment[]) => {
      if (!floatingPanel) return;
      const { parentKey, parentLastMsg, snippet, forkKey } = floatingPanel;
      const isFirst =
        (sessionStates[forkKey]?.msgs ?? []).length === 0;
      const composed = isFirst
        ? [
            parentLastMsg ? `[From session "${parentKey}" — last assistant reply]\n${parentLastMsg}\n` : "",
            `[Selected snippet]\n${snippet}\n`,
            `[Your question]\n${text}`,
          ]
            .filter(Boolean)
            .join("\n")
        : text;
      engine.startTurn(composed, forkKey, attachments, isFirst ? { forkQuestion: text } : undefined);
      wsRef.current?.send({
        type: "user_input",
        data: {
          text: composed,
          session_key: forkKey,
          attachments,
          meta: isFirst
            ? {
                fork_from: parentKey,
                snippet,
                parent_context: parentLastMsg,
                ...(selectedProvider ? { model_provider: selectedProvider } : {}),
              }
            : selectedProvider
              ? { model_provider: selectedProvider }
              : undefined,
        },
      });
    },
    [floatingPanel, engine, selectedProvider, sessionStates]
  );

  return (
    <div id="app">
      <Sidebar
        currentPage={currentPage}
        onPageChange={setCurrentPage}
        sessions={sessions}
        activeKey={session}
        onSelectSession={onSelectSession}
        onCreateSession={onCreateSession}
        onDeleteSession={onDeleteSession}
        canCreate={sessions.length < MAX_SESSIONS}
        runningTasks={tasksStore.runningCount()}
      />
      <div id="main-col">
        <TopBar
          theme={theme}
          onToggleTheme={() => setTheme((t) => (t === "light" ? "dark" : "light"))}
          onClear={currentPage === "chat" ? () => onClearSession(session) : undefined}
        />
        <div id="body">
          {currentPage === "chat" ? (
            <>
              <Conversation
                sessionKey={session}
                msgs={viewMsgs}
                engine={engine}
                onSend={onSend}
                onInspectRun={onInspectRun}
                onOpenTask={onOpenTask}
              />
              <Composer
                running={running}
                status={status}
                model={helloModel || model}
                providers={serverProviders}
                selectedProvider={selectedProvider}
                onSelectProvider={setSelectedProvider}
                turnStartAt={turnStartAt}
                onSend={onSend}
                onStop={onStop}
              />
            </>
          ) : currentPage === "tasks" ? (
            activeTaskId ? (
              <TaskDetailPage
                taskId={activeTaskId}
                ws={wsRef.current ?? null}
                onBack={() => setActiveTaskId(null)}
              />
            ) : (
              <TasksPage ws={wsRef.current ?? null} onOpenTask={setActiveTaskId} />
            )
          ) : (
            <SkillsPage client={skillsClientRef.current} />
          )}
        </div>
        <StatusBar
          connected={connected}
          model={model}
          metrics={metrics}
          sessionCache={sessionCache}
          onReconnect={onReconnect}
          runningTasks={tasksStore.runningCount()}
          onOpenTasks={() => {
            setActiveTaskId(null);
            setCurrentPage("tasks");
          }}
        />
        <TraceDrawer
          runId={inspectRunId}
          sessionKey={session}
          client={traceClientRef.current}
          onClose={onCloseDrawer}
        />
      </div>

      {/* Floating agent panel —— 选中片段后弹出。floatingPanel 为 null 时不渲染。 */}
      {floatingPanel && (
        <FloatingAgentPanel
          parentKey={floatingPanel.parentKey}
          parentTitle={floatingPanel.parentTitle}
          parentLastMsg={floatingPanel.parentLastMsg}
          snippet={floatingPanel.snippet}
          forkKey={floatingPanel.forkKey}
          forkTitle={floatingPanel.forkTitle}
          engine={engine}
          msgs={sessionStates[floatingPanel.forkKey]?.msgs ?? []}
          onSend={onPanelSend}
          onClose={onCloseFloatingPanel}
          onExpand={onExpandFloatingPanel}
        />
      )}

      {/* SelectionFab —— 只在 chat 页生效（Tasks/Skills 内的选中不触发 branch）。 */}
      {currentPage === "chat" && (
        <SelectionFab onBranch={onBranchFromSelection} />
      )}
    </div>
  );
}
