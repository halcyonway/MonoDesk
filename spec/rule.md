# 项目规则

## 分层

```
src/ws/      WS client + 协议编解码（对齐 MonoX core/protocol/events.py 字段）
src/stream/  流式渲染层（token buffer → rAF 合并 → 文本节点），核心资产，与 React 解耦
src/ui/      React 组件（conversation / monitor / composer / rail）
src/store/   会话状态、metrics、theme
src-tauri/   桌面壳（窗口、托盘、自动连本地 MonoX）
```

- 桌面壳只做渲染与输入，不实现 agent 逻辑。
- 协议层严格对齐 `events.py` 的 dataclass 字段；改名 = 破坏契约，先改 `requirements/ws-channel-protocol.md`。
- 流式渲染层**禁止**每个 token 触发一次 React state 更新：token 只 append 到 buffer，
  由 `requestAnimationFrame` 合并后直接写文本节点（呼应 MonoX `AssistantMessage.call_after_refresh`）。

## 注释与文档原则（呼应 MonoX）

- 少写注释，代码即注释；关键决策写 why。
- 中文语境；代码标识符英文；`core / channel / adapter / event` 等术语不译。
- README / spec 写中文。

## 验证

- 每次改渲染层，`open preview/index.html` 看观感。
- v1 起：用录制的 event 序列做渲染 snapshot 测试（离线回放，不依赖真实 LLM）。
