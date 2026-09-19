# evidence-chain：final answer 关键观点标注 ref + popover 渲染

> **Feature**。调研场景下 LLM 经常幻觉 —— 结论强但来源弱。本 spec 定义一个
> **evidence chain 机制**：agent 在 final answer 文本里给关键观点打 ref（行内
> 特殊 token），MonoDesk 端解析 ref → 渲染成可交互的「证据 chip」，hover/点击
> 展开 evidence 完整内容。本 spec **只定义渲染 + token 协议**，**不改 system prompt**；
> prompt 教法见 §6（独立议题，本 spec 末尾给草稿供后续 MonoX 端 system prompt 改动参考）。

## 1. 目标

1. **可验证的结论**：每条关键结论能追到具体来源（URL / memory 摘录 / 对话片段）
2. **不打断阅读**：ref 以 chip 形式嵌入正文，hover 才显示完整 evidence（不展开成长引文）
3. **统一渲染**：LLM emit 的 ref token 在 Markdown 渲染层自动转 chip + popover，不依赖 React 组件
4. **type 开放**：LLM 自定 type 字段（前端枚举未列出的 type 也能 fallback 渲染）

## 2. Token 协议（agent emit 形态）

### 2.1 语法

```
[[ref id=N type=TYPE key=value key=value ...]]
```

- 必须以 `[[ref` 起、`]]` 止
- 至少含 `id=` 和 `type=`
- 其它 key=value 是 content；不同 type 含义不同（见 §2.3）

### 2.2 内联位置

ref token 嵌在 final answer 文本里，**紧跟被标注的观点之后**：

```
MonoX 是 2022 年成立的 AI agent runtime [1]。
[[ref id=1 type=link url="https://monox.dev/about" title="MonoX 官网 About"]]
```

**不是脚注 / 不是文末 references 区块**。这样读者阅读时上下文不被撕开。

### 2.3 type 枚举（LLM prompt 可扩展）

| type | 必填字段 | 可选字段 | 渲染形态 |
|---|---|---|---|
| `link` | `url` | `title` | chip 显示 emoji + 完整 source 名字（详见 ref-chip-label-and-icon.md §1）；点击 chip → 新窗口打开 url；hover popover 只含 URL |
| `memory` | `key`, `snippet` | `title` | chip 显示 emoji + 完整字段；popover 显示 key + snippet |
| `snippet` | `from`, `content` | — | chip 显示 emoji + from；popover 显示 from + content |
| `tool` | `tool_name`, `call_id` | `args`, `result_summary` | chip 显示 emoji + tool_name；popover 显示 key-value 网格 |
| `other` | 任意 | 任意 | chip 显示 emoji ❓ + 第一个 attr；popover 显示所有 key=value（JSON-like） |

未识别的 type 走 `other` 路径：把所有 key=value 拼成 JSON 显示。**前端不做枚举锁定**，LLM 可以加自定义 type，prompt 控制枚举；解析层只接受 type 是 string。

**chip 文本 + icon 策略** 单独抽到 `spec/requirements/ref-chip-label-and-icon.md`（v5 引入：完整字段 + emoji icon + popover 简化）。本 spec 协议层（token 语法 / id / 必填字段）不变。

### 2.4 编号 `id`

- 由 LLM 自增计数（每条 final answer 独立计数，从 1 开始）
- chip 上显示 `[N]`（N = id）
- id 在同一 final answer 内**必须唯一**（不强制 LLM 校验，但重复会让 popover 内容混乱）

### 2.5 不允许的 token

- **不允许 `[[ref]]` 内嵌套任何字符**（不允许 `[[ref [[other]]]]`）
- **不允许 ref token 跨多个 markdown 元素**（比如 ref 内部含 `**` / `[` / `]` 字符会破坏 regex）
- 解析失败 → **fallback 为纯文本显示**（不抛错、不隐藏；让用户看到原始 token）

## 3. 渲染管线

### 3.1 入口

`src/stream/markdown.ts:inline()` 在 `esc()` 之前插一个 **ref token pre-pass**：

