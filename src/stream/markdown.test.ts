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