// TaskBlock — Chat 流里 fork_task / cancel_task / poll_task 的工具块（spec §3.4）。
//
// 替代通用 ToolBlock：显示任务 live 状态（tasks store 驱动）+ 跳 Tasks 详情页的
// cross-link。task_id 从 tool args / result 里提取。

import { useEffect, useState } from "react";
import { tasksStore } from "../store/tasks";
import type { Child } from "../stream/engine";

export function extractTaskId(child: Extract<Child, { kind: "tool" }>): string | null {
  // fork_task：task_id 在 tool_end 的 result.stdout（JSON）里
  if (child.result?.stdout) {
    try {
      const parsed = JSON.parse(child.result.stdout) as { task_id?: string };
      if (parsed.task_id) return parsed.task_id;
    } catch {
      // stdout 不是 JSON（error 文案等）→ 落到 args 提取
    }
  }
  // cancel_task / poll_task：args 里有 task_id / task_ids[0]
  if (child.args) {
    try {
      const args = JSON.parse(child.args) as { task_id?: string; task_ids?: string[] };
      if (args.task_id) return args.task_id;
      if (args.task_ids && args.task_ids.length > 0) return args.task_ids[0];
    } catch {
      // args 还在流式拼装中（pending 态）→ 没有可提取的 id
    }
  }
  return null;
}

export function TaskBlock({
  child,
  onOpenTask,
  store = tasksStore,
}: {
  child: Extract<Child, { kind: "tool" }>;
  onOpenTask?: (taskId: string) => void;
  store?: Pick<typeof tasksStore, "subscribe" | "getSnapshot">;
}) {
  const taskId = extractTaskId(child);
  const entry = useTaskInBlock(taskId, store);
  const status = entry?.summary.status;
  const done = status && status !== "running" && status !== "pending";
  const desc = entry?.summary.description;

  return (
    <div className={"block tool task" + (done ? " done" : " running")}>
      <div className="block-head">
        <span className="label">
          <span className={"task-dot " + (status ?? "running")} />
          {child.name}
        </span>
        {taskId ? (
          <button
            className="task-link mono"
            title={desc ? `open in Tasks — ${desc}` : "open in Tasks"}
            onClick={() => onOpenTask?.(taskId)}
          >
            {taskId} ↗
          </button>
        ) : child.args ? (
          <span className="t-args">{child.args}</span>
        ) : null}
        <span className="spacer" />
        {status && <span className={"t-badge " + (done ? "ok" : "running")}>{status}</span>}
        <span className="t-latency">
          {child.latencyMs != null ? `${child.latencyMs}ms` : ""}
        </span>
      </div>
      {desc && <div className="task-block-desc">{desc}</div>}
    </div>
  );
}

function useTaskInBlock(
  taskId: string | null,
  store: Pick<typeof tasksStore, "subscribe" | "getSnapshot">
) {
  const [, force] = useState(0);
  useEffect(() => store.subscribe(() => force((n) => n + 1)), [store]);
  if (!taskId) return undefined;
  return store.getSnapshot().find((t) => t.summary.task_id === taskId);
}
