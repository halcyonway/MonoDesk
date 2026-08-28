// TaskDetailPage — 单个 async task 的实时流详情（spec §3.3）。
//
// 复用 StreamEngine 渲染管线：详情页内嵌一个独立 engine 实例（区别于 Chat 流那个），
// 把 store 里的 per-task 帧转成 MonoDeskEvent 喂进去——session_key 用 task_id，
// router 忽略 key 全部写进本页局部 state。复用 Conversation 渲染（markdown /
// tool block / reasoning 折叠全套免费拿到）。

import { useEffect, useRef, useState } from "react";
import { StreamEngine, type Msg } from "../stream/engine";
import { Conversation } from "./Conversation";
import { StatusDot } from "./TasksPage";
import { tasksStore, useTask, type TaskEventFrame } from "../store/tasks";
import type { MonoDeskEvent } from "../ws/protocol";
import type { MonoDeskWS } from "../ws/client";

// child StreamEvent 内嵌 payload → MonoDeskEvent（session_key 换成 task_id，
// 让本页 engine 的所有 DOM 绑定路由到同一 key 上）。
export function innerFrameToEvent(taskId: string, frame: TaskEventFrame): MonoDeskEvent {
  return {
    type: frame.type,
    data: { ...(frame.data as object), session_key: taskId },
  } as MonoDeskEvent;
}

export function TaskDetailPage({
  taskId,
  ws,
  onBack,
  store = tasksStore,
}: {
  taskId: string;
  ws: MonoDeskWS | null;
  onBack: () => void;
  store?: Pick<typeof tasksStore, "subscribe" | "getSnapshot" | "onFrame" | "get">;
}) {
  const entry = useTaskWithStore(taskId, store);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const engineRef = useRef<StreamEngine>();
  const lastSeqRef = useRef(0);
  if (!engineRef.current) {
    // router 忽略 sessionKey——本页只有一个 task 流
    engineRef.current = new StreamEngine(() => ({
      setMsgs: setMsgs,
      setStatus: () => {},
      setMetrics: () => {},
      setSteps: () => {},
      setConnected: () => {},
      setModel: () => {},
      setAvailableProviders: () => {},
    }));
  }
  const engine = engineRef.current;

  // 回放已积累的事件（进入详情页时 task 可能已经跑了一段）。
  // 先清空再回放——setMsgs 是排队的更新，顺序反了会把回放内容清掉。
  useEffect(() => {
    const stored = store.get(taskId);
    setMsgs([]);
    if (!stored) return;
    for (const frame of stored.events) {
      engine.dispatch(innerFrameToEvent(taskId, frame));
    }
    const last = stored.events[stored.events.length - 1];
    lastSeqRef.current = last?.seq ?? 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId, engine, store]);

  // 实时帧
  useEffect(() => {
    return store.onFrame((tid, frame) => {
      if (tid !== taskId || frame.seq <= lastSeqRef.current) return;
      lastSeqRef.current = frame.seq;
      engine.dispatch(innerFrameToEvent(taskId, frame));
    });
  }, [taskId, engine, store]);

  const s = entry?.summary;
  const running = s?.status === "running";

  return (
    <div id="task-detail" className="container">
      <div className="page-head">
        <button className="icon-btn" onClick={onBack} title="back">
          ← back
        </button>
        <h1 className="task-detail-title">
          <span className="mono">{taskId}</span>
        </h1>
        {s && (
          <span className="task-detail-sub">
            <StatusDot status={s.status} /> {s.status} · {s.kind} · parent:{" "}
            <span className="mono">{s.parent_session_key || "-"}</span>
            {s.timeout_sec > 0 && <> · timeout {Math.round(s.timeout_sec / 60)}m</>}
          </span>
        )}
        <div className="actions">
          {running && (
            <button className="icon-btn danger" onClick={() => ws?.cancelTask(taskId)}>
              cancel
            </button>
          )}
        </div>
      </div>

      {s && Object.keys(s.meta || {}).length > 0 && (
        <div className="task-detail-meta mono">
          {Object.entries(s.meta).map(([k, v]) => (
            <span key={k}>
              {k}: {JSON.stringify(v)}{" "}
            </span>
          ))}
        </div>
      )}

      {msgs.length > 0 ? (
        <Conversation
          sessionKey={taskId}
          msgs={msgs}
          engine={engine}
          onSend={() => {
            /* 详情页不发消息 */
          }}
        />
      ) : (
        <div className="task-detail-empty">
          {running ? "waiting for events…" : s ? `no stream captured (${s.status})` : "task not found"}
        </div>
      )}
    </div>
  );
}

function useTaskWithStore(
  taskId: string,
  store: Pick<typeof tasksStore, "subscribe" | "getSnapshot" | "onFrame" | "get">
) {
  // 直接用全局 hook 会绕开注入的 store；这里手写一个同语义订阅
  const [, force] = useState(0);
  useEffect(() => store.subscribe(() => force((n) => n + 1)), [store]);
  return store.get(taskId);
}
