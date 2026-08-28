// TasksPage — async task 列表页（spec/requirements/async-task.md §3.2）。
//
// 数据源：tasksStore（async_task_created / status 帧增量 + async_task_list 全量）。
// 挂载时主动 queryTaskList 拉一次；之后靠 ws 推帧增量更新。

import { useEffect, useSyncExternalStore } from "react";
import { TASK_EVENT_RING, tasksStore, type TaskEntry } from "../store/tasks";
import type { MonoDeskWS } from "../ws/client";

export function shortId(id: string): string {
  return id.length > 14 ? id.slice(0, 14) + "…" : id;
}

function elapsed(entry: TaskEntry): string {
  const s = entry.summary;
  const start = s.started_at ?? s.created_at;
  const end = s.finished_at ?? Date.now() / 1000;
  const sec = Math.max(0, end - start);
  if (s.status === "running") {
    return sec < 60 ? `${Math.floor(sec)}s` : `${Math.floor(sec / 60)}m`;
  }
  return sec < 60 ? `done in ${Math.floor(sec)}s` : `done in ${Math.floor(sec / 60)}m`;
}

function metaPreview(entry: TaskEntry): string {
  const entries = Object.entries(entry.summary.meta || {}).slice(0, 3);
  if (entries.length === 0) return "";
  return entries.map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(", ");
}

export function StatusDot({ status }: { status: string }) {
  return <span className={"task-dot " + status} aria-label={status} />;
}

export function TaskCard({
  entry,
  onOpenTask,
  onCancel,
}: {
  entry: TaskEntry;
  onOpenTask: (taskId: string) => void;
  onCancel: (taskId: string) => void;
}) {
  const s = entry.summary;
  const running = s.status === "running";
  const mp = metaPreview(entry);
  return (
    <div className="task-card" data-task-id={s.task_id}>
      <button className="task-card-main" onClick={() => onOpenTask(s.task_id)}>
        <StatusDot status={s.status} />
        <div className="task-card-body">
          <div className="task-title-row">
            <span className="mono task-id">{shortId(s.task_id)}</span>
            <span className="task-kind">{s.kind}</span>
            <span className={"task-status " + s.status}>{s.status}</span>
          </div>
          <div className="task-desc" title={s.description}>
            {s.description || <span className="faint">（无描述）</span>}
          </div>
          <div className="task-meta-row">
            <span className="mono">parent: {s.parent_session_key || "-"}</span>
            <span className="sep">·</span>
            <span>{elapsed(entry)}</span>
            {s.timeout_sec > 0 && (
              <>
                <span className="sep">·</span>
                <span className="faint">timeout {Math.round(s.timeout_sec / 60)}m</span>
              </>
            )}
            {mp && (
              <>
                <span className="sep">·</span>
                <span className="mono faint">{mp}</span>
              </>
            )}
          </div>
        </div>
      </button>
      {running && (
        <button
          className="task-cancel"
          title="cancel task"
          onClick={(e) => {
            e.stopPropagation();
            onCancel(s.task_id);
          }}
        >
          cancel
        </button>
      )}
    </div>
  );
}

export function TasksPage({
  ws,
  onOpenTask,
  store = tasksStore,
}: {
  ws: MonoDeskWS | null;
  onOpenTask: (taskId: string) => void;
  // 单测注入用：默认全局单例
  store?: Pick<typeof tasksStore, "subscribe" | "getSnapshot">;
}) {
  const tasks = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const running = tasks.filter((t) => t.summary.status === "running").length;

  useEffect(() => {
    ws?.queryTaskList();
  }, [ws]);

  return (
    <div id="tasks-page" className="container">
      <div className="page-head">
        <h1>Tasks</h1>
        <span className={"task-page-status" + (running > 0 ? " running" : "")}>
          {running > 0 ? `${running} active` : "no active"}
        </span>
        <div className="actions">
          <button className="icon-btn" title="refresh" onClick={() => ws?.queryTaskList()}>
            ↻ refresh
          </button>
        </div>
      </div>

      {tasks.length === 0 ? (
        <div className="tasks-empty">
          <div className="empty-kicker">ASYNC TASKS</div>
          <div className="empty-title">还没有异步任务</div>
          <div className="empty-sub">
            在 Chat 里让 agent 调 fork_task（例如「后台帮我审一下这个 PR」），
            任务会出现在这里，完成后结果自动回到对话流。
          </div>
        </div>
      ) : (
        <div className="task-list">
          {tasks
            .slice()
            .sort((a, b) => {
              const runningA = a.summary.status === "running" ? 0 : 1;
              const runningB = b.summary.status === "running" ? 0 : 1;
              if (runningA !== runningB) return runningA - runningB;
              return b.summary.created_at - a.summary.created_at;
            })
            .map((t) => (
              <TaskCard
                key={t.summary.task_id}
                entry={t}
                onOpenTask={onOpenTask}
                onCancel={(id) => ws?.cancelTask(id)}
              />
            ))}
        </div>
      )}
    </div>
  );
}

export { TASK_EVENT_RING };
