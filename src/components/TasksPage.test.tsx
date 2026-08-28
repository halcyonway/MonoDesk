// TasksPage / TaskBlock 单测 — 列表渲染 / cancel 按钮 / cross-link / TaskBlock 路由。
// 模板仿 SkillsPage.test.tsx：注入 store / vi.fn。

import { describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TasksPage, TaskCard } from "./TasksPage";
import { TaskBlock, extractTaskId } from "./TaskBlock";
import { TasksStore } from "../store/tasks";
import type { MonoDeskWS } from "../ws/client";
import type { Child } from "../stream/engine";

function makeEntry(overrides: Partial<Parameters<typeof Object.assign>[0]> = {}) {
  const store = new TasksStore();
  store.ingest({
    type: "async_task_created",
    data: {
      session_key: "default",
      task_id: "t_4f9ea1b2c3d4",
      kind: "subagent",
      description: "review this PR",
      meta: { pr_url: "http://x" },
      parent_session_key: "default",
      timeout_sec: 1800,
      created_at: Date.now() / 1000,
    },
  } as never);
  if (overrides) {
    const entry = store.getSnapshot()[0];
    Object.assign(entry.summary, overrides);
  }
  return store;
}

const fakeWs = {
  cancelTask: vi.fn(),
  queryTaskList: vi.fn(),
} as unknown as MonoDeskWS;

describe("TasksPage", () => {
  it("空列表 → 空态文案 + queryTaskList 拉取", () => {
    const store = new TasksStore();
    render(<TasksPage ws={fakeWs} onOpenTask={() => {}} store={store} />);
    expect(screen.getByText("还没有异步任务")).toBeTruthy();
    expect(fakeWs.queryTaskList).toHaveBeenCalled();
  });

  it("有任务 → 卡片渲染 id / 描述 / parent；running 显示 cancel", () => {
    const store = makeEntry();
    render(
      <TasksPage
        ws={fakeWs}
        onOpenTask={() => {}}
        store={store}
      />
    );
    expect(screen.getByText("review this PR")).toBeTruthy();
    expect(screen.getByText(/parent: default/)).toBeTruthy();
    const cancel = screen.getByText("cancel");
    fireEvent.click(cancel);
    expect(fakeWs.cancelTask).toHaveBeenCalledWith("t_4f9ea1b2c3d4");
  });

  it("终态任务不显示 cancel", () => {
    const store = makeEntry({ status: "completed" });
    render(<TasksPage ws={fakeWs} onOpenTask={() => {}} store={store} />);
    expect(screen.queryByText("cancel")).toBeNull();
  });

  it("点卡片 → onOpenTask(taskId)", () => {
    const store = makeEntry();
    const onOpen = vi.fn();
    render(<TasksPage ws={fakeWs} onOpenTask={onOpen} store={store} />);
    fireEvent.click(screen.getByText("review this PR"));
    expect(onOpen).toHaveBeenCalledWith("t_4f9ea1b2c3d4");
  });

  it("TaskCard 独立渲染：终态显示 done in", () => {
    const store = makeEntry({ status: "completed", finished_at: Date.now() / 1000 + 12 });
    const entry = store.getSnapshot()[0];
    render(<TaskCard entry={entry} onOpenTask={() => {}} onCancel={() => {}} />);
    expect(screen.getByText(/done in/)).toBeTruthy();
  });
});

describe("TaskBlock", () => {
  const toolChild = (over: Partial<Extract<Child, { kind: "tool" }>>): Extract<Child, { kind: "tool" }> => ({
    id: "c1",
    kind: "tool",
    name: "fork_task",
    args: JSON.stringify({ description: "review PR" }),
    state: "done",
    latencyMs: 3,
    ...over,
  });

  it("extractTaskId：result.stdout JSON 优先，其次 args.task_id / task_ids[0]", () => {
    const fromResult = extractTaskId(toolChild({
      result: { call_id: "", status: "ok", stdout: '{"task_id":"t_res1","status":"running","timeout_sec":1800}', stderr: "", exit_code: 0, truncated: false, budget_id: null },
    } as never));
    expect(fromResult).toBe("t_res1");

    const fromArgs = extractTaskId(toolChild({ name: "cancel_task", args: '{"task_id":"t_arg1"}' }));
    expect(fromArgs).toBe("t_arg1");

    const fromIds = extractTaskId(toolChild({ name: "poll_task", args: '{"task_ids":["t_a","t_b"]}' }));
    expect(fromIds).toBe("t_a");

    expect(extractTaskId(toolChild({ args: "not json" }))).toBeNull();
  });

  it("store 有该任务 → 显示 live 状态 + 跳转链接", () => {
    const store = makeEntry();
    render(
      <TaskBlock
        child={toolChild({
          result: { call_id: "", status: "ok", stdout: '{"task_id":"t_4f9ea1b2c3d4","status":"running"}', stderr: "", exit_code: 0, truncated: false, budget_id: null },
        } as never)}
        onOpenTask={undefined}
        store={store}
      />
    );
    expect(screen.getByText("running")).toBeTruthy();
    expect(screen.getByText("review this PR")).toBeTruthy();
  });

  it("store 没有该任务 → 降级显示 args，不 crash", () => {
    render(
      <TaskBlock
        child={toolChild({ name: "cancel_task", args: '{"task_id":"t_missing"}' })}
        store={new TasksStore()}
      />
    );
    expect(screen.getByText("cancel_task")).toBeTruthy();
  });
});
