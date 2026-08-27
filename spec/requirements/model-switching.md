# MonoDesk 模型切换联动设计

## 1. 核心理解

- **切换模型 = 下一个请求里带 provider 名**：不需要新建 session，不需要重连 ws
- **ws 连接保持不变**：用户选 provider → 下一次 user_input 的 meta 里带 `model_provider`
- **协议告知 provider 列表**：首次连接时 RuntimeServer 通过 hello 告知所有可用 provider
- **显示当前模型**：从 hello 帧的 `model` 字段获取

---

## 2. Wire 协议变更

### 2.1 出站 hello（RuntimeServer → MonoDesk）

首次连接时告知可用 provider：

```json
{
  "v": 1,
  "type": "hello",
  "seq": 0,
  "ts": 1234567890,
  "data": {
    "session_key": "default",
    "model": "gpt-4o-mini",
    "providers": ["openai", "claude"]
  }
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `model` | string | 当前默认模型名（StatusBar 显示用） |
| `providers` | string[] | 所有可用 provider 名（ModelSwitcher 下拉框用） |

### 2.2 入站 user_input（MonoDesk → RuntimeServer）

用户切换 provider 后，下一次请求带 meta：

```json
{
  "v": 1,
  "type": "user_input",
  "seq": 0,
  "ts": 1234567890,
  "data": {
    "session_key": "default",
    "text": "...",
    "meta": {
      "model_provider": "claude"
    }
  }
}
```

---

## 3. 切换流程

```
用户打开 MonoDesk
    ↓
ws.connect() → 发 hello {session_key, source}
    ↓
RuntimeServer 回复 hello {model, providers}
    ↓
MonoDesk 解析 → 更新 availableProviders → ModelSwitcher 渲染下拉框
    ↓
用户在下拉框选择 "claude"（不重连，不新建 session）
    ↓
用户发送消息
    ↓
MonoDesk 发 user_input { text, meta: { model_provider: "claude" } }
    ↓
LlmProxy.stream(options={"model_provider": "claude"}) → 请求 claude API
    ↓
后续响应正常显示
```

---

## 4. 状态管理

```typescript
// src/store/sessions.ts

export interface SessionState {
  // ... 现有字段 ...
  model: string;                    // 当前模型名（来自 hello.model）
  availableProviders: string[];     // 所有可用 provider 名（来自 hello.providers）
  selectedProvider: string;          // 用户当前选的 provider（用于下次请求的 meta）
}
```

---

## 5. UI 设计

### 5.1 ModelSwitcher 组件

位置：`Composer.tsx`（对话框输入框左下角）

形式：`<select>` 原生下拉框，与附件按钮同行排列

功能：
- 下拉框显示 `availableProviders`（若为空则不渲染）
- 当前选中项为 `selectedProvider`（下次发消息时带 `meta.model_provider`）
- 选择后直接更新，下次 user_input 自动带上 `meta.model_provider`

> **UI Demo**：[`ui/model-switcher.html`](ui/model-switcher.html) 是 ModelSwitcher 组件的视觉 demo，可直接在浏览器打开预览。

### 5.2 StatusBar

`StatusBar` 显示 `model`（来自 `view.model`），无需改动。

---

## 6. 文件变更清单

| 文件 | 变更 |
|---|---|
| `src/ws/protocol.ts` | `hello` data 加 `model` + `providers`；`InboundMessage` data 加 `meta?` |
| `src/ws/client.ts` | 解析 hello 的 providers + model；发送时支持 meta |
| `src/store/sessions.ts` | `SessionState` 加 `model` + `availableProviders` + `selectedProvider` |
| `src/stream/session_router.ts` | 处理 hello 事件更新 providers + model |
| `src/components/Composer.tsx` | 将 `.model-chip` 替换为 `<select>` 下拉框，按 provider 列表渲染选项 |

---

## 7. 向后兼容

- 旧 RuntimeServer 不发 hello → MonoDesk 的 `availableProviders` 为空，ModelSwitcher 不显示
- 新 MonoDesk 连旧 RuntimeServer → 不影响
