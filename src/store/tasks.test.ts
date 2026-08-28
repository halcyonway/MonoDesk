// TasksStore 单测 — ingest 路由 / ring buffer / list 全量替换 / 状态迁移。
import { describe, expect, it, vi } from "vitest";
import { TASK_EVENT_RING, TasksStore } from "./tasks";
import type { MonoDeskEvent } from "../ws/protocol";

function createdEv(taskId: string, ts = 1000): MonoDeskEvent {
  return {
    type: "async_task_created",
    data: {
      session_key: "default",
      task_id: taskId,
      kind: "subagent",
      description: "review PR",
      meta: { pr: "x" },
      parent_session_key: "default",
      timeout_sec: 1800,
      created_at: ts,
    },
  } as MonoDeskEvent;
}

function eventEv(taskId: string, text: string): MonoDeskEvent {
  return {
    type: "async_task_event",
    data: {
      session_key: "default",
      task_id: taskId,
      event: { type: "token", data: { text } },
    },
  } as MonoDeskEvent;
}

describe("TasksStore", () => {
  it("ingest created → snapshot 出现 running 条目", () => {
    const store = new TasksStore();
    store.ingest(createdEv("t_1"));
    const snap = store.getSnapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0].summary.status).toBe("running");
    expect(snap[0].summary.description).toBe("review PR");
    expect(store.runningCount()).toBe(1);
  });

  it("ingest event → ring buffer 追加，onFrame 通知；超 RING 丢弃最早", () => {
    const store = new TasksStore();
    store.ingest(createdEv("t_1"));
    const frames: Array<[string, number]> = [];
    store.onFrame((tid, frame) => frames.push([tid, frame.seq]));
    for (let i = 0; i < TASK_EVENT_RING + 5; i++) store.ingest(eventEv("t_1", `tok${i}`));
    const entry = store.get("t_1")!;
    expect(entry.events).toHaveLength(TASK_EVENT_RING);
    expect(entry.events[entry.events.length - 1].data.text).toBe(`tok${TASK_EVENT_RING + 4}`);
    expect(frames).toHaveLength(TASK_EVENT_RING + 5);
    // seq 单调递增
    expect(frames[frames.length - 1][1]).toBe(TASK_EVENT_RING + 5);
  });

  it("ingest status → 终态更新 + runningCount 归零", () => {
    const store = new TasksStore();
    store.ingest(createdEv("t_1"));
    store.ingest({
      type: "async_task_status",
      data: {
        session_key: "default", task_id: "t_1", status: "completed",
        finished_at: 1047, duration_sec: 47, final_text: "done",
        error: null, cancel_reason: null,
      },
    } as MonoDeskEvent);
    const s = store.getSnapshot()[0].summary;
    expect(s.status).toBe("completed");
    expect(s.final_text).toBe("done");
    expect(store.runningCount()).toBe(0);
  });

  it("ingest list → 全量替换 summary 但保留已积累事件", () => {
    const store = new TasksStore();
    store.ingest(createdEv("t_1"));
    store.ingest(eventEv("t_1", "keep me"));
    store.ingest({
      type: "async_task_list",
      data: {
        session_key: "default",
        tasks: [{ ...store.get("t_1")!.summary, status: "completed" }],
      },
    } as MonoDeskEvent);
    const entry = store.get("t_1")!;
    expect(entry.summary.status).toBe("completed");
    expect(entry.events).toHaveLength(1);
    expect(entry.events[0].data.text).toBe("keep me");
  });

  it("list 不包含的新 task 出现、旧 task 消失", () => {
    const store = new TasksStore();
    store.ingest(createdEv("t_1"));
    store.ingest(createdEv("t_2", 2000));
    store.ingest({
      type: "async_task_list",
      data: { session_key: "default", tasks: [store.get("t_2")!.summary] },
    } as MonoDeskEvent);
    expect(store.getSnapshot().map((t) => t.summary.task_id)).toEqual(["t_2"]);
  });

  it("非 async 帧被忽略", () => {
    const store = new TasksStore();
    store.ingest({ type: "token", data: { session_key: "default", text: "hi" } } as MonoDeskEvent);
    expect(store.getSnapshot()).toHaveLength(0);
  });

  it("subscribe 在每次变更时被调用", () => {
    const store = new TasksStore();
    const fn = vi.fn();
    store.subscribe(fn);
    store.ingest(createdEv("t_1"));
    store.ingest(eventEv("t_1", "x"));
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("事件先于 created 到达 → 建最小占位 entry 不 crash", () => {
    const store = new TasksStore();
    store.ingest(eventEv("t_early", "orphan"));
    expect(store.get("t_early")).toBeDefined();
  });
});
