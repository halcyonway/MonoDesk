# harness-page: 左侧栏新页面「Harness」—— 运行时配置控制中心

> **功能类 / UI first**。本 spec 只定义 MonoDesk 端的 UI 形态与交互。
> 后端 runtime config API 当前**不存在**，本文档末尾的「服务端协议」标记为 TODO，
> 本期实装时所有可调控件都退化为「本地状态 + 提示重启生效」。

## 问题

现状 runtime 配置（context window、provider 模型、provider 参数等）散在：

- `config.toml` —— 用户手改、需重启 MonoX
- `meta.model_provider` —— 通过 `user_input.meta.model_provider` 切换 provider（[MonoDesk/spec/requirements/model-switching.md](./model-switching.md)）
- 散落在多个 debug 端点

没有统一的「运行时配置中心」。用户想：
- 调 context window 上限（看 trace context% 时知道 Y 是多少）
- 切换 provider 模型（不手改 config.toml）
- 看当前生效的配置是什么

## 目标

1. 左侧栏加 **Harness** tab（在 Chat 之上、Skills 之下），点击进入「运行时配置」页面
3. 页面显示当前 session 用的 provider / model + 可调整项
4. UI 控件完整；本期缺后端 API 的部分用本地 state + 「保存（重启生效）」提示占位，**不假装能保存**

## 设计

### 1. 左侧栏 tab 位置

按用户原话「左边上面」：

```
┌─Sidebar─┐
│ ⌘ Chat     │  ← 现有
│ ⚙ Harness  │  ← 新增，放在 Chat 下面、Skills 上面
│ 📚 Skills   │  ← 现有
│ ▶ Tasks    │  ← 现有
├─────────┤
│ session list │  ← Chat 选中时显示
└─────────┘
```

### 2. 页面骨架

```
┌─ HarnessPage ──────────────────────────┐
│ ⚙ Runtime Harness       [● connected]  │  ← 顶栏：状态
├──────────────────────────────────────────┤
│ Active Configuration                     │
│   Provider: anthropic_claude              │
│   Model: claude-sonnet-4-5               │
│   Context window: 200,000 tokens         │  ← 来源：metric chunk
│                                          │
│ ▣ Controls                               │
│   Provider:  [ anthropic_claude ▾ ]      │  ← 复用 hello.providers[]
│     ├ anthropic_claude                    │
│     ├ openai_gpt4o                       │
│     └ volc_doubao                        │
│   Context limit: [ 200000 ] tokens       │  ← 输入框，可改（本期本地）
│                                          │
│ ⚠ This panel is read-only in v1.        │  ← 提示：后端待实装
│   Changes persist locally; restart       │
│   MonoX to apply on server.              │
│                                          │
│ [Save (local only)]   [Reset]            │
└──────────────────────────────────────────┘
```

### 3. 各控件语义（本期）

| 控件 | 真实能力 | 本期行为 |
|---|---|---|
| **Active Configuration**（只读区） | 显示当前 session 真实状态 | 来自 hello.data.model_provider + 最新 MetricChunk.context_window |
| **Provider selector** | 改 user_input.meta.model_provider | ✅ 真能用（沿用 [model-switching.md](./model-switching.md) 现有路径） |
| **Context limit input** | 服务端限制每个 step 的 prompt 大小 | ❌ 本地 state + 角标「local only」 |
| **Model name（只读）** | 当前 provider 的真实 model 名 | 来自 hello.data.model |
| **Save / Reset** | 持久化 runtime 配置 | 本期只存 localStorage / React state；下次启动恢复 |

### 4. 数据流

```
hello frame (provider list + active provider + model)
   ↓
HarnessPage props: { providers, activeProvider, model, contextWindow }
   ↓
本地 React state: { selectedProvider, contextLimit, dirty }
   ↓
[Save] → localStorage.setItem("harness.config", {...})
        → 下次启动 load → hydrate React state
        → ⚠ 不发到 server（API 未实装）
```

`selectedProvider` 改变时，**真的**调 `onSelectProvider`（走 model-switching 现有路径）—— 这一项是真的有效的，不算 stub。

### 5. 角标 / 状态指示

- 顶栏 `[● connected]` 显示 ws 连接状态（沿用 statusbar 现成逻辑）
- Provider selector 改完未 save 时，按钮显示「●」红点提示 dirty
- 「local only」提示用灰色小字 + 角标 `🛈`，跟 Skills / Tasks 页的「待实装」提示风格一致

### 6. 不在 Harness 里管的

- Skills 管理：现有 Skills 页
- 异步任务：现有 Tasks 页
- session 管理（创建 / 删除 / 切）：现有 sidebar session list
- Trace 详情：trace 弹层 / 独立面板

Harness 只管「运行时配置」，跟 session / skill / task 不重叠。

## 不做的事

- 不在本期实装 server 端 runtime config API（[MonoX/spec 端](#服务端协议-todo)）
- 不在 Harness 页加 provider 管理（增删 provider）—— provider 还是 `config.toml` 静态配
- 不做 user-level / session-level 配置分层 —— 本期只是「全局默认」
- 不引入配置版本号 / 回滚 —— localStorage 一份足够

## 服务端协议 TODO

下面这两条是 MonoX 端的后续工作，**本期不实装**：

1. `GET /debug/runtime/config` → 返回当前生效的 runtime config（provider, context_window, max_tool_result_tokens, ...）
2. `PUT /debug/runtime/config` body = JSON → 热更新（部分字段支持 in-memory 修改，其他标 requires_restart）

实装后 Harness 页改成：

```
[Save] → PUT /debug/runtime/config
       → server 返回 {applied: [...], requires_restart: [...]}
       → UI 分别在「已生效」「需重启」两个分组里列改动项
```

字段级别哪些可热改、哪些要重启，本期不细究 —— 那是另一份 spec 的活。

## 验证

1. 单测 `HarnessPage.test.tsx`
   - 收到 hello → Active Configuration 区正确渲染
   - Provider selector 切换 → onSelectProvider 被调 + 「●」dirty 标记出现
   - Context limit 输入框改值 → state 更新 + 「●」dirty 标记
   - Save 按钮 → localStorage 写入 + dirty 清除
   - Reset 按钮 → 回到 hello 帧的初始值
2. 手动：MonoDesk 启动 → 切到 Harness tab → 改 provider → chat 页 model chip 跟着变

## 进度

- 设计：本文档
- 实现：未开始