```ts
// 1) ref token pre-pass（必须早于 esc()，否则 < > " 被转义后 regex 匹配失败）
s = replaceRefs(s, (ref) => renderRefChip(ref));

// 2) 原有 inline 流程（esc + markdown 元素 + auto-link + code）
s = inline(s);
```

**必须早于 esc**：因为 ref content 里的 `<` / `>` / `"` 字符会被 esc 转义，导致 popover 内容显示错乱。

### 3.2 ref token pre-pass 实现

```ts
function replaceRefs(src: string, render: (r: Ref) => string): string {
  return src.replace(/\[\[ref\s+([\s\S]+?)\]\]/g, (_m, body) => {
    const ref = parseRefBody(body);
    if (!ref) return _m; // parse 失败 → 原样返回，落到 inline() 当纯文本
    return render(ref);
  });
}
```

- regex 用 non-greedy `[\s\S]+?` 匹配 body（不跨 `]]`）
- 失败时不抛错，原样保留 token 当纯文本（跟现有 markdown 容错一致）

### 3.3 Ref body parser

```ts
type RefAttrs = Record<string, string>;

interface Ref {
  id: number;
  type: string;            // 任意 string，未识别走 other
  attrs: RefAttrs;         // 除 id / type 外的所有 key=value
}

function parseRefBody(body: string): Ref | null {
  // 形态：id=1 type=link url="https://..." title="..."
  // 拆 key=value：value 可以是 bare / "quoted" / 'quoted'
  const tokens = body.match(/(\w+)=("([^"]*)"|'([^']*)'|(\S+))/g);
  if (!tokens) return null;
  const map: Record<string, string> = {};
  for (const tok of tokens) {
    const m = tok.match(/^(\w+)=(?:"([^"]*)"|'([^']*)'|(\S+))$/);
    if (!m) continue;
    map[m[1]] = m[2] ?? m[3] ?? m[4] ?? "";
  }
  if (!("id" in map) || !("type" in map)) return null;
  const id = Number(map.id);
  if (!Number.isInteger(id) || id < 1) return null;
  const type = map.type;
  delete map.id;
  delete map.type;
  return { id, type, attrs: map };
}
```

### 3.4 Chip HTML

```html
<span class="ref-chip"
      data-ref-id="1"
      data-ref-type="link"
      tabindex="0">
  <span class="ref-icon-emoji">🔗</span>
  <span class="ref-num">Playwright Trace Viewer</span>
</span>
<div class="ref-popover" data-ref-id="1">
  <!-- popover 内容按 type 渲染：link → URL section -->
  <!-- memory → Key + Snippet section -->
  <!-- snippet → From + Content section -->
  <!-- tool → key-value 网格 -->
  <!-- other → JSON dump -->
  <!-- v5：不再包含 type badge section 和 Title section（chip 已展示） -->
</div>
```

**chip 文本 + emoji icon 详见** `spec/requirements/ref-chip-label-and-icon.md`（v5）。

**popover 不在 chip 里嵌套**（避免 hover 边界闪烁）：跟 chip 同一个父容器，popover 默认 `display: none`，JS 监听 hover/focus 时显示。

### 3.5 Popover 触发

```ts
// 全局 delegation：监听 .ref-chip mouseenter / focus / click
document.addEventListener("mouseenter", (e) => {
  const chip = (e.target as Element).closest(".ref-chip");
  if (chip) showPopover(chip);
}, true);
document.addEventListener("mouseleave", (e) => {
  const chip = (e.target as Element).closest(".ref-chip");
  if (chip) hidePopover(chip);
}, true);
document.addEventListener("click", (e) => {
  const chip = (e.target as Element).closest(".ref-chip");
  if (chip) togglePopover(chip);
});
```

- **hover** → show（鼠标移上去立刻显示 evidence）
- **click** → toggle（移动端 / 触屏；点击展开，再点收起）
- **leave** → hide（hover-out 立刻收起）
- **聚焦**（tab）→ show（无障碍）

### 3.6 Streaming 边界

