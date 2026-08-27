# async-task: MonoDesk 端异步任务（subagent）UI 与协议

> 对应 MonoX 侧 spec：`MonoX/spec/requirements/async-task.md`。
> 本文件是 MonoDesk 端的实现设计：协议类型扩展 + 组件结构 + 视觉稿入口。

---

## 1. 协议：7 个新 frame 在 TS 侧的类型定义

> 文件：`src/ws/protocol.ts`，沿用现有 `MonoDeskEvent` / `InboundMessage` 联合类型风格，additive 扩展。

### 1.1 Outbound（5 个）

```ts
// 出向 MonoDesk 的异步任务帧

export interface AsyncTaskCreatedData {
  session_key: string;
  task_id: string;
  kind: "subagent";                          // 预留 kind 枚举
  description: string;
  meta: Record<string, unknown>;
  parent_session_key: string;
  timeout_sec: number;
  created_at: number;
}

export interface AsyncTaskEventData {
  session_key: string;                       // 父 session_key（用于在 Chat 流里做 cross-link）
  task_id: string;
  event:                                      // 完整 StreamEvent 嵌套；客户端用 frame_to_stream_event 反序列化
    | { type: "status"; data: { state: StatusState; trace_id?: string; turn_id?: string } }
    | { type: "token"; data: { text: string } }
    | { type: "reasoning"; data: { text: string } }
    | { type: "tool_pending"; data: { call_id: string; name: string; tool_index: number; args_so_far: string } }
    | { type: "tool_start"; data: { name: string; args: Record<string, unknown>; call_id?: string } }
    | { type: "tool_end"; data: { name: string; latency_ms: number; result: ToolResultData } }
    | { type: "metric"; data: { metrics: Record<string, unknown>; trace_id?: string; turn_id?: string } }
    | { type: "final"; data: { text: string; metrics: Record<string, unknown>; trace_id?: string } }
    | { type: "card"; data: { data: Record<string, unknown> } }
    | { type: "error"; data: { code: string; msg: string; retryable: boolean } };
}

export interface AsyncTaskStatusData {
  session_key: string;
  task_id: string;
  status: "completed" | "failed" | "cancelled" | "timed_out";
  finished_at: number;
  duration_sec: number;
  final_text: string | null;
  error: string | null;
  cancel_reason: "agent" | "user" | "timeout" | null;
}

export interface AsyncTaskSummary {
  task_id: string;
  kind: string;
  description: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled" | "timed_out";
  parent_session_key: string;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  timeout_sec: number;
  meta: Record<string, unknown>;
  final_text: string | null;
  error: string | null;
}

export interface AsyncTaskListData {
  session_key: string;
  tasks: AsyncTaskSummary[];
}

export interface AsyncTaskSnapshotData {
  session_key: string;
  task: AsyncTaskSummary;
  recent_events: Array<Record<string, unknown>>;  // 简化版 event 列表（status/token/tool）
}

// 扩 MonoDeskEvent 联合：
export type MonoDeskEvent =
  | { type: "hello"; data: HelloData }
  | /* 现有 9 个 ... */
  | { type: "async_task_created"; data: AsyncTaskCreatedData }
  | { type: "async_task_event"; data: AsyncTaskEventData }
  | { type: "async_task_status"; data: AsyncTaskStatusData }
  | { type: "async_task_list"; data: AsyncTaskListData }
  | { type: "async_task_snapshot"; data: AsyncTaskSnapshotData };
```

### 1.2 Inbound（2 个）

```ts
// MonoDesk → MonoX
export type AsyncTaskCancelMsg = {
  type: "async_task_cancel";
  data: { task_id: string; reason: "user" };
};

export type AsyncTaskListQueryMsg = {
  type: "async_task_list_query";
  data: {
    session_key: string;                      // 当前活跃 session_key
    filter: { status?: string[] } | null;
  };
};

export type AsyncTaskSnapshotQueryMsg = {
  type: "async_task_snapshot_query";          // Phase 1 不实现，Phase 3 详情页按需
  data: { task_id: string; session_key: string };
};

// 扩 InboundMessage 联合：
export type InboundMessage =
  | /* 现有 3 个 ... */
  | AsyncTaskCancelMsg
  | AsyncTaskListQueryMsg
  | AsyncTaskSnapshotQueryMsg;
```

