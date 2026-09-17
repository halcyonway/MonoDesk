# trace-tree-redesign: Trace 详情面板重做（OTel 树形 + 左右分栏 + 默认折叠）

> **重构类 / UI**。MonoDesk 当前 trace 详情面板（`TraceDrawer.tsx`）有几处
> 撞墙：默认全展开看花眼、trace_id 用 `shortId()` 截断找不到、树只有 3 层
> 看不到 bootstrap/loop/finalize 三段、消息列表默认全开导致长会话滚几千行、
> tool 没独立节点混在 reasoning 里。本 spec 定义 UI 行为契约。
>
> 对应 server 端：[MonoX/spec/requirements/observability-otel.md](../../../MonoX/spec/requirements/observability-otel.md)
> 视觉稿：`spec/ui/trace-tree.html`

## 问题

观察当前 `src/components/TraceDrawer.tsx`（522 行，commit `edcba77`）：

1. **默认全展开** —— Run header 始终显示；`TurnNode` 用 `useOpen(true)` 每个
   turn 默认开；`SpanNode` 用 `useOpen(kind === "reasoning")` reasoning 默认开；
   `Messages` 只在 >5 条才折叠。一个长会话点 trace 按钮 → 一次性滚 10000 行
   `system prompt` 全文，看不到结构
2. **trace_id 截断** —— `shortId()` helper（line 27-30）返回 `t_97…f250` 4…4
   形式（事故定位需要完整 run_id / span_id 全量；截断后无法 grep / 复制）
3. **树只有 3 层** —— Run → Turn → Span（扁平 sibling）。没看到 bootstrap /
   loop / finalize 三段，没看到 reason + act + tool 嵌套
4. **Reasoning span 不带 tool specs** —— MonoX server 端没塞 spec 时 UI 没空位
   显示（即使 server 修好后 UI 也得加 section）
5. **没 TTFT** —— `gen_ai.client.time_to_first_token` 没渲染位
6. **单一 drawer 内嵌展开** —— 所有 JSON 都 inline 在节点下方，没有「左 tree +
   右 detail」分栏，messages 长文本只能往下滚看不到对应节点

## 目标

1. **左右分栏布局** —— drawer 宽度 `min(1400px, 96vw)`（比原 1100px 更宽，给 detail 留更多横向空间给 messages / tool_specs 长 JSON）；左 360px 是 tree，右 flex-1 是 selected node 的 detail panel
2. **trace_id / run_id / turn_id / span_id 全量显示** —— monospace 9px，
   删掉 `shortId()`（除了用于 tree 节点名字摘要，仍保留 helper）
3. **默认折叠规则** —— 仅 Run header 默认开；其余（turn / reasoning /
   act / tool / 每个 message / 每个 JSON 字段）**全部默认折叠**；点 chevron
   展开单节点，drawer 头部右侧「Expand all turns」/「Collapse all turns」批量
4. **8 个 SpanKind 渲染** —— bootstrap / loop / finalize / turn / reasoning /
   act / tool / compress；每种 kind 独立 badge 颜色
5. **Detail 面板三段式** —— INPUT / OUTPUT / ERRORS，每个 OTel attr 独立
   `<details>` 默认折叠；JSON string 自动 `JSON.parse` 后格式化显示
6. **tool 嵌套在 act 下** —— `kind=act` 是 turn 内 tool-call 容器；tree 展开时
   act 节点下挂 N 个 `kind=tool` 节点
7. **`schema_version` 兼容** —— HTTP 响应 `schema_version < 2` 时显示「该 trace
   旧版不可读」占位，不强行渲染

## 设计

### 1. 数据契约

#### 1.1 客户端 TS 类型（`src/ws/protocol.ts`）