MonoDesk 流式渲染是 **token-by-token** 写 `<span class="ch fresh">`，
**不调用 markdown.ts**，只有 freeze（final 时）才一次性 `innerHTML = renderMarkdown(buf)`。
所以：

- **streaming 阶段**：ref token 当普通字符逐字显示（看起来是 `[[ref id=1 ...]]`）
- **freeze 阶段**：`renderMarkdown` 一次性解析 → ref token 替换成 chip HTML

**不接受**流式阶段 ref token 跨多个 token 时被打断成 `<span>...[[ref</span><span>id=1 ...]]...</span>`
（因为 freeze 时是 `innerHTML` 全量重写，会扫到所有 span 拼回字符串再 parse）。
**视觉上的撕裂**用户能感觉到一点点（streaming 看到 raw token → freeze 跳成 chip），但
跟现有 image / link 渲染的体验一致（图片链接也只在 freeze 时渲染）。

## 4. Popover 内容渲染规则

| type | popover 内容 |
|---|---|
| `link` | `<div class="ref-pop-title">{title}</div>` + `<a class="ref-pop-url" href="{url}" target="_blank" rel="noopener">{url}</a>`（点击跳转） |
| `memory` | `<div class="ref-pop-key">{key}</div>` + `<div class="ref-pop-snippet">{snippet}</div>`（snippet > 120 字符截断） |
| `snippet` | `<div class="ref-pop-from">{from}</div>` + `<div class="ref-pop-content">{content}</div>`（content > 200 字符截断） |
| `tool` | `<div class="ref-pop-tool">{tool_name}</div>` + `<div class="ref-pop-args">{args}</div>` + `<div class="ref-pop-result">{result_summary}</div>` |
| `other` / 未识别 | `<pre class="ref-pop-json">{JSON.stringify(attrs)}</pre>` |

**所有字段先经 `esc()` 转义**，避免 content 里 `<` / `>` / `&` 破坏 HTML。
**URL 字段额外做一次 sanitize**：只允许 `http:` / `https:` / `mailto:` scheme，其它 scheme 一律不渲染 `<a>`。

## 5. 不变量

- **不动 wire 协议**：ref 是 LLM 输出文本的一部分，不是单独 wire frame；MonoX 端不需要任何改动
- **不动 React 主路径**：chip + popover 是 innerHTML 字符串，不引入 React 组件
- **不动 streaming 渲染**：仅 freeze 时一次性替换；streaming 阶段显示 raw token
- **不动现有 markdown 元素**：image / link / code / heading 渲染原样
- **不动 engine.ts**：只改 markdown.ts（pre-pass + 替换函数）
- **不动 styles.css 现有 token 颜色**：ref-chip 用新的 accent 色，跟 link / image 区分
- **parse 失败不抛错**：原样保留 token 当纯文本（跟 markdown 容错一致）

## 6. Agent Prompt 教法（草稿 —— MonoX 端 system prompt 改动不在本 spec 范围）

以下草稿给后续「改 MonoX system prompt 教 agent emit ref」议题参考。本 spec 只做渲染层。

```text
## Evidence Chain（ref）

调研 / 总结 / 多源对比场景下，**关键结论必须给出 ref**，让用户能验证来源。

### 语法

```
[[ref id=N type=TYPE key=value ...]]
```

- 紧跟被标注的观点之后（行内）
- `id` 从 1 开始递增（同一 final answer 内唯一）
- `type` 与 key 见下方

### 什么时候 emit

- **关键结论**（不是显而易见的陈述）：✓ emit
- **常识 / 简单事实**（如「Python 是动态类型语言」）：✗ 不 emit
- **数据 / 引用 / 数字**（如「2024 年全球 AI 市场规模 X 亿」）：✓ emit
- **用户原文 / 之前对话片段**（如「你之前提到…」）：✓ emit snippet

### 常用 type

| type | 场景 | 必填字段 |
|---|---|---|
| `link` | 外部文章 / 文档 / GitHub URL | url, title |
| `memory` | 你从 memory 里读到的关键事实 | key（memory 索引）, snippet（≤ 200 字符） |
| `snippet` | 用户之前对话 / 某段上下文 | from（来源描述）, content |
| `tool` | 之前某次 tool 调用的关键返回 | tool_name, call_id, result_summary |

### 正确示例

```
MonoX 是 2022 年成立的 AI agent runtime [1]，核心定位是自托管 ReAct 循环 [2]。
[[ref id=1 type=link url="https://monox.dev/about" title="MonoX 官网 About"]]
[[ref id=2 type=memory key="identity/monox" snippet="MonoX 2022 年成立，定位 self-hosted agent runtime"]]
```

### 错误示例

✗ `MonoX 是 2022 年成立的 [[ref id=1 type=link url=...]]` —— ref 应该放在观点之后
✗ 整段文字一个 ref 也没有 —— 关键结论必须 ref
✗ `[[ref id=1 type=link url="..."]]` —— 缺 title 时前端只显示 URL，不直观
```

