# MonoDesk

MonoX 的桌面 UI。一个连接 MonoX Runtime 的 WebSocket 客户端，把 `StreamEvent` 流渲染成极简对话界面，同时把用户输入发回 Runtime。

**MonoDesk 只做「看」和「说」——不实现任何 agent 逻辑。**

## 设计哲学

- **极简分栏**：TopBar（连接状态）→ Conversation（消息流）→ Composer（输入框）
- **流式渲染**：token 缓冲 + `requestAnimationFrame` 合并写 DOM，不逐字 React setState
- **独立进程**：不嵌入 Runtime，独立编译、独立升级

## 快速启动

```bash
# 1. 起 MonoX Runtime
cd MonoX && uv run python run.py

# 2. 起 MonoDesk 桌面 UI
npm install
npm run tauri dev          # 开发窗口（连 ws://127.0.0.1:8766）
```

环境变量覆盖连接地址：

```bash
VITE_WS_URL=ws://192.168.1.5:8766 npm run tauri dev
```

## 纯前端预览（不需要 Runtime）

```bash
open preview/index.html
```

内置 mock 事件流，加载后自动播放，可看 thinking → reasoning → tool → token → final 完整时序。

## 技术栈

- **前端**：React 18 + TypeScript + Vite
- **桌面壳**：Tauri v2（Rust 只做窗口，不写业务逻辑）
- **渲染**：`requestAnimationFrame` 直接写 DOM，React 只管结构块

设计文档见 `spec/`。
