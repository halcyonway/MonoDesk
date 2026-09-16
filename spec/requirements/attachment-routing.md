# attachment-routing: 上传白名单 + 缩略图按 mime 路由 + paperclip icon + paste 文字透传 + bash target

> MonoDesk 附件处理 + bash tool 渲染的行为契约（2026-09）。本文件定义
> 「哪些文件能上传」、「上传后在 composer 预览和 user message bubble
> 两种位置各怎么渲染」、「paste 文字行为」、「attach button icon 语义」、
> 和「bash tool 在 head 展示 LLM 填的 target」。
>
> 实现：`src/components/Composer.tsx`、`src/components/Conversation.tsx`、
> `src/stream/markdown.ts`、`src/styles.css`。
>
> 关联 spec：
> - MonoX `spec/requirements/doc-tool-universal.md` §2.8（**白名单的来源**——
>   MonoDesk 上传白名单跟 MonoX read_doc 工具支持的格式 1:1 同步）
> - MonoX `spec/requirements/bash-target.md`（**bash tool target 字段**——
>   schema 在 MonoX，本文件定义 MonoDesk 端怎么消费）
> - `src/ws/protocol.ts` 的 `Attachment` type（`{ url, name, mime }`）

---

## 1. Context

MonoDesk 之前只接 `image/*` 上传。MonoX read_doc 工具（PR #12）支持
PDF / txt / md / csv / json 5 种 doc 格式，前端要同步放行这 5 种 + 原来
的 4 种 image，让用户能拖文件让 agent 读 / 看。

回归（已被这个 spec 覆盖）：

1. **PDF 上传失败** —— Composer 的 `addFiles` 过滤 `f.type.startsWith("image/")`，
   PDF 全部被拒；`accept="image/*"` 也不让用户在 file picker 选 PDF。
2. **缩略图变 broken icon** —— `Conversation.tsx` 的 user message bubble 对所有
   附件一律 `<img src={a.url}>`；PDF 不是图片，`<img>` 解码 PDF bytes 失败 → 浏览器
   显示 broken image（蓝色 ? 方块）。
3. **上传按钮是 image icon** —— `rect + circle + mountain` 的 image-frame
   SVG，跟 PDF / csv / doc 的「附件」含义对不上。
4. **paste 文字被当成 .txt 附件** —— `onPaste` 用了 `item.type.startsWith("image/")`，
   但 `DataTransferItem.getAsFile()` 对 `kind === 'string'` 的 item 也会返回
   File（HTML spec 规定：把字符串内容包成 File），所以 text/plain 命中了拦截路径，
   纯文本 paste 变成「附件预览」而不是输入到 textarea。

## 2. 设计

### 2.1 上传白名单（9 个 mime）

`Composer.tsx` 顶部 `ALLOWED_UPLOAD_MIME`：

```ts
const ALLOWED_UPLOAD_MIME = new Set<string>([
  // doc 5 种（read_doc 工具支持）
  "application/pdf",
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
  // image 4 种（multimodal_understand 工具支持）
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);
```

**不变量**：改这里时同步改 `MonoX/core/loop/tools/read_doc.py` 的 `_HANDLERS` 表 +
`multimodal_understand` 工具支持的 image 格式（两边要 1:1 同步）。

**不在白名单的行为**：`addFiles` console.warn 后 silently drop。
不弹 modal（paste 场景下用户根本不知道剪贴板里有什么，弹 modal 会干扰输入）。
`<input type="file" accept>` 同步更新——但只靠 accept 不够（macOS Finder
拖入 / 剪贴板可绕过），所以 defense-in-depth 在 JS 层也卡一次。

`<input type="file" accept={ACCEPT_ATTR}>` 的 `ACCEPT_ATTR` 是从白名单拼出来的
字符串（image 先 / doc 后，纯 readability 排序，不影响 browser 过滤）。

### 2.2 缩略图按 mime 路由（**两个位置**都要分流）

