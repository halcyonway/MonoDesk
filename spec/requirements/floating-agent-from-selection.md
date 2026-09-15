# floating-agent-from-selection: 从会话片段起一个独立的 agent 会话

> MonoDesk UI 新功能（2026-09）。本文件是行为契约 + 设计意图。
> 用户反馈：「用户可以选中会话中任意片段，然后起一个悬浮窗口发起 agent 会话，
> 这个 agent 会话需要继承当前会话历史，但是独立的 session。」
> 闭环 MonoDesk，不动 MonoX。

---

## 1. Context

用户在做多轮对话时经常遇到这种场景：
- 在主对话读到某条 agent 的解释（"刚才那段说的是 X"），想**围绕这条解释继续深挖**
- 在长对话里某段代码 / 某个结论，**想 fork 出独立分支**展开追问（不污染主对话）
- 当前对话已经拐到 Y 方向，但**想回到刚才 Z 那个点**单独研究

现在的解决方案是手动：
1. 复制那段文字
2. 手动开新会话
3. 把片段粘到新会话的 system / 第一条 user message 里
4. 再加上自己的问题

繁琐、容易丢上下文、没 UI 锚点。本 feature 直接闭环这段路径。

---

## 2. 设计

### 2.1 用户流程

```
[主对话 Chat 流]
   ↓ 用户用鼠标选中一段文字（agent 回答 / user 输入 都行）
[片段上方浮出一个小按钮：✨ Branch]
   ↓ 点击按钮
[右下角弹出 Floating Panel]
   ├─ Header: "Fork from <parent session name>" + × 关闭 + ⤢ Expand
   ├─ Quoted snippet: 选中的文字（带 "..." 截断标记）
   ├─ Collapsed parent context: 父会话最近 1-2 条消息（点击展开看完整）
   ├─ Stream area: agent 回复（跟主对话同款渲染）
   └─ Composer: 底部输入框 + Send 按钮
   ↓ 用户输入问题 + Enter
[新的 agent session 在 Panel 里跑起来]
   ├─ 新 session_key: `monodesk:fork-<timestamp>-<rand>`
   ├─ 第一条 user_input 包含:
   │   text = "<parent_context>\n\n[Selected]: <snippet>\n\n[Question]: <user_question>"
   │   meta = { fork_from: <parent_key>, snippet: <snippet> }
   └─ Agent 跑完后结果继续 stream 进 Panel
   ↓ 用户继续在 Panel 里追问（独立 session，可来回多轮）
   ↓ 点 "⤢ Expand" → 主视图切到这个新 session（标准 Chat 视图完整接管）
```

### 2.2 状态归属

```
   ┌─ 主对话 session (active)
   │     ↓ user 选中文字
   │     ↓ 点击 Branch
   │     → App state: floatingPanel = {
   │           parentKey: <active_session>,
   │           parentLastMsg: <最近一条 msg 摘要>,
   │           snippet: <选中的纯文本>,
   │           forkKey: <新建的 session_key>,
   │         }
   └─ 新 fork session (在 Panel 内活跃)
         ↓ agent 回复
         ↓ 跟主对话共用 engine + sessionStates Map
         ↓ 但 session_key 不同，所以路由独立
```

Panel 不开新 engine 实例 —— 复用现有 `engine`，靠 `session_key` 路由（同 Chat 流）。
Panel 关闭只是清 `floatingPanel` state，session 仍在 sidebar 里（用户可重新打开）。

### 2.3 Wire 协议

**不变 MonoX**，所有协议都用现有的 `user_input`：

```ts
// Panel 第一次发送时
{
  type: "user_input",
  data: {
    session_key: <new_fork_key>,
    text: [
      "[From session: <parent_title>]\n",
      "<parent_last_user_msg 或 parent_last_assistant_msg 截断 200 字>\n\n",
      "[Selected snippet]:\n",
      "<snippet>\n\n",
      "[Your question]:\n",
      "<user_input>",
    ].join(""),
    meta: {
      fork_from: <parent_key>,
      snippet: <snippet>,    // 完整 snippet 单独存一份（不靠 text parse）
      parent_context: <parent_last_msg>,
    },
  },
}
```

后续用户在 Panel 追问，跟普通 user_input 一样。

### 2.4 UI 设计

**SelectionFab**（浮出按钮）：
- 监听 `#conversation` 区域的 `mouseup` / `selectionchange`
- 检测到非空 selection → 在 selection boundingRect 上方居中显示
- 视觉：`28×28 圆形按钮，bg=accent，icon=✦ sparkle 白色，shadow=0 4px 12px`
- 200ms fade-in / out；点击 / 选中变化触发位置重算
- click → 触发 `onBranch(selectionText)`
- Esc / 选中清空 / 滚动 → 自动隐藏

