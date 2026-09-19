// [[ref id=N type=... ...]] token 解析 + 渲染。
//
// 协议见 spec/requirements/evidence-chain.md：
// - 形态：`[[ref id=N type=TYPE key=value ...]]`
// - id 必须正整数；type 任意 string（未识别走 other）
// - parse 失败 → null，调用方原样保留 token 当纯文本
//
// 渲染层独立：parser 只产出结构化 Ref，renderMarkdown 负责把它转成 innerHTML
// 字符串（chip + popover）。

export interface Ref {
  id: number;
  type: string;
  attrs: Record<string, string>;
}

// 提取 [[ref ...]] token 的 body（id=1 type=link url="x" title="t"）。
// non-greedy，停在第一个 ]]。整段 raw 保留作为 fallback（parse 失败时）。
const REF_RE = /\[\[ref\s+([\s\S]+?)\]\]/g;

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
  if (!("id" in map) || !("type" in map)) return null;
  const id = Number(map.id);
  if (!Number.isInteger(id) || id < 1) return null;
  const type = map.type;
  delete map.id;
  delete map.type;
  return { id, type, attrs: map };
}

// 扫描 src，把所有 [[ref ...]] token 替换成 render(ref) 返回的字符串。
// 解析失败 → 保留 raw token 当 fallback（不抛错，跟 markdown 容错一致）。
export function replaceRefs(
  src: string,
  render: (ref: Ref, raw: string) => string,
): string {
  REF_RE.lastIndex = 0;
  return src.replace(REF_RE, (_m, body: string) => {
    const ref = parseRefBody(body);
    if (!ref) return _m;
    return render(ref, _m);
  });
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

// popover 内容按 type 渲染。
// spec: spec/ui/ref-chip-popover-v5.html (v5: emoji chip + 简化 popover)
//   - 去掉 type badge section（emoji 已在 chip 里）
//   - 去掉 chip 已展示的 Title section（title 跟 chip 重复）
//   - 只保留 chip 没展示的字段：URL / snippet / kv grid
// 所有字段都 he() 转义；URL 额外走 safeUrl() 过滤危险 scheme。
function renderPopover(ref: Ref): string {
  const a = ref.attrs;

  // section 行：包含 label + value，底部分隔线
  const section = (label: string, value: string) =>
    `<div class="ref-pop-section">` +
    `<div class="ref-pop-label">${he(label)}</div>` +
    `<div class="ref-pop-value">${value}</div>` +
    `</div>`;

  switch (ref.type) {
    case "link": {
      const url = a.url ? (safeUrl(a.url) ?? "") : "";
      const domain = a.url ? extractDomain(a.url) : "";
      const favicon = domain ? getFaviconUrl(domain) : "";

      // URL section: favicon + mono 字体 URL。title / desc 都已在 chip 里展示，
      // v5 不再在 popover 重复 Title section（避免字符级断行，参考 Image 60）。
      const faviconHtml = favicon
        ? `<img class="ref-pop-favicon" src="${he(favicon)}" alt="" loading="lazy" data-favicon-stage="google" data-favicon-domain="${he(domain)}" />`
        : `<span class="ref-pop-favicon-fallback" aria-hidden="true">·</span>`;
      return section(
        "URL",
        `<div class="ref-url-display">` +
          `<div class="ref-pop-favicon-wrap">${faviconHtml}</div>` +
          `<span class="ref-url-text">${he(url)}</span>` +
        `</div>`,
      );
    }
    case "memory": {
      const key = he(a.key || "");
      const snippet = he(truncate(a.snippet || "", 160));
      let html = "";
      if (key) html += section("Key", `<span class="ref-pop-mono">${key}</span>`);
      if (snippet) {
        html += section(
          "Snippet",
          `<div class="ref-content-preview">${snippet}</div>`,
        );
      }
      return html;
    }
    case "snippet": {
      const from = he(a.from || "");
      const content = he(truncate(a.content || "", 200));
      let html = "";
      if (from) html += section("From", from);
      if (content) {
        html += section(
          "Content",
          `<div class="ref-content-preview">${content}</div>`,
        );
      }
      return html;
    }
    case "tool": {
      // key-value grid
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
      return `<div class="ref-pop-section">${grid}</div>`;
    }
    default: {
      const json = he(JSON.stringify(a));
      return (
        `<div class="ref-pop-section">` +
        `<pre class="ref-pop-json">${json}</pre>` +
        `</div>`
      );
    }
  }
}

// chip 用的 type icon（inline emoji 字符，v5 引入）。
// v4 是 5 种 SVG icon（链/笔记本/气泡/扳手/问号），统一在小尺寸下视觉参差；
// v5 改 emoji 字符 + CSS 字体回退链（Apple Color Emoji / Segoe UI Emoji /
// Noto Color Emoji / EmojiOne Color / sans-serif），跨 type 视觉一致。
// （短文本 chip：font-size 11px sans，emoji 11px 视觉对齐 baseline）
const CHIP_EMOJI: Record<string, string> = {
  link: "🔗",
  memory: "📒",
  snippet: "💬",
  tool: "🔧",
};
function renderChipIcon(type: string): string {
  const e = CHIP_EMOJI[type] ?? "❓";
  return `<span class="ref-icon-emoji" aria-hidden="true">${e}</span>`;
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

// chip 文本：渲染 inline 短标签（替代 [N] 数字）。
// link type 整个 chip 包成 <a>：点击直接跳转，hover 才弹 preview card。
// 其它 type chip 保持纯 span（hover/click 走 popover）。
//
// 用 <sup>（脚注）形态天然 inline-first，baseline 自动抬升跟文字对齐。
export function renderRefChip(ref: Ref): string {
  const popover = renderPopover(ref);
  const icon = renderChipIcon(ref.type);
  const label = he(shortLabel(ref));
  const inner = `${icon}<span class="ref-num">${label}</span>`;
  const chipOpen =
    ref.type === "link" && ref.attrs.url && safeUrl(ref.attrs.url)
      ? `<a class="ref-chip" data-ref-id="${ref.id}" data-ref-type="${he(ref.type)}" tabindex="0" href="${he(ref.attrs.url)}" target="_blank" rel="noopener">${inner}</a>`
      : `<span class="ref-chip" data-ref-id="${ref.id}" data-ref-type="${he(ref.type)}" tabindex="0">${inner}</span>`;
  return chipOpen + `<div class="ref-popover" data-ref-id="${ref.id}">${popover}</div>`;
}