### 1.3 hello 帧扩展

```ts
// MonoDesk → MonoX 握手（src/ws/client.ts: sendHello）：
{
  v: 1, type: "hello", seq: 0, ts: Date.now() / 1000,
  data: {
    session_key: DEFAULT_SESSION_KEY,
    source: CHANNEL_NAME,            // "monodesk"
    subscribe_async_tasks: true,     // ← 新增（additive，老 MonoDesk 不发也能用）
  }
}
```

RuntimeServer 收到 hello 时：
- 检测 `data.subscribe_async_tasks === true` → conn 加入 `_async_task_subscribers` set
- 缺字段或不等于 true → conn 不订阅，async_task_event 帧不会发过去（但 list_query / cancel 等 inbound 仍正常处理）

### 1.4 MonoDeskWS 客户端扩展

```ts
// src/ws/client.ts 增 3 个方法：
class MonoDeskWS {
  cancelTask(task_id: string): void {
    this.send({ type: "async_task_cancel", data: { task_id, reason: "user" } });
  }
  queryTaskList(filter?: { status?: string[] }): void {
    this.send({
      type: "async_task_list_query",
      data: { session_key: getActiveSessionKey(), filter: filter ?? null },
    });
  }
  queryTaskSnapshot(task_id: string): void { /* Phase 3 用 */ }
}
```

---

## 2. store 状态设计

> 文件：`src/store/tasks.ts`（新建）

```ts
type AsyncTask = {
  // 完整 AsyncTaskSummary + 当前累积的 event buffer
  summary: AsyncTaskSummary;
  events: Array<{ kind: string; ts: number; payload: any }>;  // ring buffer 最近 100 条
};

type TasksState = {
  // task_id → AsyncTask（hot update via async_task_event / async_task_status）
  byId: Map<string, AsyncTask>;
  // 按 parent_session_key 索引，给 Chat 页 cross-link 用
  byParent: Map<string, Set<string>>;
  // 当前订阅的 task_id 集合（详情页打开时 add，关闭时 remove；优化 ws fanout 客户端过滤）
  subscribed: Set<string>;
};

actions:
  - upsertTask(summary: AsyncTaskSummary): void
  - appendEvent(task_id: string, ev: any): void       // ring buffer；超 100 丢弃最早的
  - updateStatus(task_id: string, status: AsyncTaskStatusData): void
  - setList(tasks: AsyncTaskSummary[]): void          // list_query 响应时全量替换
  - markSubscribed(task_id: string): void
  - markUnsubscribed(task_id: string): void
```

事件订阅路由（`src/store/tasks.ts` 内部 reducer）：
- `async_task_created` → `upsertTask`
- `async_task_event` → `appendEvent(task_id, ev)`；若 `subscribed.has(task_id)` → 同时通过回调推到 UI 详情页累积
- `async_task_status` → `updateStatus`；若是终态（completed/failed/cancelled/timed_out）→ 触发对应 Chat 流的 TaskBlock 状态更新（cross-link）
- `async_task_list` → `setList`
- `async_task_snapshot` → 全量替换单 task 的 summary + recent_events

---

## 3. 组件结构

```
src/
├── components/
│   ├── Sidebar.tsx                   # 改：currentPage 加 "tasks" + 角标
│   ├── TasksPage.tsx                 # 新建（列表）
│   ├── TaskDetailPage.tsx            # 新建（详情；复流式管线）
│   ├── TaskBlock.tsx                 # 新建（Chat 流里 fork/cancel/poll 工具块 + cross-link）
│   ├── ToolBlock.tsx                 # 改：tool_name in [fork_task,cancel_task,poll_task] 时 → 走 TaskBlock
│   └── Conversation.tsx              # 改：tool_start 路由时分发
├── store/
│   └── tasks.ts                      # 新建
├── ws/
│   ├── protocol.ts                   # 改：扩联合类型
│   └── client.ts                     # 改：扩 hello + 3 个方法
└── stream/
    └── engine.ts                     # 不改（详情页直接复用现有 StreamEngine）
```

