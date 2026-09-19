// markdown.test.ts — regression cases for renderMarkdown inline syntax.
// 最容易踩坑的是 image regex 必须先于 auto-link，否则长 URL（OSS 签名带 query string）
// 会被 auto-link 截断，image 看到 <a href> 匹配不上，整张图渲染失败。
import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./markdown";

describe("renderMarkdown inline image", () => {
  it("renders single-line ![alt](url)", () => {
    const out = renderMarkdown("![cat](https://x.com/cat.png)");
    expect(out).toContain('<img src="https://x.com/cat.png" alt="cat"');
  });

  it("renders ![alt](<url>) angle-bracket form (CommonMark)", () => {
    // URL 含换行 + query string —— LLM 把 OSS 长 URL 自然换行时会写出这种
    const url = "https://dashscope-a717.oss-accelerate.aliyuncs.com/1d/7f/x.png?Expires=1789573371&OSSAccessKeyId=LTAI5tPxpiCM2hjmWrFXrym1";
    const out = renderMarkdown(`![油画](<${url}>)`);
    // esc() 在所有 regex 之前跑，& → &amp;。HTML 浏览器会解码回 &，
    // <img src> 用 &amp; 是合法的。
    expect(out).toContain(`<img src="${url.replace(/&/g, "&amp;")}"`);
    // 不能被 auto-link 二次处理
    expect(out).not.toContain("<a href=");
  });

  it("renders multi-line ![alt](url) when URL spans across newlines", () => {
    // 非 angle-bracket 形式也允许跨行：URL 段用 [\s\S]*? 匹配任意字符
    const out = renderMarkdown(
      "![油画](https://dashscope-a717.oss-accelerate.aliyuncs.com/1d/7f/x.png?Expires=1789573371\n&OSSAccessKeyId=LTAI5tPxpi)",
    );
    expect(out).toContain("<img");
    // URL 应该完整保留（query string + 新行）
    expect(out).toContain("Expires=1789573371");
  });

  it("image regex runs BEFORE auto-link so long URLs are captured intact", () => {
    // 这是回归：以前顺序是 auto-link 先跑，长 URL 在 `?Expires=...` 后被截断。
    const url = "https://dashscope-a717.oss-accelerate.aliyuncs.com/x.png?Expires=1789573371&Signature=abc";
    const out = renderMarkdown(`![](${url})`);
    // & 已经被 esc() 转成 &amp;
    expect(out).toContain(`<img src="${url.replace(/&/g, "&amp;")}"`);
    // 关键：不能被 auto-link 截成 `<a href="https://...png?Expires=...">`
    expect(out).not.toContain("<a href=");
  });

  it("naked auto-link works for URLs not in image syntax", () => {
    const out = renderMarkdown("看 https://x.com/foo.png 这是图");
    expect(out).toContain('<a href="https://x.com/foo.png"');
  });

  it("renders ![alt](url) with text after on the same line", () => {
    const out = renderMarkdown("![cat](https://x.com/cat.png) 旁边是图");
    expect(out).toContain('<img src="https://x.com/cat.png"');
    expect(out).toContain("旁边是图");
  });
});

