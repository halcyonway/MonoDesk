# ref-chip-label-and-icon：chip 显示完整字段 + emoji icon + popover 简化

> **Change**。Image 反馈：`feat/evidence-chain-ref` 第一版 chip 显示短标签
> （domain / key 末段 / tool_name 去前缀），popover 三 section（type badge +
> URL + Title + Description）太重。读者看到 chip 猜不出 source；hover 弹一
> 大块冗余信息（title 跟 chip 重复、type badge 是 emoji 已经在 chip 里展示
> 的同位信息）。
>
> 本 spec 改 chip 文本策略 + icon 形态 + 简化 popover。不动 ref token 协议、
> 不动 system prompt（LLM 已经在 emit `title` / `key` / `from` / `tool_name`
> 等字段；前端只是换怎么展示）。

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
- memory 没填 `title` → 显示完整 `key`（如 `identity/monox`），跟 popover
  Key section 信息一致

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

**为什么不再用 SVG**：emoji 字符跨 type 视觉一致（统一圆角字形 + 颜色），
v4 5 种 SVG icon 设计工作量高 + 视觉参差，emoji 是「lowest effort, good
enough」选择。CLAUDE.md doc-thumb 反馈 emoji 在 Tauri webview 可能 broken
glyph —— 字体回退链 + macOS 上 Segoe / Noto 都自带 cover 大部分环境。

## 3. chip 视觉样式

- font-family: mono → sans（完整字段不是路径 / URL，mono 不合适）
- font-size: 9.5px → 11px（短标签变小字是 footnote 语义；完整字段需
  要更大字号才易读）
- padding: `0.5px 4px` → `2px 7px`
- border-radius: 3px → 4px
- vertical-align `top: -0.3em` → `top: -0.2em`（字号放大，offset 收紧）
- 配色：保留 type-specific（`data-ref-type="..."` 4 色 tint），跟 v4 一致

## 4. popover 简化

**v4**：每个 type popover 都含 type badge section + N 个 content section。

**v5**：去掉 type badge section（emoji 已经在 chip 里）+ chip 已展示的字
段（title）也不再重复出现在 popover。每个 type 只保留 chip 没展示的内容。

| type    | popover 内容（v5）                                          |
|---------|-------------------------------------------------------------|
| link    | URL section（favicon + mono URL）                           |
| memory  | Key section（mono）+ Snippet section（content-preview）     |
| snippet | From section + Content section（content-preview）           |
| tool    | key-value grid（tool_name / call_id / result_summary）      |
| other   | JSON dump（不变，兜底）                                     |

popover 宽度 340 → 300，padding 8 → 7（精简视觉重量）。

## 5. 不变量（跟 v4 共用）

- popover 顶部三角箭头（`::before`，JS 控制 left 居中指向 chip 文字中心）
- popover 跟 chip 同父容器，`position: absolute`，hover bridge 不破
- URL 安全：只允许 http / https / mailto，其它 scheme 不渲染 `<a>`
- favicon fallback 链：Google s2 → site /favicon.ico → 灰色圆点
- link chip 是 `<a>` 包整体，click → 系统浏览器开新窗口
- 非 link chip 是 `<span>`，hover / click 弹 popover
- streaming 阶段 ref token 当 raw 字符显示；freeze 时一次性替换成 chip

## 6. 不在本 spec 范围

- 删掉 popover（保留 popover，只是简化）
- 把 ref chip 改成 footnote `[N]` 编号（保留 chip-first 设计）
- 改 ref token 协议（不动 system prompt）
- emoji icon 主题切换（跟随 light / dark theme 不变色）

## 7. 验收

1. link chip：`title="Playwright Trace Viewer"` → chip 显示
   `🔗 Playwright Trace Viewer`（不超 24 字 + emoji），hover popover 只
   含 URL section
2. link chip：无 title → chip 显示 `🔗 github.com`（fallback 到 domain）
3. memory chip：有 title → chip 显示 `📒 <title>`，hover popover 含 Key
   + Snippet section
4. memory chip：无 title → chip 显示 `📒 identity/monox`（fallback 到
   完整 key）
5. tool chip：显示 `🔧 mono_search`
6. snippet chip：显示 `💬 user msg #5`
7. 24 字截断：40 字 title → chip 文本 ≤25 字符且以 `…` 结尾
8. emoji 字体回退：CSS 字体链 5 个 fallback 都在
9. popover 不再含 type badge section 或 Title section（删 `.ref-type-
   badge` 选择器后还能正常渲染）
10. 现有 29 个 ref-parser test case 全过（type-badge 相关断言更新）

## 8. Spec 落地文件

- `spec/requirements/evidence-chain.md` §2.3 / §3.4 更新（chip 文本列
  指向本 spec）
- `spec/ui/ref-chip-popover-v5.html` 新建（视觉稿）
- `src/stream/ref-parser.ts` 改 `shortLabel` / `renderChipIcon` /
  `renderPopover`；删 `renderTypeBadge`
- `src/styles.css` 改 `.ref-chip` 等；新增 `.ref-icon-emoji`；删
  `.ref-type-badge` / `.ref-icon`
- 测试文件按 §10 同步更新