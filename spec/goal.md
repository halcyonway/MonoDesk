# 长期目标

MonoDesk 是 MonoX 的桌面端 channel。目标不是重写 MonoX，而是一个**只负责「看」和「说」**
的桌面外壳：把 MonoX 的 `StreamEvent` 流渲染成高品味的极简界面，把用户输入反哺回 loop。

## 一句话目标

> 打开一个桌面窗口，连上本地 MonoX，用 CodeX 级别的排版看 agent 思考、调工具、流式输出；
> 未来逐帧打磨 TTFT 等流畅度指标。

## 设计哲学

1. **薄 channel**：MonoDesk = 一个 `Channel` 实现 + 一层 WS 传输。不改 core，不碰 loop。
2. **渲染优先**：核心资产是流式渲染管线（token → rAF 合并 → 文本节点），不是 feature 数量。
3. **极简不简陋**：克制的单色排版 + 只给「状态」上色；留白即界面，用排版而不是装饰建立质感。
4. **可观测**：TTFT / tokens/s / step latency 一屏可见，为流畅度打磨铺路。

## 阶段

| 阶段 | 内容 |
|---|---|
| v0（现在） | 纯 HTML mockup，验证 UI 与协议观感 |
| v1 | MonoX 侧 `MonoDeskChannel`（WS server）+ MonoDesk Tauri/React 真客户端，打通端到端 |
| v2 | 流畅度仪表（TTFT / tok/s / 分阶段延迟）+ 逐帧打磨 |

## 不做的事

- ❌ 不内置 agent 逻辑（那是 MonoX `core/loop` 的事）
- ❌ 不做多租户 / 云端（本地单用户桌面端）
- ❌ 不重写 MonoX 协议，只做 JSON 序列化映射
- ❌ 不追求 feature 数量，只追求「看 agent 干活」这件事做到极致
