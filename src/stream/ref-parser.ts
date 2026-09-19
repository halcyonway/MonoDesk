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
// 所有字段都 he() 转义；URL 额外走 safeUrl() 过滤危险 scheme。
function renderPopover(ref: Ref): string {
  const a = ref.attrs;
  switch (ref.type) {
    case "link": {
      const title = a.title ? `<div class="ref-pop-title">${he(a.title)}</div>` : "";
      const url = a.url ? safeUrl(a.url) : null;
      const urlHtml = url
        ? `<a class="ref-pop-url" href="${he(url)}" target="_blank" rel="noopener">${he(truncate(url, 60))}</a>`
        : a.url
        ? `<div class="ref-pop-url ref-pop-unsafe">${he(truncate(a.url, 60))} (unsafe scheme)</div>`
        : "";
      return title + urlHtml;
    }
    case "memory": {
      const key = a.key ? `<div class="ref-pop-key">${he(a.key)}</div>` : "";
      const snippet = a.snippet ? `<div class="ref-pop-snippet">${he(truncate(a.snippet, 120))}</div>` : "";
      return key + snippet;
    }
    case "snippet": {
      const from = a.from ? `<div class="ref-pop-from">${he(a.from)}</div>` : "";
      const content = a.content ? `<div class="ref-pop-content">${he(truncate(a.content, 200))}</div>` : "";
      return from + content;
    }
    case "tool": {
      const name = a.tool_name ? `<div class="ref-pop-tool">${he(a.tool_name)}</div>` : "";
      const args = a.args ? `<div class="ref-pop-args">${he(truncate(a.args, 80))}</div>` : "";
      const summary = a.result_summary ? `<div class="ref-pop-result">${he(truncate(a.result_summary, 120))}</div>` : "";
      return name + args + summary;
    }
    default: {
      // other / 未识别 type：JSON dump 所有 attrs（降级渲染）
      const json = JSON.stringify(a);
      return `<pre class="ref-pop-json">${he(json)}</pre>`;
    }
  }
}

// 只放行 http: / https: / mailto:，其它 scheme 返回 null 让上层走 unsafe 分支。
function safeUrl(url: string): string | null {
  return SAFE_URL_RE.test(url) ? url : null;
}

// chip 文本：渲染 [N] 的小标样式。id 必须存在（parse 已校验 ≥1）。
export function renderRefChip(ref: Ref): string {
  const popover = renderPopover(ref);
  return (
    `<span class="ref-chip" data-ref-id="${ref.id}" data-ref-type="${he(ref.type)}" tabindex="0">` +
    `<span class="ref-num">[${ref.id}]</span>` +
    `</span>` +
    `<div class="ref-popover" data-ref-id="${ref.id}">${popover}</div>`
  );
}