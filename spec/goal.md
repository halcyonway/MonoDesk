# 长期目标

MonoDesk 是 MonoX 的桌面端 channel。目标不是重写 MonoX，而是一个**只负责「看」和「说」**
的桌面外壳：把 MonoX 的 `StreamEvent` 流渲染成高品味的极简界面，把用户输入反哺回 loop。

## 一句话目标

> 打开一个桌面窗口，连上本地 MonoX，用 CodeX 级别的排版看 agent 思考、调工具、流式输出；
> 流畅度指标（TTFT / tokens/s）打磨到本地 LLM 也能舒服。

## 设计哲学

1. **薄 channel**：MonoDesk = 一个 WS client + 一层 StreamEngine 渲染层。不改 core，不碰 loop。
2. **渲染优先**：核心资产是流式渲染管线（token → jitter buffer → 单字淡入 → DOM 节点），
   不是 feature 数量。
3. **极简不简陋**：克制的单色排版 + 只给「状态」上色；留白即界面，用排版而不是装饰建立质感。
4. **可观测**：TTFT / tokens/s / total / prompt·completion 一行可见，为流畅度打磨铺路。
5. **本地优先**：连 MonoX 的本机 ws（:8765），不上云；离线不工作是可接受的。

## 阶段

| 阶段 | 内容 | 状态 |
|---|---|---|
| v0 | 纯 HTML mockup，验证 UI 与协议观感 | ✅ |
| v1 | MonoX Runtime ws server + MonoDesk Tauri/React 真客户端，端到端打通 | ✅ |
| v2 | jitter buffer + 单字淡入；statusbar 4 项指标；多 session 隔离 | ✅ |
| v3 | 上线打磨：更多 markdown / 代码高亮 / 主题 / 错误恢复 | ⏳ |

## 优先级 / 待打磨项

- **Markdown 表格**（已加）、任务列表（待加）
- **代码块高亮**（用 shiki / highlight.js 都行；先不上，先保流畅度）
- **图片 / 文件附件**（与 MonoX `InboundEvent.attachments` 对齐）
- **tool 输出懒展开**（已支持折叠；展开更多待加）
- **会话导出 / 导入**（Markdown / JSON）
- **多 LLM 并排**（同一 Runtime 跑多 model 对比；属于 monoX feature）

## 不做的事

- ❌ 不内置 agent 逻辑（那是 MonoX `core/loop` 的事）
- ❌ 不做多租户 / 云端（本地单用户桌面端）
- ❌ 不重写 MonoX 协议，只做 JSON 序列化映射
- ❌ 不追求 feature 数量，只追求「看 agent 干活」这件事做到极致
- ❌ 不写自己的代码高亮 / markdown 引擎（用主流库）
- ❌ 不做跨平台同步（每个桌面端独立 localStorage）