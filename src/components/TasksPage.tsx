// TasksPage — async task 列表页（spec/requirements/async-task.md §3.2）。
//
// 数据源：tasksStore（async_task_created / status 帧增量 + async_task_list 全量）。
// 挂载时主动 queryTaskList 拉一次；之后靠 ws 推帧增量更新。
//
// 2026-09 改版：spec/requirements/tasks-page-redesign.md
// - 4px 左 status 色带（running=accent / completed=ok / failed=error / timed_out=thinking / cancelled=faint）
// - title-first 层级：description 升为 title (14px/600)，meta 11px faint
// - 右上 × 圆形 cancel 按钮（不再 stretch 整张卡）
// - page head 两行结构（title 一行 / "1 active · N total" 一行）+ icon-only refresh

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

function statusClass(status: string): string {
  return "s-" + status.replace(/_/g, "-");
}

function RefreshIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="M13.5 8a5.5 5.5 0 0 1-9.7 3.5M2.5 8a5.5 5.5 0 0 1 9.7-3.5M13.5 3v3h-3M2.5 13v-3h3" />
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
  const parentShort = shortId(s.parent_session_key || "—");
  const timeoutMin = s.timeout_sec > 0 ? Math.round(s.timeout_sec / 60) : 0;
  return (
    <div className={"task-card " + statusClass(s.status)} data-task-id={s.task_id}>
      <button
        className="task-card-main"
        onClick={() => onOpenTask(s.task_id)}
        type="button"
      >
        {/* 标题行：status dot + title (description) + status 文字 */}
        <div className="task-head">
          <span className="task-dot" />
          <span className="task-title">{s.description || "（无描述）"}</span>
          <span className="task-status-text">{s.status.replace(/_/g, " ")}</span>
        </div>
        {/* 副行：elapsed */}
        <div className="task-sub">{elapsed(entry)}</div>
        {/* meta 行：kind pill + parent + timeout */}
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
      </button>
      {running && (
        <button
          className="task-cancel"
          title="cancel task"
          aria-label="cancel task"
          onClick={(e) => {
            e.stopPropagation();
            onCancel(s.task_id);
          }}
          type="button"
        >
          <CancelIcon />
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
  const total = tasks.length;

  useEffect(() => {
    ws?.queryTaskList();
  }, [ws]);

  return (
    <div id="tasks-page" className="container">
      <div className="page-head">
        <div className="page-head-row">
          <h1 className="page-title">Tasks</h1>
          <button
            className="icon-btn-round"
            title="refresh"
            aria-label="refresh"
            onClick={() => ws?.queryTaskList()}
            type="button"
          >
            <RefreshIcon />
          </button>
        </div>
        <div className="page-sub">
          {running > 0 ? (
            <>
              <span className="count-active">{running} active</span>
              <span className="sep">·</span>
              <span>{total} total</span>
            </>
          ) : (
            <span>{total === 0 ? "no tasks" : `${total} total`}</span>
          )}
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