### 3.1 Sidebar 改动

```tsx
// src/components/Sidebar.tsx
export type SidebarPage = "chat" | "skills" | "tasks";

// NavRow 加：
<NavRow
  icon={<TaskIcon />}
  active={currentPage === "tasks"}
  onClick={() => onPageChange("tasks")}
>
  Tasks{runningCount > 0 ? ` · ${runningCount}` : ""}
</NavRow>
```

`runningCount` 来自 `tasks` store 的 `byId.values()` 过滤 status==="running" 的数量。实时更新（async_task_status 帧驱动）。

### 3.2 TasksPage（列表）

详见视觉稿 §4。列表项设计：
- 状态点（●/◉/✕/⋯，按 status 分色）
- task_id 短哈希（mono，faint）+ kind 标签
- description 第一行（无截断，超 100 字符加省略号；hover tooltip 完整）
- meta key 单行展开（key: value, ... 最多 3 项）
- parent session_key + 运行时长 + timeout 上限
- running 项右侧显示 `Cancel` 按钮（发 `async_task_cancel`）

数据来源：
- 初始化：`App.tsx` 启动时调 `ws.queryTaskList()` 拉一次
- 实时：`async_task_created` 增量 upsert
- 状态变化：`async_task_status`
- 手动刷新：列表页右上角 `+ refresh` 按钮重发 `queryTaskList()`

### 3.3 TaskDetailPage（详情）

```
┌───────────────────────────────────────────────────────┐
│ ← back  t_4f9e…  review PR            [cancel]         │
│   subagent · parent: default · 47s / 30min            │
│   meta: {pr_url: "...", priority: "high"}            │
├───────────────────────────────────────────────────────┤
│ ┌ thinking · 1.2s ─────────────────────────────────┐ │
│ │ ┃ 让我先看 PR diff…                              │ │
│ └─────────────────────────────────────────────────┘ │
│ ┌ ● bash · gh pr diff 1234 · 214ms ────────────────┐ │
│ │   $ gh pr diff 1234                              │ │
│ │   diff --git a/auth.py b/auth.py                 │ │
│ │   + raw_query = f"SELECT * FROM users WHERE...   │ │
│ │   ✓ exit 0                                       │ │
│ └─────────────────────────────────────────────────┘ │
│ ┌ streaming assistant ▍ ───────────────────────────┐ │
│ │ 看到一处 SQL injection 风险，建议改用参数化查询…│ │
│ └─────────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────┘
```

实现：复用 `src/stream/engine.ts` 的 StreamEngine。订阅关系：
- 进入详情页 → `tasks.markSubscribed(task_id)` + 路由 StreamEngine
- 离开详情页 → `tasks.markUnsubscribed(task_id)`
- 详情页接 `async_task_event` 时反序列化 `data.event` 为 StreamEvent，喂给 StreamEngine

TaskDetailPage 内嵌一个独立的 `StreamEngine` 实例（区别于 Chat 流那个），因为子 agent 是独立 conversation。

### 3.4 Chat 流里的 TaskBlock（cross-link）

```
┌ ● fork_task · t_4f9e… · 47s · [running] ──────────┐
│   description: "review PR for security"          │
│   meta: {pr_url: "..."}                          │
│   ────────────                                   │
│   → open in Tasks                                │
└─────────────────────────────────────────────────┘
```

- 实现：新建 `src/components/TaskBlock.tsx`，在 `src/components/Conversation.tsx` 的 tool block 路由时分发：
  ```tsx
  if (["fork_task","cancel_task","poll_task"].includes(toolName)) {
    return <TaskBlock toolName={toolName} taskId={extractTaskId(toolStart.args, toolEnd.result)} status={taskStatus} />;
  }
  // 其他 tool 走原 ToolBlock
  ```