describe("renderMarkdown ref token ([[ref ...]])", () => {
  // 协议见 spec/requirements/evidence-chain.md。
  // renderMarkdown 在 inline() 入口做 ref pre-pass（早于 esc()），把 token
  // 替换成 .ref-chip + .ref-popover HTML。

  it("renders single ref token inline", () => {
    const out = renderMarkdown(`text [[ref type=link url="https://x.com" title="T"]] more`);
    expect(out).toContain('class="ref-chip"');
    // v5.1: data-ref-id 由 replaceRefs 分配的 seq（单 ref = 1）
    expect(out).toContain('data-ref-id="1"');
    expect(out).toContain('data-ref-type="link"');
    expect(out).toContain('class="ref-popover"');
    // v5.1 popover: type 行 + content section（link 无 desc → 只有 type 行）
    expect(out).toContain('class="ref-type-badge"');
    expect(out).toContain('class="ref-pop-section"');
    // 不再含 URL section / favicon（v5.1 删了，URL 走 <a> native 跳转）
    expect(out).not.toContain('class="ref-url-display"');
    expect(out).not.toContain('class="ref-pop-favicon"');
    // 无 Open 按钮：跳转走点击 chip 本身
    expect(out).not.toContain('class="ref-pop-open"');
    expect(out).not.toContain("[[ref");
  });

  it("renders multiple refs in one line", () => {
    const src = `A [[ref type=link url="https://a" title="A"]] B [[ref type=memory key="k" snippet="s"]]`;
    const out = renderMarkdown(src);
    expect(out.match(/class="ref-chip"/g)?.length).toBe(2);
    expect(out.match(/class="ref-popover"/g)?.length).toBe(2);
    // seq 顺序：1, 2（不依赖 LLM emit 的 id 字段，v5.1 删了）
    expect(out).toContain('data-ref-id="1"');
    expect(out).toContain('data-ref-id="2"');
  });

  it("ref token survives inline markdown neighbors", () => {
    const out = renderMarkdown(
      `**bold** [[ref type=link url="https://x" title="T"]] **end**`,
    );
    expect(out).toContain("<strong>bold</strong>");
    expect(out).toContain('class="ref-chip"');
    expect(out).toContain("<strong>end</strong>");
  });

  it("ref popover content is escaped (attrs contain < > &)", () => {
    const out = renderMarkdown(
      `[[ref type=memory key="<script>" snippet="a&b"]]`,
    );
    expect(out).toContain("&lt;script&gt;");
    expect(out).toContain("a&amp;b");
    // 关键：未转义的 <script> 不能进入 popover DOM
    expect(out).not.toMatch(/<script>/);
  });

  it("ref token with parse failure (missing type) falls back to plain text", () => {
    // v5.1: parse 失败唯一条件是 type 缺失（id 缺失已不算失败）
    const out = renderMarkdown(`text [[ref url="x"]] more`);
    expect(out).toContain("[[ref url=\"x\"]]");
    expect(out).not.toContain('class="ref-chip"');
  });

  it("ref token inside code block is NOT parsed (code block content is opaque)", () => {
    const src = "```\n[[ref type=link url=\"https://x\"]]\n```";
    const out = renderMarkdown(src);
    // code 块原样保留 token 文本
    expect(out).toContain("[[ref type=link");
    expect(out).not.toContain('class="ref-chip"');
  });

  it("ref chip label uses full field (fallback to key when no title)", () => {
    const out = renderMarkdown(`[[ref type=memory key="k" snippet="s"]]`);
    // v5.1: memory 没填 title → fallback 到完整 key = "k"（替代 v4 的 [N] 数字；
    // 不再截短到末段，但单段 path 的 fallback 恰好就是末段）。完整字段 + emoji
    // 路径见 ref-parser.test.ts 27-33。
    expect(out).toContain("<span class=\"ref-num\">k</span>");
    // data-ref-id 由 seq 分配（单 ref = 1）
    expect(out).toContain('data-ref-id="1"');
  });

  it("renders all 4 ref types (link / memory / snippet / tool)", () => {
    // v5.1: 每种 type 都出 chip + popover；popover 都含 type badge + 各 type content section
    const src = [
      `link [[ref type=link url="https://x.com" title="L"]]`,
      `memory [[ref type=memory key="k" snippet="s"]]`,
      `snippet [[ref type=snippet from="f" content="c"]]`,
      `tool [[ref type=tool tool_name="n" call_id="c" result_summary="r"]]`,
    ].join(" ");
    const out = renderMarkdown(src);
    // 4 个 chip
    expect(out.match(/class="ref-chip"/g)?.length).toBe(4);
    // 4 个 popover
    expect(out.match(/class="ref-popover"/g)?.length).toBe(4);
    // v5.1: 4 个 type badge（每 popover 顶部）
    expect(out.match(/class="ref-type-badge"/g)?.length).toBe(4);
    // 每个 popover 至少 1 个 content section（type badge section + content section）
    expect(out.match(/class="ref-pop-section"/g)?.length).toBeGreaterThanOrEqual(4);
  });

  // Image 57 反馈：ref token 单独占一行时被包成 <p> 撑一个独立段，破坏 inline-first
  it("ref-only line is NOT wrapped in <p> (stays inline with previous block)", () => {
    // 模拟 LLM 输出：bullet + 段间空行 + ref token 单独一行
    const src = [
      `- bullet text`,
      ``,
      `[[ref type=link url="https://x.com" title="L"]]`,
    ].join("\n");
    const out = renderMarkdown(src);
    // ref chip 不能被 <p> 包裹
    // 期望：ref chip 直接出现，没有 <p>...ref-chip...</p> 这种形态
    expect(out).not.toMatch(/<p>[^<]*<a[^>]*ref-chip/i);
    // 但 chip 必须仍然渲染（不是被吞掉）
    expect(out).toContain('class="ref-chip"');
  });

  it("multiple consecutive blank lines collapse to a single paragraph break", () => {
    // 视觉断点只用 1 个 <p></p>，避免垂直间隔过宽把 ref chip 推得老远
    const src = [`text`, ``, ``, ``, `more text`].join("\n");
    const out = renderMarkdown(src);
    const blanks = out.match(/<p><\/p>/g);
    // 最多 1 个（连续空行折叠）
    expect(blanks?.length ?? 0).toBeLessThanOrEqual(1);
  });

  it("ref line with surrounding blank lines stays inline (no vertical push-away)", () => {
    // 真实场景：LLM 把 ref 夹在两段之间带上下空行 → 不该 ref 段单独占一截
    const src = [
      `前面一段。`,
      ``,
      `[[ref type=link url="https://github.com" title="G"]]`,
      ``,
      `后面一段。`,
    ].join("\n");
    const out = renderMarkdown(src);
    // ref chip 前后不该出现 <p></p> 把 ref 推走（最多 1 个合理垂直断点）
    const blanks = out.match(/<p><\/p>/g)?.length ?? 0;
    expect(blanks).toBeLessThanOrEqual(1);
    // ref chip 仍然存在
    expect(out).toContain('class="ref-chip"');
  });

  // Image 65 反馈：LLM 把 ref 紧跟前一段落 + 前面空行隔开时，chip 飘到段落
  // 右侧空白。修法：ref-only 行 + 前面有空行 → inline 进上一个段落。
  it("ref line after blank line inlines into previous paragraph (Image 65)", () => {
    const src = [
      `上传后需要等待 Apple 处理，处理完成后会出现在 TestFlight 页面。`,
      ``,
      `[[ref type=link url="https://developer.apple.com/testflight" title="Apple 上传说明"]]`,
    ].join("\n");
    const out = renderMarkdown(src);
    // 关键断言：ref chip 必须出现在「页面。」之后的同一个 <p> 内部，
    // 而不是 </p> 之后的悬空 inline 元素（那会被浏览器推到段落右侧空白）
    expect(out).toMatch(/页面。[\s\S]*?<a class="ref-chip"[\s\S]*?<\/p>/);
    // 不应有「</p><a class="ref-chip」这种悬空
    expect(out).not.toMatch(/<\/p><a class="ref-chip"/);
  });
});