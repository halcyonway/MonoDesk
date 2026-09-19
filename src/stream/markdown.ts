// markdown-lite 渲染：够用即可（代码块 / 行内码 / 粗斜体 / 链接 / 标题 / 列表 / 引用）。
// 与 preview 版保持一致，输出 innerHTML 供流式引擎直接写 DOM。

import { replaceRefs, renderRefChip } from "./ref-parser";

export const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export const fmtMs = (ms: number) =>
  ms < 1000 ? Math.round(ms) + "ms" : (ms / 1000).toFixed(1) + "s";

export const truncate = (s: string, n: number) =>
  s.length > n ? s.slice(0, n) + "…" : s;

export const CARET = '<span class="caret"></span>';

function inline(s: string): string {
  // ref token pre-pass：跟 inline code 块 `@@c0@@` placeholder 同套路 —— 先把
  // ref chip HTML 占位成 `@@rN@@`（N 是 index），esc() 后再换回成完整 HTML。
  // 这样 attrs 里 he() 转义过的字符不会被 esc() 二次转义。协议见
  // spec/requirements/evidence-chain.md（v5.1：id 字段已删，chip 顺序号由
  // replaceRefs 分配，renderRefChip 第二参数接收）。
  const refs: string[] = [];
  s = replaceRefs(s, (ref, seq) => {
    const html = renderRefChip(ref, seq);
    refs.push(html);
    return "@@r" + (refs.length - 1) + "@@";
  });

  const codes: string[] = [];
  s = s.replace(/`([^`]+)`/g, (_m, c: string) => {
    codes.push(c);
    return "@@c" + (codes.length - 1) + "@@";
  });
  s = esc(s);
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  // 顺序关键：image / link 必须**先于** auto-link，否则长 URL（OSS 签名带 ?Expires=&KeyId=
  // 之类）会被 auto-link 先截断，再让 image regex 看到 `<a href="...">...</a>` 而不是 URL，
  // 整张图渲染失败。Markdown 规范里图片/链接 syntax 本来就优先于 autolink。
  //
  // `<url>` 形式（CommonMark angle-bracket URL）：允许 URL 含空白 / 换行。LLM 把 OSS
  // 长 URL 自动换行时会自然跨行，普通 `([...)])` 形式会把 URL 截在换行处。
  // 注意 esc() 在前面已经把 `<` `>` 转成 `&lt;` `&gt;`，所以 regex 也得匹配转义后的形式。
  s = s.replace(/!\[([^\]]*)\]\(&lt;([\s\S]+?)&gt;\)/g, '<img src="$2" alt="$1" loading="lazy" />');
  s = s.replace(/\[([^\]]+)\]\(&lt;([\s\S]+?)&gt;\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  // 非 angle-bracket 形式：URL 段允许空白（多行），但不能含 `)`
  s = s.replace(/!\[([^\]]*)\]\(([\s\S]*?)\)/g, '<img src="$2" alt="$1" loading="lazy" />');
  s = s.replace(/\[([^\]]+)\]\(([\s\S]*?)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  // 顺序关键：auto-link 必须在 image/link **之后**，否则长 URL 被它截掉，image regex 看不到。
  // 停在空白或 `)`（避免吃掉 inline 引用收尾的右括号，例如 `(看 https://x.com)`）。
  // 负向 lookbehind `(?<![="])`：防止把 `<img src="https://...">` 属性值里的 URL 也包成 <a>，
  // 否则 image 替换完后 auto-link 又把 src= 里的 URL 二次匹配 → `<img src="<a href="...">..."</a>"`。
  s = s.replace(/(?<![="])(https?:\/\/[^\s)]+)(?=[.,;:!?'"]*(?:\s|$|<))/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
  s = s.replace(/@@c(\d+)@@/g, (_m, i: string) => "<code>" + esc(codes[+i]) + "</code>");
  // ref placeholder 替换：@@rN@@ → 真正的 chip HTML（HTML 已经过 he() 转义，
  // 不会受 esc() 影响）。
  s = s.replace(/@@r(\d+)@@/g, (_m, i: string) => refs[+i]);
  return s;
}

function codeBlock(code: string, lang: string): string {
  return (
    '<div class="codeblock">' +
    '<div class="codeblock-head"><span>' + esc(lang || "text") + "</span>" +
    '<span class="copy">copy</span></div>' +
    "<pre><code>" + esc(code) + "</code></pre></div>"
  );
}

// ---- GFM 表格 ----

function parseRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

function isSeparatorRow(line: string): boolean {
  const t = line.trim();
  return /^\|?[\s:|-]+\|?$/.test(t) && t.includes("-");
}

// 从 lines[start] 尝试解析表格；不合法返回 null。
function tryTable(
  lines: string[],
  start: number,
): { html: string; consumed: number } | null {
  if (start + 1 >= lines.length) return null;
  if (!isSeparatorRow(lines[start + 1])) return null;
  const header = parseRow(lines[start]);
  const aligns = parseRow(lines[start + 1]).map((c) => {
    if (c.startsWith(":") && c.endsWith(":")) return "center";
    if (c.endsWith(":")) return "right";
    if (c.startsWith(":")) return "left";
    return "";
  });

  const body: string[][] = [];
  let i = start + 2;
  while (i < lines.length && lines[i].trim().startsWith("|")) {
    body.push(parseRow(lines[i]));
    i++;
  }

  const cols = header.length;
  let html = '<div class="table-wrap"><table><thead><tr>';
  header.forEach((c, idx) => {
    const al = aligns[idx] ? ` style="text-align:${aligns[idx]}"` : "";
    html += `<th${al}>${inline(c)}</th>`;
  });
  html += "</tr></thead><tbody>";
  body.forEach((row) => {
    html += "<tr>";
    for (let c = 0; c < cols; c++) html += `<td>${inline(row[c] ?? "")}</td>`;
    html += "</tr>";
  });
  html += "</tbody></table></div>";
  return { html, consumed: i - start };
}

export function renderMarkdown(src: string): string {
  // Pre-pass：把跨行 image / link syntax 合并到一行。
  // LLM 把 OSS 长 URL（带 ?Expires=&Signature= 之类）在换行处自动断行时，会写出
  // ![alt](https://...png?Expires=xxx
  // &Signature=yyy)
  // 这种格式。如果直接 split('\n') 后逐行 inline，image regex 在第一行找不到 `)`，
  // 第二行的 `&Signature=...)` 也会落空，最后 auto-link 把 URL 截断包成 `<a>`。
  // 这里先合并掉换行（保留其他空白）。
  src = src.replace(/(!\[[^\]]*\]\(|\[[^\]]+\]\()\s*([\s\S]*?)\s*(\))/g, (_m, head, body, tail) => {
    // 只在 body 确实跨行时才合并；单行原样返回
    if (!/\n/.test(body)) return _m;
    return head + body.replace(/\s+/g, " ").trim() + tail;
  });

  const lines = src.split("\n");
  let out = "";
  let i = 0;
  let inCode = false;
  let buf: string[] = [];
  let lang = "";
  let prevBlank = false; // 上一行是空行：避免连续空行产生多个 <p></p> 视觉断行

  while (i < lines.length) {
    const line = lines[i];
    if (line.trim().startsWith("```")) {
      if (!inCode) {
        inCode = true;
        lang = line.trim().slice(3).trim();
        buf = [];
      } else {
        out += codeBlock(buf.join("\n"), lang);
        inCode = false;
      }
      i++;
      continue;
    }
    if (inCode) {
      buf.push(line);
      i++;
      continue;
    }
    const t = line.trim();
    if (t === "") {
      // 连续空行只产生一个垂直断点：避免「ref token 上下都空行」渲染出两个空段
      // 把 ref chip 段推得老远。**必须 continue**，否则 while 末尾的
      // prevBlank=false 会把刚设的 true 立刻复位 → 下次空行还会再产 <p></p>。
      if (!prevBlank) {
        out += "<p></p>";
        prevBlank = true;
      }
      i++;
      continue;
    } else if (t.startsWith("|")) {
      const tbl = tryTable(lines, i);
      if (tbl) {
        out += tbl.html;
        i += tbl.consumed;
        continue;
      }
      out += "<p>" + inline(line) + "</p>";
    } else if (/^([-*_])\1{2,}\s*$/.test(t)) {
      // horizontal rule：3+ 个相同字符（--- / *** / ___）整行。
      // 单独一行；行内不能有别的字符。CommonMark GFM。
      out += "<hr/>";
    } else if (/^#{1,3}\s/.test(t)) {
      const m = t.match(/^(#{1,3})\s+(.*)/)!;
      out += "<h" + m[1].length + ">" + inline(m[2]) + "</h" + m[1].length + ">";
    } else if (/^[-*]\s+/.test(t)) {
      out += "<ul><li>" + inline(t.replace(/^[-*]\s+/, "")) + "</li></ul>";
    } else if (t.startsWith("> ")) {
      out += "<blockquote>" + inline(t.slice(2)) + "</blockquote>";
    } else {
      // 默认段落。**特例：行内只含 ref token + 空白时剥掉 <p>**，让 ref 跟上一段
      // inline。否则 LLM 把 ref token 单独放一行时，整段 <p> 会撑独立段落行，
      // 破坏 ref chip 的 inline-first 设计。检测用 raw line（不是 inline 输出，
      // 因为 inline 内部已经把 ref token 替换成 chip HTML，placeholder 没了）。
      // **ref-only 行不 reset prevBlank**：跟空行同理，前后空行都该折叠成 1 个。
      const refsInLine = (line.match(/\[\[ref\s/g) || []).length;
      const lineWithoutRefs = line.replace(/\[\[ref\s[\s\S]+?\]\]/g, "").trim();
      const onlyRefsAndWhitespace = refsInLine > 0 && lineWithoutRefs === "";
      const rendered = inline(line);
      if (onlyRefsAndWhitespace) {
        // ref-only 行：把 chip inline 进上一个段落，避免悬空。
        // 浏览器对 `<p>...</p><a>...</a>` 会把 <a> 当独立行元素推到段落右侧
        // 空白（Image 65 视觉 bug）。正确做法是 chip 在 <p> 内部末尾。
        if (prevBlank && out.endsWith("<p></p>")) {
          // ref-only 行在空行之后：先去掉 <p></p>，再把 chip 追加到再上一段尾
          // （如果有 </p>）
          out = out.slice(0, -"<p></p>".length);
          if (out.endsWith("</p>")) {
            out = out.slice(0, -"</p>".length) + rendered + "</p>";
          } else {
            // 上面没有段落（ref 是文档开头）→ ref 单独一段
            out += rendered;
          }
          prevBlank = false;
        } else if (out.endsWith("</p>")) {
          // 直接紧跟段落：把 chip 追加进上一段尾部的 </p> 之前
          out = out.slice(0, -"</p>".length) + rendered + "</p>";
        } else {
          out += rendered;
        }
      } else {
        out += "<p>" + rendered + "</p>";
        prevBlank = false;
      }
      i++;
      continue;
    }
    prevBlank = false;
    i++;
  }
  if (inCode) out += codeBlock(buf.join("\n"), lang);
  return out;
}