## 7. 测试

### Parser 单元测试（`src/stream/ref-parser.test.ts`）

| Case | input | 期望 |
|---|---|---|
| 1. link 完整 | `id=1 type=link url="https://x" title="T"` | `{id:1, type:"link", attrs:{url:"https://x", title:"T"}}` |
| 2. memory | `id=2 type=memory key="identity" snippet="text"` | `{id:2, type:"memory", attrs:{key:"identity", snippet:"text"}}` |
| 3. snippet 单引号 | `id=3 type=snippet from='user msg #5' content='hi'` | `attrs.from` / `attrs.content` 正确 |
| 4. bare value | `id=4 type=other note=hello` | `attrs.note = "hello"` |
| 5. id 缺失 | `type=link url=x` | `null` |
| 6. type 缺失 | `id=1 url=x` | `null` |
| 7. id 非数字 | `id=abc type=link` | `null` |
| 8. 空 body | `` | `null` |

### renderMarkdown 集成测试（`src/stream/markdown.test.ts` 新增 / 现有）

| Case | input | 期望 |
|---|---|---|
| 1. 单 ref | `text [[ref id=1 type=link url="https://x" title="T"]] more` | 包含 `.ref-chip` + `data-ref-id="1"` |
| 2. 多 ref | `A[[ref id=1 ...]] B[[ref id=2 ...]]` | 两个 chip + 两个 popover |
| 3. ref 在 markdown 行内 | `**bold** [[ref id=1 ...]] **end**` | bold 正常 + ref chip |
| 4. ref 含 `<` / `>` | `[[ref id=1 type=memory key="a<b" snippet="x>y"]]` | popover 内容正确转义 |
| 5. ref 失败（缺 id） | `[[ref type=link url="x"]]` | 原样保留 token |
| 6. ref 在 code 块里 | `` ``` [[ref id=1 ...]] ``` `` | 不渲染 chip（code block 不走 inline） |

### UI 测试（`src/components/Conversation.test.tsx` 新增 describe）

| Case | 期望 |
|---|---|
| 1. 渲染 ref chip | `.ref-chip` 元素存在 |
| 2. popover 初始 hidden | `.ref-popover` 的 `display: none` 或 visibility:hidden |
| 3. hover chip → popover 显示 | mock mouseenter → 验证 popover 不再 hidden |

## 8. 验证

```bash
cd MonoDesk && npm run typecheck
cd MonoDesk && npx vitest run
# 期望 160+ passed（原 147 + 新增 15+ 测试）
```

### 手工 e2e

1. MonoX 起 run.py → MonoDesk dev
2. 触发一段 final answer 含 `[[ref id=1 type=link url="https://monox.dev" title="MonoX"]]`
3. 流式阶段：看到 raw `[[ref id=1...]]` 字符
4. freeze 后：自动替换成 chip `[1]`
5. hover chip：popover 显示 title + URL，点击 URL 新窗口打开

## 9. 不动

- wire 协议 / MonoX 端 / agent prompt（prompt 草稿见 §6，下个议题再改）
- streaming 渲染路径（ref token 在 streaming 阶段当 raw 字符显示）
- 现有 markdown 元素（image / link / code / heading）
- React 主路径
- engine.ts