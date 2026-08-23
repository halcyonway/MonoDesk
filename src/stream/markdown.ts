// markdown-lite 渲染：够用即可（代码块 / 行内码 / 粗斜体 / 链接 / 标题 / 列表 / 引用）。
// 与 preview 版保持一致，输出 innerHTML 供流式引擎直接写 DOM。

export const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export const fmtMs = (ms: number) =>
  ms < 1000 ? Math.round(ms) + "ms" : (ms / 1000).toFixed(1) + "s";

export const truncate = (s: string, n: number) =>
  s.length > n ? s.slice(0, n) + "…" : s;

export const CARET = '<span class="caret"></span>';

function inline(s: string): string {
  const codes: string[] = [];
  s = s.replace(/`([^`]+)`/g, (_m, c: string) => {
    codes.push(c);
    return "@@c" + (codes.length - 1) + "@@";
  });
  s = esc(s);
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');
  s = s.replace(/@@c(\d+)@@/g, (_m, i: string) => "<code>" + esc(codes[+i]) + "</code>");
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
  const lines = src.split("\n");
  let out = "";
  let i = 0;
  let inCode = false;
  let buf: string[] = [];
  let lang = "";

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
      out += "<p></p>";
    } else if (t.startsWith("|")) {
      const tbl = tryTable(lines, i);
      if (tbl) {
        out += tbl.html;
        i += tbl.consumed;
        continue;
      }
      out += "<p>" + inline(line) + "</p>";
    } else if (/^#{1,3}\s/.test(t)) {
      const m = t.match(/^(#{1,3})\s+(.*)/)!;
      out += "<h" + m[1].length + ">" + inline(m[2]) + "</h" + m[1].length + ">";
    } else if (/^[-*]\s+/.test(t)) {
      out += "<ul><li>" + inline(t.replace(/^[-*]\s+/, "")) + "</li></ul>";
    } else if (t.startsWith("> ")) {
      out += "<blockquote>" + inline(t.slice(2)) + "</blockquote>";
    } else {
      out += "<p>" + inline(line) + "</p>";
    }
    i++;
  }
  if (inCode) out += codeBlock(buf.join("\n"), lang);
  return out;
}