**FloatingAgentPanel**：
- 位置：`position: fixed; right: 20px; bottom: 20px;`
- 尺寸：宽 440px，高 `min(540px, 80vh)`
- 头部可拖动（实现 drag 重定位，落到屏幕内 clamp）
- z-index 高于主内容
- 关闭：× 按钮 / Esc
- 内部结构：
  ```
  ┌─ Header ────────────────────┐
  │ ↗ Fork from <title>   ⤢ × │
  ├─ Snippet (quoted) ────────┤
  │ "...这段文字..."            │
  │ [+ show parent context]   │
  ├─ Stream area (scrollable) ┤
  │ ...agent 回复 / thinking   │
  ├─ Composer ────────────────┤
  │ [textarea]   [Send]        │
  └────────────────────────────┘
  ```

### 2.5 边缘情况

| 情况 | 处理 |
|---|---|
| 选中包含 tool block / Markdown 表格 | `selection.toString()` 拿到纯文本，丢格式 |
| 选中为空 / 仅空白 | Fab 不显示 |
| 选中发生在 composer / sidebar / panel 内部 | Fab 不显示（只对 `#conversation` 生效） |
| 主对话正在 streaming（agent 还在回复） | 允许 fork：选的是历史消息，不影响主对话 |
| 已有一个 Panel 开着的状态下又 fork | 替换：关掉旧的，开新的（v1 单 Panel） |
| Panel 内 session 跑完后用户关闭 Panel | session 仍存在 sidebar，下次可重新打开（持久化在 `sessionStates`） |
| 主对话 session 被删除 | Panel 内的 fork 不受影响（独立 session_key） |
| 网络断 / runtime 不在 | Panel 显示离线提示，composer 禁用 |

---

## 3. 文件清单

### 新增（3 个文件）

| 文件 | 内容 |
|---|---|
| `src/components/SelectionFab.tsx` | 选中检测 + 浮出按钮（DOM-only，纯原生 selection API） |
| `src/components/FloatingAgentPanel.tsx` | 浮窗 UI（header drag / snippet / stream / composer） |
| `src/components/SelectionFab.test.tsx` | 单测：选中变化 → 按钮位置；空选 → 隐藏；点 Esc → 隐藏 |

### 修改（3 个文件）

| 文件 | 修改 |
|---|---|
| `src/components/Conversation.tsx` | 暴露 `onSelectionBranch(text)` 回调（hover 时显示 Fab 的位置） |
| `src/App.tsx` | 加 `floatingPanel` state（parentKey / snippet / forkKey）+ 渲染 SelectionFab 和 FloatingAgentPanel |
| `src/store/sessions.ts` | 加 `newForkSession(parentKey, snippet)` helper（生成 forkKey + 自动标题 "Fork: <snippet 前 30 字>"） |

### 不动

- `ws/client.ts` / `ws/protocol.ts`（协议不变，用现有 user_input）
- `stream/engine.ts` / `stream/session_router.ts`（路由不变，新 session 走同一份 engine）
- `store/tasks.ts` / `extensions/skills/` 等

---

## 4. 验证

### 4.1 vitest 全跑

```bash
cd MonoDesk && npx vitest run
# 期望：124+ passed（122 + SelectionFab 2 个 test）
```

新增 test：
- `SelectionFab.test.tsx`：mock DOM selection，触发 mouseup，断言按钮位置 / 隐藏条件

### 4.2 手工 e2e

```bash
cd MonoDesk && npm run dev
# 测：
# 1) 选中一段 agent 回复 → 看到 ✦ 浮出按钮
# 2) 点按钮 → 右下角 Panel 弹出，含选中文本
# 3) Panel 输入问题 + Enter → agent 在 Panel 内回复（不污染主对话）
# 4) 主对话 session 不变；sidebar 出现新的 "Fork: ..." session
# 5) 关掉 Panel → sidebar 还有新 session；可从 sidebar 切回去
# 6) ⤢ Expand → 主视图切到新 session，Panel 关闭
# 7) 选中 composer / sidebar → 不浮出按钮
# 8) Esc → Panel 关闭
```

### 4.3 设计检查

- Fab 按钮 hover / active 反馈
- Panel 拖动不超出屏幕
- Panel 流式渲染跟主对话一致（同一份 StreamEngine）
- Panel 在窄屏（< 600px）下退化为全屏 modal

---

## 5. 关键不变量

- `sessionStates` Map 不变 schema，新 fork session 跟普通 session 同结构
- `ws/client.ts` `user_input` 不变
- `engine.ts` / `session_router.ts` 不变
- StreamEngine 仍是 React-decoupled（Panel 内 token 不触发 React re-render）
- 主对话 session 不受 Panel 影响（独立 session_key）

---

## 6. 不做（明确范围）

- 不开新 Tauri window（用户说的"悬浮窗口"按 in-app floating panel 实现）
- 不改 ws 协议
- 不做 agent 端的 fork（agent 看到的 user_input 是单条大 message，里面包含 parent context）
- 不做 fork session 的撤销 / merge
- Panel 不做 resizable（v1 固定尺寸，可拖位置）
- 不做多 Panel 并列
- 不持久化 Panel 的开 / 关状态（重启后默认关）
- 不做选中图片 / 代码块的特殊处理（按纯文本走）