// [[ref ...]] parser 单测。协议见 spec/requirements/evidence-chain.md §2 + §3.3。
import { describe, expect, it } from "vitest";
import { parseRefBody, replaceRefs, renderRefChip } from "./ref-parser";

describe("parseRefBody", () => {
  it("1. link 完整 (quoted)", () => {
    const r = parseRefBody(`id=1 type=link url="https://x.com" title="T"`);
    expect(r).toEqual({
      id: 1,
      type: "link",
      attrs: { url: "https://x.com", title: "T" },
    });
  });

  it("2. memory (quoted)", () => {
    const r = parseRefBody(`id=2 type=memory key="identity/monox" snippet="text"`);
    expect(r).toEqual({
      id: 2,
      type: "memory",
      attrs: { key: "identity/monox", snippet: "text" },
    });
  });

  it("3. snippet 单引号", () => {
    const r = parseRefBody(`id=3 type=snippet from='user msg #5' content='hi there'`);
    expect(r).toEqual({
      id: 3,
      type: "snippet",
      attrs: { from: "user msg #5", content: "hi there" },
    });
  });

  it("4. bare value（无引号）", () => {
    const r = parseRefBody(`id=4 type=other note=hello`);
    expect(r).toEqual({
      id: 4,
      type: "other",
      attrs: { note: "hello" },
    });
  });

  it("5. id 缺失 → null", () => {
    expect(parseRefBody(`type=link url="x"`)).toBeNull();
  });

  it("6. type 缺失 → null", () => {
    expect(parseRefBody(`id=1 url="x"`)).toBeNull();
  });

  it("7. id 非数字 → null", () => {
    expect(parseRefBody(`id=abc type=link`)).toBeNull();
  });

  it("8. id=0 / 负数 → null", () => {
    expect(parseRefBody(`id=0 type=link`)).toBeNull();
    expect(parseRefBody(`id=-1 type=link`)).toBeNull();
  });

  it("9. 空 body → null", () => {
    expect(parseRefBody(``)).toBeNull();
  });

  it("10. value 含特殊字符（quoted 形式原样保留）", () => {
    const r = parseRefBody(`id=5 type=memory key="a<b" snippet="x>y"`);
    expect(r?.attrs).toEqual({ key: "a<b", snippet: "x>y" });
  });
});

describe("replaceRefs + renderRefChip 集成", () => {
  it("11. 单 ref token 替换成 chip + popover", () => {
    const out = replaceRefs(
      `text [[ref id=1 type=link url="https://x.com" title="T"]] more`,
      renderRefChip,
    );
    expect(out).toContain('class="ref-chip"');
    expect(out).toContain('data-ref-id="1"');
    expect(out).toContain('data-ref-type="link"');
    expect(out).toContain('class="ref-popover"');
    expect(out).toContain('class="ref-pop-title"');
    expect(out).toContain("https://x.com");
    expect(out).toContain(">T<"); // title 在 title 元素里
    expect(out).not.toContain("[[ref");
  });

  it("12. 多 ref token", () => {
    const src = `A [[ref id=1 type=link url="https://a.com" title="A"]] B [[ref id=2 type=memory key="k" snippet="s"]]`;
    const out = replaceRefs(src, renderRefChip);
    const chips = out.match(/class="ref-chip"/g);
    const popovers = out.match(/class="ref-popover"/g);
    expect(chips?.length).toBe(2);
    expect(popovers?.length).toBe(2);
    expect(out).toContain('data-ref-id="1"');
    expect(out).toContain('data-ref-id="2"');
  });

  it("13. parse 失败 → 原样保留 token (不抛错)", () => {
    const src = `text [[ref type=link url="x"]] more`;
    const out = replaceRefs(src, renderRefChip);
    expect(out).toContain("[[ref type=link url=\"x\"]]");
    expect(out).not.toContain("class=\"ref-chip\"");
  });

  it("14. 危险 scheme URL 不渲染 <a>，走 unsafe 分支", () => {
    const out = replaceRefs(
      `[[ref id=1 type=link url="javascript:alert(1)" title="X"]]`,
      renderRefChip,
    );
    expect(out).not.toContain("href=\"javascript:");
    expect(out).toContain("ref-pop-unsafe");
    expect(out).toContain("unsafe scheme");
  });

  it("15. http / https / mailto 都通过 safeUrl", () => {
    for (const url of ["https://x.com", "http://x.com", "mailto:a@b.com"]) {
      const out = replaceRefs(
        `[[ref id=1 type=link url="${url}" title="T"]]`,
        renderRefChip,
      );
      expect(out).toContain(`href="${url}"`);
    }
  });

  it("16. 未识别 type 走 other 分支（JSON dump）", () => {
    const out = replaceRefs(
      `[[ref id=1 type=foobar foo=bar baz=qux]]`,
      renderRefChip,
    );
    expect(out).toContain("class=\"ref-pop-json\"");
    expect(out).toContain("foo");
    expect(out).toContain("bar");
  });

  it("17. attrs 里的 < > \" & 全部 he() 转义", () => {
    const out = replaceRefs(
      `[[ref id=1 type=memory key="<script>" snippet="a&b"]]`,
      renderRefChip,
    );
    expect(out).toContain("&lt;script&gt;");
    expect(out).toContain("a&amp;b");
    // 关键：转义后的字符串不能再被解析成 HTML
    expect(out).not.toContain("<script>");
  });
});