// [[ref type=... ...]] token 解析 + 渲染。
//
// 协议见 spec/requirements/evidence-chain.md（v5.1）：
// - 形态：`[[ref type=TYPE key=value ...]]`
// - type 任意 string（未识别走 other）；id 字段已删除（LLM 不需要递增计数）
// - 旧 token 含 `id=N` 时静默忽略，不报错（向后兼容）
// - parse 失败 → null，调用方原样保留 token 当纯文本
//
// 渲染层独立：parser 只产出结构化 Ref，renderMarkdown 负责把它转成 innerHTML
// 字符串（chip + popover）。

export interface Ref {
  // id 已删除（v5.1）：chip ↔ popover 配对改用 replaceRefs 分配的 seq
  type: string;
  attrs: Record<string, string>;
}

// 提取 [[ref ...]] token 的 body（type=link url="x" title="t" content="c"）。
// non-greedy，停在第一个 ]]。整段 raw 保留作为 fallback（parse 失败时）。
const REF_RE = /\[\[ref\s+([\s\S]+?)\]\]/g;

// 容错 fallback：LLM 偶尔 emit 不闭合的 ref token（截断在 freeze 边界 /
// 内部流式出错），形如 `[[ref type=link url="..." title="..."`。匹配段尾
// （`\n\s*\n`）或字符串末尾（`$`）作为终止 —— 第一个 pass 之后剩下的
// `[[ref ...` 都是没闭合的。
const REF_UNCLOSED_RE = /\[\[ref\s+([\s\S]+?)(?=\n\s*\n|$)/g;

// 单个 key=value：value 是 "..." / '...' / bare。
// KV_RE = /(\w+)=("([^"]*)"|'([^']*)'|(\S+))/
// m[1]=key, m[2]=含引号整体/bare, m[3]=双引号 content, m[4]=单引号 content, m[5]=bare
const KV_RE = /(\w+)=("([^"]*)"|'([^']*)'|(\S+))/g;

// URL sanitize：只允许 http / https / mailto，避免 javascript: 等危险 scheme
// 在 popover `<a>` 里被点击触发 XSS。
const SAFE_URL_RE = /^(https?|mailto):/i;

export function parseRefBody(body: string): Ref | null {
  // 重置 lastIndex（KV_RE 是 /g，全局共享时多次调用会出问题）
  KV_RE.lastIndex = 0;
  const map: Record<string, string> = {};
  let m: RegExpExecArray | null;
  while ((m = KV_RE.exec(body)) !== null) {
    // m[1]=key, m[3]=双引号 content, m[4]=单引号 content, m[2]/m[5]=fallback（含引号 / bare）
    map[m[1]] = m[3] ?? m[4] ?? m[5] ?? m[2] ?? "";
  }
  // v5.1：type= 是唯一必填字段；id= 静默忽略（LLM 旧 token 兼容）
  if (!("type" in map)) return null;
  const type = map.type;
  delete map.type;
  // 兼容：旧 token 含 id=N 时不进 attrs、不进 Ref（silent ignore）
  delete map.id;
  return { type, attrs: map };
}

// 扫描 src，把所有 [[ref ...]] token 替换成 render(ref, seq) 返回的字符串。
// seq：渲染时按出现顺序分配 chip 序号（1-based），用作 chip ↔ popover 配对 key（HTML data-ref-id）。
// 解析失败 → 保留 raw token 当 fallback（不抛错，跟 markdown 容错一致）。
//
// 两阶段解析：
//   pass 1：闭合的 [[ref ...]] —— 正常 emit chip
//   pass 2：未闭合的 [[ref ...（到段尾 / 字符串尾）—— LLM 偶尔 emit 不完整，
//           自动加 ]] 后再走 parser；parse 仍失败就补 ]] 后保留 raw，避免
//           用户看到挂着的 raw token
export function replaceRefs(
  src: string,
  render: (ref: Ref, seq: number, raw: string) => string,
): string {
  REF_RE.lastIndex = 0;
  REF_UNCLOSED_RE.lastIndex = 0;
  let seq = 0;

  // pass 1: 闭合 token
  let out = src.replace(REF_RE, (_m, body: string) => {
    const ref = parseRefBody(body);
    if (!ref) return _m;
    seq++;
    return render(ref, seq, _m);
  });

  // pass 2: 未闭合 token（LLM 流式错误 / freeze 截断）。手动加 ]] 后重解析。
  // 只在 src 含 `[[ref` 时跑（避免无意义正则）。
  if (out.includes("[[ref")) {
    out = out.replace(REF_UNCLOSED_RE, (m, body: string) => {
      const fixed = m + "]]";
      const ref = parseRefBody(body);
      if (!ref) return fixed; // 补 ]] 后保留 raw 文本（不再挂半个 token）
      seq++;
      return render(ref, seq, fixed);
    });
  }

  return out;
}

// HTML 转义：用于 popover 内容，避免 attrs 里的 < > & " 破坏 DOM。
function he(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

// popover 内容按 type 渲染（v5.1）。
// spec: spec/requirements/ref-chip-label-and-icon.md §4
//   - type 行（v4 type badge 的 emoji + label 形态，圆角胶囊 + 4 色）
//   - content section（chip 没展示的详情字段）
//   - 不渲染 URL section（URL 走 <a target="_blank"> 原生跳转 + Tauri 走
//     plugin-shell，避免 popover 重复）
// 所有字段都 he() 转义；URL 额外走 safeUrl() 过滤危险 scheme。
function renderPopover(ref: Ref): string {
  const a = ref.attrs;
  const typeBadge = renderTypeBadge(ref.type);

  // section 行：包含 label + value，底部分隔线
  const section = (label: string, value: string) =>
    `<div class="ref-pop-section">` +
    `<div class="ref-pop-label">${he(label)}</div>` +
    `<div class="ref-pop-value">${value}</div>` +
    `</div>`;

  let contentHtml = "";
  switch (ref.type) {
    case "link": {
      // v5.1：只取 desc（不渲染 URL section）
      const descRaw = a.desc || "";
      const descIsUrl = /^(https?|mailto):/i.test(descRaw);
      const desc = !descRaw || descIsUrl ? "" : he(truncate(descRaw, 240));
      if (desc) contentHtml = section("Content", desc);
      break;
    }
    case "memory": {
      // v5.1：只取 snippet（不再单独渲染 Key section —— key 已在 chip fallback 路径里）
      const snippet = he(truncate(a.snippet || "", 240));
      if (snippet) {
        contentHtml = section(
          "Snippet",
          `<div class="ref-content-preview">${snippet}</div>`,
        );
      }
      break;
    }
    case "snippet": {
      // v5.1：只取 content（不再单独渲染 From section）
      const content = he(truncate(a.content || "", 240));
      if (content) {
        contentHtml = section(
          "Content",
          `<div class="ref-content-preview">${content}</div>`,
        );
      }
      break;
    }
    case "tool": {
      // kv 网格：tool_name / call_id / result_summary
      const rows: string[] = [];
      if (a.tool_name) {
        rows.push(`<div class="ref-pop-kv-key">Tool</div><div class="ref-pop-kv-val">${he(a.tool_name)}</div>`);
      }
      if (a.call_id) {
        rows.push(`<div class="ref-pop-kv-key">Call&nbsp;ID</div><div class="ref-pop-kv-val">${he(a.call_id)}</div>`);
      }
      if (a.result_summary) {
        rows.push(`<div class="ref-pop-kv-key">Result</div><div class="ref-pop-kv-val">${he(a.result_summary)}</div>`);
      }
      const grid = rows.length
        ? `<div class="ref-pop-kv">${rows.join("")}</div>`
        : "";
      if (grid) {
        contentHtml = `<div class="ref-pop-section">${grid}</div>`;
      }
      break;
    }
    default: {
      // other：JSON dump（兜底）
      const json = he(JSON.stringify(a));
      contentHtml =
        `<div class="ref-pop-section">` +
        `<pre class="ref-pop-json">${json}</pre>` +
        `</div>`;
      break;
    }
  }
  return typeBadge + contentHtml;
}

// chip / type badge 共享的 emoji 映射表（v5 引入）。
// v4 是 5 种 SVG icon（链/笔记本/气泡/扳手/问号），统一在小尺寸下视觉参差；
// v5 改 emoji 字符 + CSS 字体回退链（Apple Color Emoji / Segoe UI Emoji /
// Noto Color Emoji / EmojiOne Color / sans-serif），跨 type 视觉一致。
// （chip / type badge 都复用同一组 emoji，保证视觉锚点一致）
const CHIP_EMOJI: Record<string, string> = {
  link: "🔗",
  memory: "📒",
  snippet: "💬",
  tool: "🔧",
};

// chip 用的 type icon：emoji 字符包 <span class="ref-icon-emoji">。
function renderChipIcon(type: string): string {
  const e = CHIP_EMOJI[type] ?? "❓";
  return `<span class="ref-icon-emoji" aria-hidden="true">${e}</span>`;
}

// type badge：圆角胶囊（emoji + 小写 label），4 色对应 4 种 type。
// v5.1 恢复（commit 0901a62 删了）。v4 用 SVG icon + JS inline style 注入 bg/color；
// v5.1 改 emoji 字符 + 同样 JS 注入（保持 4 色 tint，hover 仍可见对比）。
const TYPE_BADGE: Record<string, { label: string; bg: string; color: string }> = {
  link:    { label: "link",    bg: "#e8f1ee", color: "#2d7a64" },
  memory:  { label: "memory",  bg: "#f0e8fc", color: "#7a4db8" },
  snippet: { label: "snippet", bg: "#e8f4e8", color: "#3d8b40" },
  tool:    { label: "tool",    bg: "#fef3e2", color: "#9a5a10" },
};
function renderTypeBadge(type: string): string {
  const meta = TYPE_BADGE[type] ?? { label: type.toLowerCase(), bg: "#f0f0f0", color: "#666" };
  const emoji = CHIP_EMOJI[type] ?? "❓";
  return (
    `<div class="ref-pop-section">` +
    `<span class="ref-type-badge" style="background:${meta.bg};color:${meta.color};">` +
    `<span class="ref-icon-emoji" aria-hidden="true">${emoji}</span>` +
    `${meta.label}` +
    `</span>` +
    `</div>`
  );
}

// chip 文本：完整字段 + fallback（v5 改）。
//   link    → a.title || extractDomain(a.url)         // fallback 到 domain
//   memory  → a.title || a.key                          // fallback 到完整 key
//   snippet → a.from
//   tool    → a.tool_name
//   other   → 第一个 attr value
//
// 统一 24 字符上限（v4 各 type 独立 10/12/14 太短，完整字段需要放宽）。
// 设计：复用 LLM 已经在 emit 的 title / key / from / tool_name 字段，
// 不改 ref token 协议，不改 system prompt。LLM 不填 title 时走 fallback。
function shortLabel(ref: Ref): string {
  const a = ref.attrs;
  const MAX = 24;
  let raw = "";
  switch (ref.type) {
    case "link":
      raw = a.title || extractDomain(a.url || "");
      break;
    case "memory":
      raw = a.title || a.key || "";
      break;
    case "snippet":
      raw = a.from || "";
      break;
    case "tool":
      raw = a.tool_name || "";
      break;
    default:
      raw = Object.values(a)[0] || "";
      break;
  }
  return truncate(raw, MAX);
}

// 只放行 http: / https: / mailto:，其它 scheme 返回 null 让上层走 unsafe 分支。
function safeUrl(url: string): string | null {
  return SAFE_URL_RE.test(url) ? url : null;
}

// 提取 url 的 domain 部分（无 protocol、无 path）。
// 用于 popover 头部展示「github.com」之类的友好标签。
// 失败时返回 ""（caller 用 fallback 渲染）。
function extractDomain(url: string): string {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

// favicon URL：Google 公共 favicon 服务。CORS 友好（无 Access-Control-Allow-Origin
// 但 <img> 不受 CORS 限制；返回 204 时 onerror 走 fallback）。
function getFaviconUrl(domain: string): string {
  if (!domain) return "";
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=32`;
}

// chip HTML 渲染：link type 包 <a>（browser 走 native click + Tauri 走
// plugin-shell，详见 spec/requirements/ref-chip-external-open.md），其它
// type 包 <span>（hover/click 弹 popover）。
//
// `seq` 是 replaceRefs 分配的渲染顺序号，用作 chip ↔ popover 配对 key
// （HTML data-ref-id）。v5.1 之前这里用 LLM emit 的 id=N；删除 id 后改成 seq。
//
// chip 形态：inline emoji + 完整字段（详见 spec/requirements/ref-chip-label-and-icon.md）
export function renderRefChip(ref: Ref, seq: number): string {
  const popover = renderPopover(ref);
  const icon = renderChipIcon(ref.type);
  const label = he(shortLabel(ref));
  const inner = `${icon}<span class="ref-num">${label}</span>`;
  const chipOpen =
    ref.type === "link" && ref.attrs.url && safeUrl(ref.attrs.url)
      ? `<a class="ref-chip" data-ref-id="${seq}" data-ref-type="${he(ref.type)}" tabindex="0" href="${he(ref.attrs.url)}" target="_blank" rel="noopener noreferrer">${inner}</a>`
      : `<span class="ref-chip" data-ref-id="${seq}" data-ref-type="${he(ref.type)}" tabindex="0">${inner}</span>`;
  return chipOpen + `<div class="ref-popover" data-ref-id="${seq}">${popover}</div>`;
}