```ts
export type SpanKind =
  | "bootstrap" | "loop" | "finalize"
  | "turn"
  | "reasoning" | "act" | "compress"
  | "tool";

export interface TraceSpan {
  span_id: string;
  parent_id: string | null;
  kind: SpanKind;
  name: string;
  start_ts: number;
  end_ts: number | null;
  status: "ok" | "error" | "cancelled";
  attributes: Record<string, any>;   // OTel-style 扁平 keys
}

export interface TraceTurn {
  turn_id: string;
  turn_idx: number;
  spans: TraceSpan[];                 // 包含 reasoning / act / compress 等
}

export interface TraceRun {
  run_id: string;
  session_key: string;
  user_text: string;
  final_text: string | null;
  start_ts: number;
  end_ts: number | null;
  status: "running" | "ok" | "error" | "cancelled";
  schema_version: number;             // 新增
  turns: TraceTurn[];
}
```

#### 1.2 `TraceClient` 缓存 key 升级（`src/observability/client.ts`）

- 旧 cache key：`sessionKey:runId`；新 key：`sessionKey:runId:v2`（schema_version
  隔离，旧缓存不污染）
- `getRecent()` 过滤掉 `schema_version < 2` 的条目（v1 不展示）

#### 1.3 `schema_version` 不兼容处理

```ts
const run = await client.getRun(sessionKey, runId);
if (run.schema_version < 2) {
  return <TraceDrawerEmpty reason="v1 不兼容" />;
}
```

### 2. 布局：左右分栏

```
┌──────────────────────────────────────────────────────────────────────────┐
│ TRACE · run_id=t_xxxxxxxxxxxx  · status=ok  · 2.4s  · 5 turns  ·  ✕  │
│                                          [Expand turns ▾] [Collapse ▾] │
├──────────────────────────────┬───────────────────────────────────────────┤
│  TREE  (360px, scrollable)    │  DETAIL  (flex 1, scrollable)            │
│  ─────────────────────────── │  ───────────────────────────────────────  │
│  ▾ Run  t_xxxxxxxxxxxx       │  ╭─ header ─────────────────────────╮     │
│     2.4s · 4624→46 · 95.6%    │  │ REASONING · s_f7...648c (full)  │     │
│                              │  │ gen_ai.request.model = MiniMax-M2.7│   │
│  ▾ bootstrap   12ms          │  │ gen_ai.client.time_to_first_token│   │
│                              │  │   = 230ms                       │   │
│  ▾ loop        4.2s          │  │ duration=2.4s · 4624→46 tok ·    │   │
│    ▾ turn #1  2.4s           │  │   95.6% cache                   │   │
│      ▾ reasoning             │  ╰──────────────────────────────────╯   │
│         s_f7...648c  2.4s    │                                          │
│         95.6%                │  ── INPUT ────────────────────────────   │
│      ▾ act                   │  ▾ gen_ai.request.model                │
│        ▾ tool: bash          │    "MiniMax-M2.7"                       │
│          84ms                │  ▾ gen_ai.request.messages  [12 msgs]    │
│      ▸ compress L1           │    ▸ msg #1: system                     │
│    ▸ turn #2  1.8s           │    ▸ msg #2: user                       │
│  ▸ finalize 50ms             │    ...                                  │
│                              │  ▾ gen_ai.request.tool_specs [3 tools]  │
│                              │    ▸ tool: bash                         │
│                              │    ▸ tool: read_doc                     │
│                              │    ▸ tool: multimodal_understand       │
│                              │                                          │
│                              │  ── OUTPUT ───────────────────────────  │
│                              │  ▾ gen_ai.response.text [512 chars]    │
│                              │    <formatted JSON string / pre>        │
│                              │  ▸ gen_ai.usage.input_tokens  = 4624   │
│                              │  ▸ gen_ai.usage.output_tokens = 46     │
│                              │  ▸ gen_ai.usage.cached_tokens = 4421   │
│                              │  ▸ gen_ai.response.finish_reasons = stop│
│                              │  ▸ gen_ai.response.reasoning           │
│                              │                                          │
│                              │  ── ERRORS ────────────────────────────  │
│                              │  (empty if no error)                     │
└──────────────────────────────┴───────────────────────────────────────────┘
```

**drawer 宽度**：`min(1400px, 96vw)`；左右各 padding 16px；中间 1px divider。

### 3. 节点默认展开 / 折叠规则

