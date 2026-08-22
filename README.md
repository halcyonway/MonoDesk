# MonoDesk

MonoX 的桌面端。以「一个 Channel」的身份接入 MonoX：MonoX 侧加一个 `MonoDeskChannel`（WebSocket server），桌面端连上去，把 `StreamEvent` 流渲染成极简界面，把用户输入反哺回 loop。

**MonoDesk 不实现任何 agent 逻辑，只做「看」和「说」。**

## 目录

```
MonoDesk/
├── spec/                            # 规格（镜像 MonoX 的 spec/ 结构）
│   ├── OVERVIEW.md                  # 概览 + 架构 + 语言选型
│   ├── goal.md                      # 长期目标 / 阶段 / 不做的事
│   ├── rule.md                      # 开发规范
│   └── requirements/
│       ├── ws-channel-protocol.md   # 传输 + JSON 线协议（核心契约）
│       └── ui-design.md             # UI 设计 + agent monitor 元素
├── preview/index.html               # 纯 HTML 高保真 mockup（无构建，直接开）
├── src/                             # React + TypeScript 客户端
│   ├── ws/                          #   protocol.ts（类型）/ client.ts（WS + 重连）
│   ├── stream/                      #   markdown.ts / engine.ts（rAF 流式渲染引擎）
│   ├── components/                  #   Conversation / Composer / Monitor / Chrome
│   ├── App.tsx                      #   布局 + 状态 + 引擎接线
│   └── styles.css                   #   移植自 preview 的完整样式
├── index.html / vite.config.ts …    # Vite 构建配置
└── src-tauri/                       # Tauri v2 桌面壳（Rust 只做窗口）
```

## 快速看前端 mockup

```bash
open preview/index.html
```

`index.html` 内置一段 mock 事件流，加载后自动播放，模拟 MonoX 的
`thinking → reasoning → tool → tool_result → token → final` 完整时序。

## 跑真实客户端（连 MonoX）

**1. MonoX 侧**：在 `config.toml` 里加 monodesk channel（单 channel 或 `channels_default = "monodesk"`）：

```toml
[[channels]]
kind = "monodesk"
host = "127.0.0.1"
port = 8765
model = "gpt-4"
```

启动 MonoX：

```bash
cd ../MonoX && uv run python run.py
```

**2. 前端**（浏览器，立即可测，不依赖 Rust）：

```bash
cd MonoDesk
npm install
npm run dev          # http://localhost:5173
```

**3. 桌面端**（需要 Rust 工具链）：

```bash
npm run tauri icon app-icon.png   # 先由一张 PNG 生成图标（bundle 需要）
npm run tauri dev                  # 开发窗口
npm run tauri build                # 打包 .app / .dmg
```

默认连接 `ws://127.0.0.1:8765`，可用 `VITE_WS_URL` 覆盖：

```bash
VITE_WS_URL=ws://192.168.1.5:8765 npm run dev
```

## 流式渲染要点

token / reasoning **不做逐字 React setState**，而是 token 缓冲 +
`requestAnimationFrame` 合并 → 直接写 DOM 文本节点（每帧一次重绘）。
React 只负责结构性块（turn / reasoning 开关 / tool 起止 / final / error / metric）。
详见 `src/stream/engine.ts`。

## 语言

TypeScript（前端）+ Tauri v2（桌面壳，Rust 只做窗口）。理由见 `spec/OVERVIEW.md`。
