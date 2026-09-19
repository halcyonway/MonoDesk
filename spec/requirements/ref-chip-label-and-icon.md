# ref-chip-label-and-icon：chip 完整字段 + emoji icon + popover 形态

> **Change**。`feat/evidence-chain-ref` 分支经历两轮迭代：
> - **v5**：chip 显示完整字段 + emoji icon；popover 简化到只剩 URL（chip 已展示 title / emoji / type 重复）
> - **v5.1**：popover 加回 **type 行 + content section**（v5 简化过头）；**不渲染 URL section**（URL 走 `<a>` native 跳转）；**id 字段删除**（LLM 不需要递增计数，parser 用渲染顺序号代替）
>
> 本 spec 覆盖 v5 + v5.1 形态，协议变更部分（id 删除）由 `spec/requirements/evidence-chain.md` §2.4 同步。

## 1. chip 文本

每个 type 的 chip 文本走 **完整字段 fallback**，不再截短。

| type    | 文本来源                                          |
|---------|---------------------------------------------------|
| link    | `a.title` \|\| `extractDomain(a.url)`（fallback） |
| memory  | `a.title` \|\| `a.key`（fallback）                |
| snippet | `a.from`                                          |
| tool    | `a.tool_name`                                     |
| other   | 第一个 attr value（截短）                         |

**长度上限**：统一 24 字符。超出加 `…`（`truncate()` 工具函数）。

> 为什么 24：之前 shortLabel 各 type 独立 10/12/14 字符上限，凑完整字段
> 会让 chip 撑一行；24 字符约 12 个汉字 / 24 ASCII，是「inline 一个 chip 不
> 撑行」的实测上限。LLM 写超长 title 时自然降级到 `…`。

**fallback 的目的**：

- link 没填 `title` → 显示 domain（如 `github.com`），至少有 source 提示
- memory 没填 `title` → 显示完整 `key`（如 `identity/monox`）

## 2. chip icon

chip 前面一个 **inline emoji 字符**，由 type 决定（v5 引入，替代 v4 的 5
种 SVG icon）。

| type    | emoji |
|---------|-------|
| link    | 🔗    |
| memory  | 📒    |
| snippet | 💬    |
| tool    | 🔧    |
| other   | ❓    |

**字体回退链**（CSS）：

```css
font-family: "Apple Color Emoji", "Segoe UI Emoji",
             "Noto Color Emoji", "EmojiOne Color", sans-serif;
```

> macOS / iOS 用 Apple Color Emoji；Windows 用 Segoe UI Emoji；Linux /
> Tauri webview 走 Noto Color Emoji。完全没装 emoji 字体的环境会渲染成
> 空字形（chip 文字仍可见）。

## 3. chip 视觉样式

- font-family: mono → sans（完整字段不是路径 / URL，mono 不合适）
- font-size: 9.5px → 11px（短标签变小字是 footnote 语义；完整字段需要更大字号才易读）
- padding: `0.5px 4px` → `2px 7px`
- border-radius: 3px → 4px
- vertical-align `top: -0.3em` → `top: -0.2em`（字号放大，offset 收紧）
- 配色：保留 type-specific（`data-ref-type="..."` 4 色 tint）

## 4. popover 形态（v5.1）

**v4**：每个 type popover 含 type badge section + N 个 content section（type badge + URL + Title + Description 三 section 太重）。

**v5**：去掉 type badge + chip 已展示的 Title；只剩 URL（**简化过头**，user 反馈「太轻」）。

**v5.1**：加回 type 行 + content section，**不渲染 URL section**（URL 在 `<a href=...>` 走原生跳转，popover 没必要重复）。

```
[type 行]   emoji + "link" / "memory" / "snippet" / "tool" / "other"
            圆角胶囊（4 色），跟 v4 type badge 视觉一致但用 emoji 字符代替 SVG
[content]   link    → desc 字段（没有 desc 时整个 section 省略）
            memory  → snippet 字段（content-preview 样式 + 底部渐变）
            snippet → content 字段（content-preview 样式）
            tool    → key-value 网格（tool_name / call_id / result_summary）
            other   → JSON dump（不变，兜底）
```

**type 行颜色**（v4 沿用，跟 emoji 字符组合）：

| type    | bg          | color       |
|---------|-------------|-------------|
| link    | `#e8f1ee`   | `#2d7a64`   |
| memory  | `#f0e8fc`   | `#7a4db8`   |
| snippet | `#e8f4e8`   | `#3d8b40`   |
| tool    | `#fef3e2`   | `#9a5a10`   |

**为什么 v5.1 不渲染 URL section**：

- URL 走 `<a target="_blank">` native click（browser）或 `@tauri-apps/plugin-shell` 的 `open()`（Tauri），点击直接跳转
- chip 上 emoji + title 已经说明 source，URL 是细节（重复信息冗余）
- 节省 popover 垂直空间

## 5. 不变量（v4 / v5 / v5.1 共用）

- popover 顶部三角箭头（`::before`，JS 控制 left 居中指向 chip 文字中心）
- popover 跟 chip 同父容器，`position: absolute`，hover bridge 不破
- URL 安全：只允许 http / https / mailto，其它 scheme 不渲染 `<a>`
- link chip 是 `<a>` 包整体（`<a href="..." target="_blank" rel="noopener noreferrer">`）
- 非 link chip 是 `<span>`，hover / click 弹 popover
- streaming 阶段 ref token 当 raw 字符显示；freeze 时一次性替换成 chip

## 6. 不在本 spec 范围

- 删掉 popover
- 把 ref chip 改成 footnote `[N]` 编号
- emoji icon 主题切换（跟随 light / dark theme 不变色）
- popover 动画（之前没有，本 spec 不引入）

## 7. 验收

1. link chip：`title="Playwright Trace Viewer"` → chip 显示
   `🔗 Playwright Trace Viewer`（不超 24 字 + emoji），hover popover 含
   type 行（🔗 link，绿底胶囊）+ content section
2. link chip：无 title → chip 显示 `🔗 github.com`（fallback 到 domain）
3. memory chip：有 title → chip 显示 `📒 <title>`，hover popover 含 type 行
   + snippet section
4. memory chip：无 title → chip 显示 `📒 identity/monox`（fallback 到完整 key）
5. tool chip：显示 `🔧 mono_search`
6. snippet chip：显示 `💬 user msg #5`
7. 24 字截断：40 字 title → chip 文本 ≤25 字符且以 `…` 结尾
8. emoji 字体回退：CSS 字体链 5 个 fallback 都在
9. popover 含 type 行 + content section，**不含** URL section（`.ref-url-display` 不出现）
10. ref-parser test case 全过（v5.1 协议 + 渲染断言）

## 8. Spec 落地文件

- `spec/requirements/evidence-chain.md` §2.1 / §2.3 / §2.4 / §3.3 / §3.4 更新
  （id 字段删除 + popover v5.1 形态 + chip ↔ popover 配对改用渲染顺序号）
- `spec/ui/ref-chip-popover-v5.html` 视觉稿体现 v5.1 形态
- `src/stream/ref-parser.ts` 删 `Ref.id` + 改 `parseRefBody` / `replaceRefs` /
  `renderRefChip` / `renderPopover` / 恢复 `renderTypeBadge`
- `src/styles.css` 恢复 `.ref-type-badge` 样式（v5.1 需要 type 行）
- `src/components/Conversation.tsx` click handler 走 Tauri `plugin-shell` /
  browser native `<a>`
- 测试文件按 §10 同步更新