| 节点 | 默认 | 备注 |
|---|---|---|
| Run header | 展开（不可折叠） | 显示 run_id 全量 + 汇总 metrics |
| bootstrap | 折叠 | 通常 ms 级，简要展示名字 + duration |
| loop | 折叠 | 通常几秒到几十秒，简要展示名字 + duration |
| turn #N | **折叠** | 用户要求 |
| reasoning | **折叠** | 用户要求（reasoning 默认展开是当前 bug） |
| act | **折叠** | tool 容器 |
| tool | **折叠** | 每个 tool call 独立节点 |
| compress | **折叠** | |
| finalize | 折叠 | |

**全局按钮**：

- `Expand all turns` —— 展开所有 TURN 节点（其他 kind 节点不受影响）
- `Collapse all turns` —— 折叠所有 TURN 节点
- 选中节点自动展开（点 tree 节点 → 该节点 + 所有 ancestor 路径自动展开，
  detail panel 显示对应内容）

### 4. Detail 面板

#### 4.1 三段式分区

每个 span 节点的 attributes 按 OTel 命名空间分类：

| Section | 包含的 OTel key |
|---|---|
| **INPUT** | `gen_ai.request.*` + `tool.call.*` |
| **OUTPUT** | `gen_ai.response.*` + `gen_ai.usage.*` + `gen_ai.client.*` + `tool.result.*` + `tool.result.status` + `tool.result.truncated` |
| **ERRORS** | `error.type` + `error.message` + `loop.cancelled=true` |
| **META** | `service.*` + `session.*` + `loop.*` (compress 字段) |

各 section 内部独立 `<details>` 默认折叠；选中的 attr value 如果是 JSON
string，自动 `JSON.parse` 后格式化 `<pre>` 显示。

#### 4.2 节点 header（detail panel 顶部）

```
[kind badge]  name  span_id (full mono)
              duration = Xs · prompt→completion tok · cache %
              <key metrics inline>（TTFT for reasoning / tool count for act / etc.）
```

每种 kind 显示的 metrics：

| Kind | Header metrics |
|---|---|
| reasoning | `gen_ai.client.time_to_first_token` + `gen_ai.usage.input_tokens`/`output_tokens`/`cached_tokens` + `duration` + `cache %` |
| tool | `duration` + `tool.result.status` + `tool.result.truncated` |
| compress | `duration` + `loop.compress.folded_count` |
| turn | `duration` + 子 span count（reasoning + tool + compress 数量） |
| act | `duration` + 子 tool count |
| bootstrap / loop / finalize | `duration` |

#### 4.3 复杂 value 渲染

| Value 类型 | 渲染 |
|---|---|
| string / number / boolean | 简单一行显示（等宽字体） |
| string 且能 `JSON.parse`（如 `tool.call.arguments` / `tool.result`） | 格式化 `<pre>` |
| dict / list（直接 attributes 里的） | 格式化 `<pre>` |
| string 长度 > 200 chars | 自动用 `MaybeCollapse` 模式（截断 + "show full"） |
| messages list（`gen_ai.request.messages`） | 每个 message 独立 `<details>` 默认折叠；message 显示 `role` pill + content + tool_calls（跟现有 `Messages` 组件同形态） |

### 5. 样式（`src/styles.css`）

新增 class（覆盖现有 `.trace-*`）：

```css
.trace-drawer {
  width: min(1400px, 96vw);  /* 旧 680px → 1100px → 1400px */
}

.trace-body {
  display: grid;
  grid-template-columns: 360px 1fr;
  height: 100%;
}

/* Tree side */
.trace-tree { ... }                    /* 旧样式调整：去掉每个 node 内联展开 */
.trace-node-head { ... }               /* 旧 .trace-node-head 简化 */
.trace-node-kind-bootstrap { ... }     /* 新：灰 */
.trace-node-kind-loop        { ... }   /* 新：灰 */
.trace-node-kind-finalize    { ... }   /* 新：灰 */
.trace-node-kind-turn        { ... }   /* 新：accent 蓝 */
.trace-node-kind-act         { ... }   /* 旧 .trace-node-kind-act 保留 */
.trace-node-kind-tool        { ... }   /* 新：tool-bg 浅绿 */
.trace-node-kind-reasoning   { ... }   /* 旧 */
.trace-node-kind-compress    { ... }   /* 旧 */

/* Detail side */
.trace-detail { ... }                  /* 新：右栏 */
.trace-detail-header { ... }           /* 新：顶部节点 header */
.trace-detail-section { ... }          /* 新：INPUT/OUTPUT/ERRORS 三段 */
.trace-detail-key { ... }              /* 新：OTel attr key 行 */
.trace-detail-val { ... }              /* 新：value 渲染 */
.trace-details-collapsible { ... }     /* 新：每个 attr 独立 <details> 默认折叠 */

/* 全局按钮 */
.trace-toolbar { ... }                 /* 新：drawer 头部右侧按钮组 */
```

