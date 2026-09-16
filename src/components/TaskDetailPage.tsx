// TaskDetailPage — 单个 async task 的实时流详情（spec §3.3 + tasks-feature-redesign.md）。
//
// 复用 StreamEngine 渲染管线：详情页内嵌一个独立 engine 实例（区别于 Chat 流那个），
// 把 store 里的 per-task 帧转成 MonoDeskEvent 喂进去——session_key 用 task_id，
// router 忽略 key 全部写进本页局部 state。复用 Conversation 渲染（markdown /
// tool block / reasoning 折叠全套免费拿到）。
//
// 2026-09 改版：spec/requirements/tasks-feature-redesign.md
// - title = description（不是 task_id），task_id 退到 sub 行 mono faint
// - 4px 左 status 色带 + dot（跟 list 同款 s-<status> className 切换颜色）
// - cancel = 右上 30x30 圆形 icon button（跟 list `.task-cancel` 同形态但放大）
// - Meta 区从 dashed JSON dump 改为 key-value 网格
// - back = icon-only round button

import { useEffect, useRef, useState } from "react";
import { StreamEngine, type Msg } from "../stream/engine";
import { Conversation } from "./Conversation";
import { shortId } from "./TasksPage";
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

function BackIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="M10 3l-5 5 5 5" />
    </svg>
  );
}

function CancelIcon() {
  return (
    <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="M3 3l6 6M9 3l-6 6" />
    </svg>
  );
}

function statusClass(status: string): string {
  return "s-" + status.replace(/_/g, "-");
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
  const title = s?.description || shortId(taskId);
  const parentShort = shortId(s?.parent_session_key || "—");
  const timeoutMin = s && s.timeout_sec > 0 ? Math.round(s.timeout_sec / 60) : 0;
  // Meta 区块：fallback 字段（页头没显示的） + LLM 填的 meta（覆盖 fallback）。
  // LLM 不填 meta 时只显示 fallback，避免「有的 task 有 Meta 有的没」UI 不一致。
  const fallbackMeta: Record<string, unknown> = {};
  if (s) {
    fallbackMeta["created_at"] = new Date(s.created_at * 1000).toISOString();
    if (s.started_at && s.started_at !== s.created_at) {
      fallbackMeta["started_at"] = new Date(s.started_at * 1000).toISOString();
    }
    if (s.finished_at) {
      fallbackMeta["finished_at"] = new Date(s.finished_at * 1000).toISOString();
      const dur = s.finished_at - (s.started_at ?? s.created_at);
      if (dur > 0) fallbackMeta["duration_sec"] = Number(dur.toFixed(1));
    }
    if (s.error) fallbackMeta["error"] = s.error;
    if (s.final_text) fallbackMeta["final_text"] = s.final_text;
  }
  const llmMeta: Record<string, unknown> = (s?.meta && Object.keys(s.meta).length > 0) ? s.meta : {};
  const metaEntries = Object.entries({ ...fallbackMeta, ...llmMeta });

  return (
    <div id="task-detail" className="container">
      {/* back 按钮 —— 独立一行，跟 page head 区分 */}
      <button
        className="icon-btn-round detail-back"
        onClick={onBack}
        title="back to tasks"
        aria-label="back to tasks"
        type="button"
      >
        <BackIcon />
      </button>

      {/* page head —— 跟 list 卡片同 design language：
          4px stripe + dot + title + cancel。但 title 字号更大（18px），task_id 退到 sub */}
      {s && (
        <div className={"detail-head task-card " + statusClass(s.status)}>
          <div className="task-card-main">
            <div className="task-head">
              <span className="task-dot" />
              <span className="task-title task-title-lg">{title}</span>
              <span className="task-status-text">{s.status.replace(/_/g, " ")}</span>
            </div>
            <div className="task-sub task-sub-id">{taskId}</div>
            <div className="task-meta">
              <span className="task-kind-pill">{s.kind}</span>
              <span className="task-id-mono">{parentShort}</span>
              {timeoutMin > 0 && (
                <>
                  <span className="sep">·</span>
                  <span>{timeoutMin}m timeout</span>
                </>
              )}
            </div>
          </div>
          {running && (
            <button
              className="task-cancel task-cancel-lg"
              title="cancel task"
              aria-label="cancel task"
              onClick={() => ws?.cancelTask(taskId)}
              type="button"
            >
              <CancelIcon />
            </button>
          )}
        </div>
      )}

      {/* Meta —— key-value 网格，不再是 JSON dump */}
      {metaEntries.length > 0 && (
        <div className="detail-section">
          <div className="section-title">Meta</div>
          <div className="detail-meta-grid">
            {metaEntries.map(([k, v]) => (
              <div key={k} className="meta-row">
                <div className="meta-key">{k}</div>
                <div className="meta-val">{JSON.stringify(v)}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Events —— 沿用 Conversation 渲染（tool block / reasoning） */}
      {msgs.length > 0 ? (
        <div className="detail-events">
          <div className="section-title">Events</div>
          <Conversation
            sessionKey={taskId}
            msgs={msgs}
            engine={engine}
            onSend={() => {
              /* 详情页不发消息 */
            }}
          />
        </div>
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