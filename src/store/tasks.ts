// Tasks store — async task 列表 / 事件 ring buffer 的单一事实源。
//
// 数据流：App.handleEvent 把 async_task_* 帧喂给 tasksStore.ingest()；
// 组件用 useSyncExternalStore(tasksStore.subscribe, tasksStore.getSnapshot) 读列表；
// TaskDetailPage 另用 onFrame 收 per-task 的实时帧喂给详情页的 StreamEngine。
//
// 内存上界：per-task 事件 ring buffer 100 条（spec §2；单 task ~50KB 量级，可接受）。

import { useCallback } from "react";
import { useSyncExternalStore } from "react";
import type {
  AsyncTaskCreatedData,
  AsyncTaskListData,
  AsyncTaskSnapshotData,
  AsyncTaskStatusData,
  AsyncTaskSummary,
  MonoDeskEvent,
} from "../ws/protocol";

export const TASK_EVENT_RING = 100;

export interface TaskEventFrame {
  type: string;
  data: Record<string, unknown>;
  ts: number;
  // per-task 递增序号：详情页用它区分「回放」和「新帧」，避免重复 dispatch
  seq: number;
}

export interface TaskEntry {
  summary: AsyncTaskSummary;
  events: TaskEventFrame[];
}

type Listener = () => void;
type FrameListener = (taskId: string, frame: TaskEventFrame) => void;

export class TasksStore {
  private byId = new Map<string, TaskEntry>();
  private seqCounter = new Map<string, number>();
  private listeners = new Set<Listener>();
  private frameListeners = new Set<FrameListener>();
  private snapshotCache: TaskEntry[] = [];

  // ---- React 绑定 ----

  subscribe = (fn: Listener): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = (): TaskEntry[] => this.snapshotCache;

  /** per-task 帧级订阅（详情页实时流用，不走 React 渲染管线）。 */
  onFrame = (fn: FrameListener): (() => void) => {
    this.frameListeners.add(fn);
    return () => this.frameListeners.delete(fn);
  };

  // ---- 入口 ----

  ingest = (ev: MonoDeskEvent): void => {
    switch (ev.type) {
      case "async_task_created":
        this.upsertTask(createdToSummary(ev.data));
        break;
      case "async_task_event":
        this.appendEvent(ev.data.task_id, { type: ev.data.event.type, data: ev.data.event.data as Record<string, unknown>, ts: Date.now() / 1000 });
        break;
      case "async_task_status":
        this.updateStatus(ev.data);
        break;
      case "async_task_list":
        this.setList(ev.data.tasks);
        break;
      case "async_task_snapshot":
        this.applySnapshot(ev.data);
        break;
      default:
        break; // 非 async 帧忽略
    }
  };

  // ---- 查询 ----

  get(taskId: string): TaskEntry | undefined {
    return this.byId.get(taskId);
  }

  runningCount(): number {
    let n = 0;
    for (const t of this.byId.values()) if (t.summary.status === "running") n++;
    return n;
  }

  // ---- 变更 ----

  upsertTask(summary: AsyncTaskSummary): void {
    const existing = this.byId.get(summary.task_id);
    this.byId.set(summary.task_id, {
      summary,
      events: existing?.events ?? [],
    });
    this.bump();
  }

  appendEvent(taskId: string, frame: Omit<TaskEventFrame, "seq">): void {
    const entry = this.byId.get(taskId);
    if (!entry) {
      // 事件先于 created 帧到达（乱序容差）：建一个最小 entry，等 created/list 补全
      this.byId.set(taskId, {
        summary: emptySummary(taskId),
        events: [],
      });
      return this.appendEvent(taskId, frame);
    }
    const seq = (this.seqCounter.get(taskId) ?? 0) + 1;
    this.seqCounter.set(taskId, seq);
    const full: TaskEventFrame = { ...frame, seq };
    entry.events = [...entry.events, full].slice(-TASK_EVENT_RING);
    this.bump();
    for (const fn of this.frameListeners) fn(taskId, full);
  }

  updateStatus(d: AsyncTaskStatusData): void {
    const entry = this.byId.get(d.task_id);
    if (!entry) return;
    entry.summary = {
      ...entry.summary,
      status: d.status,
      finished_at: d.finished_at,
      final_text: d.final_text,
      error: d.error,
    };
    this.bump();
  }

  setList(tasks: AsyncTaskSummary[]): void {
    // 全量替换 summary；已积累的事件流保留（list 刷新不丢详情页内容）
    const next = new Map<string, TaskEntry>();
    for (const s of tasks) {
      next.set(s.task_id, { summary: s, events: this.byId.get(s.task_id)?.events ?? [] });
    }
    this.byId = next;
    this.bump();
  }

  applySnapshot(d: AsyncTaskSnapshotData): void {
    const existing = this.byId.get(d.task.task_id);
    this.byId.set(d.task.task_id, {
      summary: d.task,
      events: existing?.events ?? [],
    });
    this.bump();
  }

  private bump(): void {
    this.snapshotCache = Array.from(this.byId.values());
    for (const fn of this.listeners) fn();
  }
}

function createdToSummary(d: AsyncTaskCreatedData): AsyncTaskSummary {
  return {
    task_id: d.task_id,
    kind: d.kind,
    description: d.description,
    status: "running",
    parent_session_key: d.parent_session_key,
    created_at: d.created_at,
    started_at: d.created_at,
    finished_at: null,
    timeout_sec: d.timeout_sec,
    meta: d.meta,
    final_text: null,
    error: null,
  };
}

function emptySummary(taskId: string): AsyncTaskSummary {
  return {
    task_id: taskId,
    kind: "subagent",
    description: "",
    status: "running",
    parent_session_key: "",
    created_at: Date.now() / 1000,
    started_at: null,
    finished_at: null,
    timeout_sec: 0,
    meta: {},
    final_text: null,
    error: null,
  };
}

// 模块级单例（App / TaskBlock / TasksPage 共享同一份）
export const tasksStore = new TasksStore();

/** 组件侧 hook：订阅任务列表快照。 */
export function useTasks(): TaskEntry[] {
  return useSyncExternalStore(tasksStore.subscribe, tasksStore.getSnapshot);
}

/** 组件侧 hook：订阅单个任务（不存在 → undefined）。 */
export function useTask(taskId: string | null): TaskEntry | undefined {
  const snapshot = useTasks();
  const get = useCallback(
    () => (taskId ? snapshot.find((t) => t.summary.task_id === taskId) : undefined),
    [snapshot, taskId]
  );
  // getSnapshot 必须是稳定引用缓存——find 每次返回同一条目引用，命中即可
  return useSyncExternalStore(tasksStore.subscribe, get);
}