### 6. 文件清单

#### 6.1 修改

| 文件 | 改动 |
|---|---|
| `src/ws/protocol.ts` | SpanKind 加 5 个新值；TraceRun 加 `schema_version` 字段 |
| `src/observability/client.ts` | cache key 加 `:v2` 后缀；`getRecent()` 过滤 v1 |
| `src/observability/client.test.ts` | fixture 升 v2；加 v1 过滤断言 |
| `src/components/TraceDrawer.tsx` | 整组件重写：左右分栏 + 新树 + 新 detail panel + 折叠默认 + 全量 id |
| `src/components/TraceDrawer.test.tsx` | 加测试：每 kind 渲染 / 默认折叠 / 全量 id / tool 嵌套 / v1 不渲染 |
| `src/styles.css` | `.trace-*` 系列样式重写 + 新增 `.trace-detail-*` 系列 |

#### 6.2 新增

| 文件 | 内容 |
|---|---|
| `spec/ui/trace-tree.html` | 独立 HTML 视觉稿（跟 `spec/ui/async-task.html` 同形态） |

### 7. 复用现有组件 / 模式

- **`.block-head .chev`** chevron —— 替换现有 `.trace-chev` 自定义实现
  （CSS 398-402 vs 1009-1017，本质是同款旋转 SVG，合并）
- **`safeStr` helper** —— JSON 序列化 fallback；保留
- **`shortId`** —— 仍保留，但只用于 tree 节点摘要（如「turn #1」旁「u_xx…」），
  **trace_id 全量显示**改用 `span.span_id` 原值
- **`useOpen` hook** —— 改默认值为 `false`（除 Run header）；保留 hook 本身
- **`fmtMs` / `fmtTime` / `cacheHitRatio`** —— 保留
- **`<details>/<summary>` 原生 HTML** —— 已有 `.trace-raw` 用了（line 294）；
  抽成 `.trace-details-collapsible` 复用

### 8. 不变量

- **Wire types `TraceRun` / `TraceTurn` / `TraceSpan` 仍是 1:1 镜像 MonoX
  `core/observability/types.py`** —— 加字段必须双侧同步
- **`TraceClient` cache 行为不变** —— `getRun` 仍命中 cache key；
  仅 key 改名加 `:v2` 后缀让旧 entry 失效（schema 升 v2 后旧 entry 是无效数据）
- **`inspectRunId` 流程不变** —— `App.tsx:258` 设 `inspectRunId` →
  `TraceDrawer.runId` prop → `useEffect` 触发 `client.getRun`
- **Drawer 关闭方式不变** —— close 按钮 / Esc / scrim 点击 三种
- **加载 / 错误 / 重试行为不变** —— 已有 skeleton + retry 按钮
- **runId 切换 race 保护不变** —— 已有 `cancelled` flag

### 9. 不做的事

- **不重做 chat 顶栏 context 占比** —— 那是 [trace-context-percent.md](./trace-context-percent.md) 的事
- **不做 live streaming 渲染 trace** —— trace 仍然在 `FinalMessage` 后才 fetch
  全量；不做 WS push 增量 span
- **不实现「最近 runs」面板** —— `getRecent` 仍然只过滤 v1（不算 UI 改动），
  真正的 recent 列表面板是另一个 spec
- **不做 trace JSON diff** —— 不支持两个 run 对比
- **不做 trace 导出** —— 不支持「download trace as JSON」
- **不做 full-text search within trace** —— 不支持在 messages / args 里搜
  关键字