**位置 A：composer 上传后预览**（`Composer.tsx` 的 `attachment-preview`）—— 本 spec 不展开，
v1 阶段所有附件预览用 `<img>`，PDF 等不支持的会显示 broken image 但用户能 remove。
后续优化再统一按本 spec 2.2 的 mime 规则接入 `<object>` / doc-thumb。

**位置 B：user message bubble**（`Conversation.tsx` 的 `msg-attachments`）——
按 mime **两类**路由（#16 polish 后）：

| mime 分支 | 元素 | 说明 |
|---|---|---|
| `image/*` | `<img src={a.url} alt={a.name} title={a.name} />` | 72×72 方形 cover-fill |
| 其它（含 `application/pdf` / text/* / json） | `<a class="doc-thumb" href={a.url} target="_blank"><svg/>{MIME_LABEL}</a>` | 72×72 方形 box，inline SVG icon（PDF 带红色横幅 + "PDF" 字样；其它 mime document + 横线代表文本行）+ 大写 mime label（`PDF` / `CSV` / `JSON` / `TXT` / `MD`）；点 → 新 tab 浏览器/system viewer 打开原文件 |

**视觉一致性**：doc-thumb 跟 image-thumb 是**同一个 72×72 方形 box**，hover 背景变
`--bg-hover`。这样上传 PDF 跟上传 PNG 在 user message bubble 里视觉一致：
都是「一个 thumb」。icon + label 让用户立刻知道 mime 类型（不用点击展开）。

**为什么不用 emoji + 文件名**（v1 风格）：
- emoji 在 macOS / Tauri WebView / 不同字体下渲染不一致（用户截图里 📄 显示成
  broken 方块，PDF thumbnail 看着像 broken image）。
- 文件名 = server 端 `uuid.<ext>`（如 `6ee51565534346c1a675f8d3683075ce.pdf`），
  一长串 hex 是 noise；用户不关心 server 文件名，只关心 mime 类型。
- 横向 emoji + 文件名布局让 doc-thumb 卡片宽度自适应（最长 240px），跟 image
  的 72×72 方形不一致，多种附件并存时 bubble 行高参差。

**为什么用 inline SVG**：
- 不引入图标库（保持 emoji + 内联 SVG 的当前形态）。
- SVG 颜色走 `currentColor` / `var(--accent)`，light/dark theme 自动跟随。
- PDF 单独走「document + 折叠角 + 红色横幅 + "PDF" 字样」视觉；其它 mime
  走「document + 折叠角 + 横线代表内容行」，横线数量暗示是文本类。

**`docLabelFor(mime)` 规则**：

| mime | label |
|---|---|
| `application/pdf` | `PDF` |
| `application/json` | `JSON` |
| `text/csv` | `CSV` |
| `text/markdown` | `MD` |
| `text/plain` | `TXT` |
| 其它 | mime 子类型首段大写，取前 4 字符（如 `application/zip` → `ZIP`） |

**`title` 属性保留全名**：`title={\`${a.name} (${a.mime})\`}` —— hover tooltip
还能看到完整文件名 + mime 串，作为兜底信息（屏幕阅读器友好）。

**不再用 `<object>`**：之前 PDF 单独走 `<object>` 调浏览器原生 PDF viewer，但
小尺寸（72×72）容器里 PDF 第一页被压成残影 + macOS WebView hover 弹内置 zoom
toolbar，丑且不实用。bubble 是「缩略图 + 打开」入口，不是阅读器；完整 PDF
体验让用户点链接到 browser/system viewer 看。

**为什么不用 `<iframe>` 替代 `<object>`**：iframe sandbox 更严但 Safari / Tauri WebView
对 PDF iframe 支持参差，object 是最稳的 cross-engine 选择。

### 2.3 attach button icon：paperclip

`Composer.tsx` 的 attach button SVG path：

```tsx
<path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
```

`strokeLinecap="round"` + `strokeLinejoin="round"` 让线条圆滑。
`title` 属性文案：`"Attach file (image, PDF, txt, md, csv, json)"`。

**icon 语义**：paperclip = 通用「附件」语义，覆盖 image + doc 全 9 种支持格式。
之前的 image icon（frame + circle + mountain）跟 PDF / csv 含义对不上。

### 2.4 onPaste：只拦 kind === 'file' 的 item

```ts
const onPaste = useCallback((e: ClipboardEvent) => {
  const items = e.clipboardData?.items;
  if (!items) return;
  const fileItems = Array.from(items).filter(
    (item) => item.kind === "file" && ALLOWED_UPLOAD_MIME.has(item.type)
  );
  if (!fileItems.length) return;
  e.preventDefault();
  const files = fileItems.map((item) => item.getAsFile()).filter(Boolean) as File[];
  addFiles(files);
}, [addFiles]);
```

**不变量**：纯文本 paste（`item.kind === "string"`，text/plain / text/html /
text/uri-list）一律放行，让 textarea 走默认 paste 行为。

**根因**：`DataTransferItem.getAsFile()` 对 `kind === 'string'` 的 item
**也会返回 File**（HTML spec 规定：把字符串内容包成 File）。如果只按
`item.type` 在白名单里就拦截，text/plain（白名单里有）就会被当成 .txt 附件
收下来。

### 2.5 upload fallback mime：application/octet-stream

```ts
const resp = await fetch(UPLOAD_URL, {
  method: "POST",
  body: file,
  headers: { "Content-Type": file.type || "application/octet-stream" },
});
```

之前的 `image/png` fallback 在 PDF / csv 时会让 server 收到错的 Content-Type
（multipart 也可能用 file 自身的 type，但显式 header 兜底更稳）。

### 2.6 LocalPreview 的 mime fallback

`LocalPreview.mime` 从 `image/png` 改为 `application/octet-stream`，
跟 `file.type` 为空时一致（macOS 某些 Finder 文件 `file.type === ""`）。

## 3. 行为矩阵

| 场景 | 输入 | 行为 |
|---|---|---|
| drag & drop PDF | `file.type = "application/pdf"` | addFiles 通过；preview 为 `<img>`（v1 broken image 但用户能 remove）；send → uploadContent-Type 正确 → MonoX read_doc 处理 |
| drag & drop txt | `file.type = "text/plain"` | 同上 |
| drag & drop 未知格式（如 .zip） | `file.type = "application/zip"` | console.warn + drop；不发请求 |
| file picker 选 PDF | accept 含 `application/pdf` | 正常选；后续同 drag & drop |
| file picker 选 .rar | accept 不含 | 浏览器自动过滤；选不到 |
| 剪贴板粘贴图片 | `item.kind === "file"`, `type = "image/png"` | 拦截 → addFiles |
| 剪贴板粘贴纯文本 | `item.kind === "string"`, `type = "text/plain"` | 放行 → textarea 默认 paste |
| 剪贴板粘贴 HTML | `item.kind === "string"`, `type = "text/html"` | 放行 → textarea 默认 paste（多数浏览器自动 strip HTML） |
| PDF 上传后渲染 bubble | `Attachment.mime = "application/pdf"` | `<object data=... type="application/pdf">` |
| txt 上传后渲染 bubble | `Attachment.mime = "text/plain"` | `<div class="doc-thumb">📄 {name}</div>` |

## 4. 文件清单

### 修改

- `src/components/Composer.tsx` — 加 `ALLOWED_UPLOAD_MIME` + `ACCEPT_ATTR`；
  `addFiles` / `onPaste` 改白名单过滤；upload mime fallback 改 `application/octet-stream`；
  attach button SVG 改 paperclip；title 改 `"Attach file (...)"`
- `src/components/Conversation.tsx` — `msg-attachments` 渲染按 mime 三类路由
  （image / pdf / doc-thumb）

### 不动

- Wire protocol（`Attachment` type 不变）
- 后端 read_doc / multimodal_understand 工具
- upload server endpoint（`/debug/attachments/upload`）

### 修改（bash target 部分）

- `src/components/Conversation.tsx` — `ToolBlock` 在 `child.name === "bash"` 时
  渲染 `<span className="t-summary">`（label 后、spacer 前）；`bashSummary(args)`
  helper 提取 `target` 字段（fallback 到 `cmd`），超 30 字符前端截断
- `src/styles.css` — `.block-head .t-summary`（dim 色 + max-width 360px + ellipsis）

### 2.7 bash tool 渲染 target（Conversation.tsx）

MonoX bash tool schema（`MonoX/core/loop/tools/bash.py`）里加了 optional `target` 字段
（详见 `spec/requirements/bash-target.md`），LLM 填人类可读的一句话总结。
MonoDesk 端消费：assistant message 的 tool children 里 `name === "bash"` 时，从
`child.args`（JSON 字符串）解出 `target` 字段，在 head label 后展示。

```tsx
// Conversation.tsx:ToolBlock
{child.name === "bash" && (() => {
  const summary = bashSummary(child.args);
  return summary ? <span className="t-summary" title={summary}>{summary}</span> : null;
})()}
```

**`bashSummary(args)` 规则**：

- args 非空 + JSON.parse 不抛 + `obj.target` 是 string → 用 target
- 否则 fallback 到 `obj.cmd`（空白合并 + trim）
- 都没 → 返回 null，UI 不渲染 `<span>`
- 任意一种超过 30 字符 → `slice(0, 30) + "…"`

**样式**（`.block-head .t-summary`）：

- 颜色 `var(--text-faint)`（dim，不抢 label）
- `font-size: 12px`（比 label 略小）
- `max-width: 360px` + `text-overflow: ellipsis`（长 target 截断不撑破布局）
- `title={summary}` hover 看全文

**不渲染的场景**（其它 tool 不受影响）：

- `name !== "bash"`（fork_task / read_doc / multimodal_understand 等不渲染 summary）
- `child.args` 为 undefined / 空字符串 / JSON 损坏
- target + cmd 都为空

**不变量**：`child.args` 字段保留（折叠展开 body 仍可见完整 bash 命令 +
其它参数）；head 只显示 summary，不动 args 的可见性。## 5. 验证

### 5.1 vitest

`npm test` 全跑，期望 12 files / 128 tests pass。

### 5.2 手工 e2e

```bash
# MonoX runtime 起在另一个终端
cd MonoDesk && npm run dev
```

测试场景：

1. **paperclip icon** —— 打开 composer，attach button SVG 是回形针（不是
   之前 image-frame 的 rect+circle+path）。
2. **PDF 上传** —— 点 attach button → file picker 弹出 → 选 PDF → 缩略图
   出现在 composer 预览（v1 仍是 broken image，但能 remove）→ 点 send →
   MonoX 收到 user message 带 PDF attachment。
3. **PDF 在 bubble 渲染** —— 上传完 PDF 后 user message bubble 里的缩略图
   是「📄 + 文件名」doc-thumb 卡片（不是嵌入的 PDF viewer），hover 时背景变
   `--bg-hover`，点击 → 新 tab 浏览器/system viewer 打开原 PDF。
4. **csv 上传** —— 拖入 .csv → bubble 缩略图是 📄 + 文件名（doc-thumb）。
5. **paste 文字** —— 在 textarea 里 Cmd+V 一段文字 → 文字进 textarea，
   **不**出现附件预览。
6. **paste 图片** —— 复制一张图片后 Cmd+V → 出现附件预览，textarea 不变。
7. **drag & drop .zip** —— 拖入 .zip → console.warn + 不出现预览。
8. **bash target 展示** —— agent 调 bash（带 `target`）→ tool head label 后
   出现 dim 色 summary（≤ 30 字符）；超长 target 显示「…」。`name !== "bash"`
   的 tool 不显示 summary。