- taskId 来源：
  - fork_task：从 `tool_end.result.stdout`（JSON）解析 `task_id` 字段
  - cancel_task：从 `tool_start.args.task_id` 拿到
  - poll_task：从 `tool_start.args.task_ids[0]` 拿到
- 状态更新：监听 `tasks` store，status 变化时自动 re-render（running → completed 等）
- `t_4f9e…` 渲染为 `<a>` link，点击 → `setCurrentPage("tasks")` + `setActiveTaskId(taskId)`（顶层 store 加 `activeTaskId: string | null`）

### 3.5 footer 加状态点（可选）

当 `runningCount > 0` 时，statusbar 在 connection 状态旁边显示「X tasks running」（mono，faint）。点击 → 跳 Tasks 页。

---

## 4. 视觉稿（HTML demo）

文件：`MonoDesk/preview/async-task.html`

单文件 HTML，自包含 CSS（用 MonoDesk `src/styles.css` 同样的 CSS 变量），不依赖 React。展示 3 个状态：

1. **Tasks 列表**（active）：3 行（running / completed / cancelled），左侧 sidebar 含 Tasks 项
2. **Task 详情 · running**：标题 + meta + 流式 thinking / tool / token
3. **Task 详情 · completed**：标题 + meta + 完整流 + final summary 框
4. **Chat 流里的 TaskBlock**：fork_task 块 + cancel_task 块 + cross-link 样式

视觉稿风格严格对齐 `src/styles.css` 的 token：accent indigo、状态色 amber/blue/green/red、mono 用 SF Mono / JetBrains Mono、14px / 13px / 11px、max-width 居中。

视觉稿可直接 `open preview/async-task.html` 浏览器预览，用于设计 review。

---

## 5. 与 MonoX 协议的版本对齐

- MonoDesk 不锁 MonoX 版本号。7 个新 type 是 additive，老 MonoDesk 收到 `async_task_*` 帧时 try/catch 忽略（既有约定）。
- hello 帧 `subscribe_async_tasks` 字段是 additive，老 MonoX Runtime 收到未知字段忽略（既有约定）。
- MonoDesk 收到的 `data.event` 是完整 StreamEvent dict，复用现有 `frame_to_stream_event` 反序列化逻辑（新增一个 case 分支处理「外层 data.task_id + data.event 内嵌」结构）。

破坏性变更必须先改 `MonoX/spec/requirements/async-task.md` 和本文件，再动两侧实现。

---

## 6. 实施 Phase（与 MonoX 侧同步）

- **Phase 3.a**：ws/protocol.ts + ws/client.ts + store/tasks.ts（约 100 行 TS）
- **Phase 3.b**：Sidebar 改 + TasksPage 列表
- **Phase 3.c**：TaskDetailPage + 复用 StreamEngine
- **Phase 3.d**：TaskBlock + Conversation 路由 + cross-link
- **Phase 3.e**：footer 状态点 + Chat 状态更新联动

每个 Phase 配 [ ] 单测（参照 `Conversation.test.tsx` / `SkillsPage.test.tsx` 的 React Testing Library 风格）。

---

## 7. 风险（仅 MonoDesk 端）

- **StreamEngine 复用成本**：TaskDetailPage 内嵌独立 StreamEngine → 每开一个详情页一个实例。多个详情页并发（如未来 Tasks 面板支持 split view）时内存占用需关注；本期单详情页不优化
- **ring buffer 内存**：per-task 100 条 event，单 task 约 50KB（极端 token 长文）。1000 个并发 task = 50MB，可接受
- **cross-link 失效**：用户在 Tasks 列表 cancel 一个 task，Chat 流里对应的 fork_task TaskBlock 状态更新有 ~50ms 延迟（ws push）；用户感知不到，可接受
- **视觉稿 ≠ 真实现**：预览 HTML 是 mockup，最终视觉以 React 实装为准；CSS 变量保持一致以减少偏差