- **不做 trace 折叠状态持久化** —— 刷新 drawer 后默认折叠规则重新生效

## 验证

### 1. 单测（`npx vitest run`）

`tests/client.test.ts`（`src/observability/client.test.ts`）：
- fixture 升 v2
- 加 `getRun` 返回 v1 run → 解析为「v1 不兼容」分支
- 加 `getRecent` 过滤 v1 条目
- cache key 升级断言：旧 `:runId` key 不再被新代码命中

`tests/TraceDrawer.test.tsx`（`src/components/TraceDrawer.test.tsx`）：
- 加载完成 → 树渲染所有 kind（bootstrap / loop / turn / reasoning / act / tool / compress）
- 选中 reasoning 节点 → detail panel 显示 INPUT / OUTPUT / ERRORS 三段
- 默认折叠：turn 节点 useOpen 初始 false；messages 列表每个 `<details>` 默认折叠
- trace_id 全量：选中节点的 span_id 是完整字符串（如 `s_f7...648c` 全 15 字符），
  不是 `s_f7…648c` 4…4 截断
- tool 嵌套：act 节点展开后下面挂 N 个 tool 节点（parent_id 关系对得上）
- v1 run → 显示「该 trace 旧版不可读」占位，不渲染 tree
- 「Expand all turns」按钮 → 所有 turn 节点 useOpen=true
- 「Collapse all turns」按钮 → 所有 turn 节点 useOpen=false

### 2. 手工 e2e

```bash
cd MonoX && uv run python run.py
cd ../MonoDesk && npm run tauri dev
# 1) 发一条消息 → 等 final → 点 trace 按钮
#    预期：
#    - drawer 打开，左右分栏（宽 1400px）
#    - tree 节点：bootstrap / loop / turn #1 / reasoning / act / tool: bash / finalize
#    - turn 节点默认折叠
#    - 选 reasoning 节点 → 右侧 detail 显示
#      - 顶部 header: REASONING · s_f7...648c（span_id 全 15 字符）
#      - INPUT section 折叠: gen_ai.request.model / messages / tool_specs
#      - OUTPUT section 折叠: gen_ai.response.text / usage.* / time_to_first_token
#    - 点某个 turn 节点 → 该 turn + reason/act 展开；其他 turn 仍折叠
#    - 点 act 节点 → 看到下挂 N 个 tool 节点（tool: bash 等）
#    - 选 tool 节点 → detail 显示 tool.call.arguments + tool.result（JSON）
#    - 点 "Expand all turns" → 所有 turn 节点都展开
# 2) 长会话（10+ turn）→ 树深 4-5 层流畅；选中深层节点仍能定位
# 3) MonoX 故意配错 base_url → 重启 → 跑消息 → reasoning span detail ERRORS section
#    显示 error.type / error.message
# 4) 旧 v1 traces 文件（手动放一个 <sk>.traces.jsonl 无 schema_version）→
#    MonoDesk → 选 trace 按钮 → 「该 trace 旧版不可读」占位
```

### 3. 设计检查清单

- [ ] trace_id / run_id / turn_id / span_id 全量 monospace 9px
- [ ] 默认只有 Run header 展开
- [ ] turn / reasoning / act / tool / compress / 每个 JSON 字段默认折叠
- [ ] 选中节点高亮（左侧 tree 当前选中的节点有 accent 边框 + 背景 tint）
- [ ] detail panel INPUT / OUTPUT / ERRORS 三段分明
- [ ] tool 节点嵌套在 act 下（不是平铺 sibling）
- [ ] TTFT 显示在 reasoning 节点 header
- [ ] tool_specs 显示在 reasoning 节点 INPUT section
- [ ] 老的 v1 traces 显示「不可读」占位，不崩
- [ ] drawer 宽度 1400px
- [ ] 左右分栏 360px / flex-1，中间有 1px 分割线

## 进度

- [x] 设计：本文档
- [ ] 实现：未开始
- [ ] 单测：未开始
- [ ] 手工 e2e：未开始
- [ ] 视觉稿（spec/ui/trace-tree.html）：本文档起草时同步产出