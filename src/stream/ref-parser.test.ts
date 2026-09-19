// [[ref ...]] parser 单测。协议见 spec/requirements/evidence-chain.md §2 + §3.3（v5.1）。
import { describe, expect, it } from "vitest";
import { parseRefBody, replaceRefs, renderRefChip } from "./ref-parser";

describe("parseRefBody", () => {
  // v5.1：id 字段已删除；type= 是唯一必填；id= 静默忽略（LLM 旧 token 兼容）

  it("1. link 完整 (quoted)", () => {
    const r = parseRefBody(`type=link url="https://x.com" title="T"`);
    expect(r).toEqual({
      type: "link",
      attrs: { url: "https://x.com", title: "T" },
    });
  });

  it("2. memory (quoted)", () => {
    const r = parseRefBody(`type=memory key="identity/monox" snippet="text"`);
    expect(r).toEqual({
      type: "memory",
      attrs: { key: "identity/monox", snippet: "text" },
    });
  });

  it("3. snippet 单引号", () => {
    const r = parseRefBody(`type=snippet from='user msg #5' content='hi there'`);
    expect(r).toEqual({
      type: "snippet",
      attrs: { from: "user msg #5", content: "hi there" },
    });
  });

  it("4. bare value（无引号）", () => {
    const r = parseRefBody(`type=other note=hello`);
    expect(r).toEqual({
      type: "other",
      attrs: { note: "hello" },
    });
  });

  it("5. type 缺失 → null", () => {
    expect(parseRefBody(`url="x"`)).toBeNull();
  });

  it("6. 旧 token 带 id=N 仍正常 parse（id 静默忽略）", () => {
    // v5.1 向后兼容：旧 LLM 可能还在 emit id=N；parser 不报错、不进 Ref.attrs。
    const r = parseRefBody(`id=42 type=link url="https://x.com"`);
    expect(r).toEqual({
      type: "link",
      attrs: { url: "https://x.com" },
    });
    // 关键：id 不进 Ref 也不进 attrs
    expect(r).not.toHaveProperty("id");
    expect(r?.attrs).not.toHaveProperty("id");
  });

  it("7. id 非数字 → 静默忽略（不报错）", () => {
    const r = parseRefBody(`id=abc type=link url="x"`);
    expect(r).toEqual({
      type: "link",
      attrs: { url: "x" },
    });
  });

  it("8. id=0 / 负数 → 静默忽略（不报错）", () => {
    for (const id of ["0", "-1"]) {
      const r = parseRefBody(`id=${id} type=link url="x"`);
      expect(r).toEqual({
        type: "link",
        attrs: { url: "x" },
      });
    }
  });

  it("9. 空 body → null", () => {
    expect(parseRefBody(``)).toBeNull();
  });

  it("10. value 含特殊字符（quoted 形式原样保留）", () => {
    const r = parseRefBody(`type=memory key="a<b" snippet="x>y"`);
    expect(r?.attrs).toEqual({ key: "a<b", snippet: "x>y" });
  });
});

describe("replaceRefs + renderRefChip 集成", () => {
  // v5.1: data-ref-id 由 replaceRefs 分配 seq（不依赖 LLM emit 的 id 字段）。
  // renderRefChip 现在是 (ref, seq) => string。

  it("11. 单 ref token 替换成 chip + popover", () => {
    const out = replaceRefs(
      `text [[ref type=link url="https://x.com" title="T"]] more`,
      renderRefChip,
    );
    expect(out).toContain('class="ref-chip"');
    expect(out).toContain('data-ref-id="1"');
    expect(out).toContain('data-ref-type="link"');
    expect(out).toContain('class="ref-popover"');
    // v5.1 popover：含 type badge section（link 无 desc → 只有 type 行）
    expect(out).toContain('class="ref-type-badge"');
    expect(out).toContain('class="ref-pop-section"');
    // v5.1 不再含 URL display
    expect(out).not.toContain('class="ref-url-display"');
    // v5.1 popover 内部不含 url（url 走 <a> href 在 chip 里）
    const popover = out.match(/<div class="ref-popover"[^>]*>([\s\S]*?)<\/div>/);
    expect(popover).toBeTruthy();
    expect(popover![1]).not.toContain("https://x.com");
    expect(out).not.toContain("[[ref");
  });

  it("12. 多 ref token：data-ref-id 走 seq 顺序（1, 2）", () => {
    const src = `A [[ref type=link url="https://a.com" title="A"]] B [[ref type=memory key="k" snippet="s"]]`;
    const out = replaceRefs(src, renderRefChip);
    const chips = out.match(/class="ref-chip"/g);
    const popovers = out.match(/class="ref-popover"/g);
    expect(chips?.length).toBe(2);
    expect(popovers?.length).toBe(2);
    expect(out).toContain('data-ref-id="1"');
    expect(out).toContain('data-ref-id="2"');
  });

  it("13. parse 失败 → 原样保留 token (不抛错)", () => {
    const src = `text [[ref url="x"]] more`;
    const out = replaceRefs(src, renderRefChip);
    expect(out).toContain("[[ref url=\"x\"]]");
    expect(out).not.toContain("class=\"ref-chip\"");
  });

  it("14. 危险 scheme URL 不渲染 <a>，走 unsafe 分支（chip 退回 <span>）", () => {
    const out = replaceRefs(
      `[[ref type=link url="javascript:alert(1)" title="X"]]`,
      renderRefChip,
    );
    expect(out).not.toContain("href=\"javascript:");
    expect(out).toMatch(/<span class="ref-chip"/);
  });

  it("15. http / https / mailto 都通过 safeUrl", () => {
    for (const url of ["https://x.com", "http://x.com", "mailto:a@b.com"]) {
      const out = replaceRefs(
        `[[ref type=link url="${url}" title="T"]]`,
        renderRefChip,
      );
      expect(out).toContain(`href="${url}"`);
    }
  });

  it("16. 未识别 type 走 other 分支（JSON dump）", () => {
    const out = replaceRefs(
      `[[ref type=foobar foo=bar baz=qux]]`,
      renderRefChip,
    );
    expect(out).toContain("class=\"ref-pop-json\"");
    expect(out).toContain("foo");
    expect(out).toContain("bar");
  });

  it("17. attrs 里的 < > \" & 全部 he() 转义", () => {
    const out = replaceRefs(
      `[[ref type=memory key="<script>" snippet="a&b"]]`,
      renderRefChip,
    );
    expect(out).toContain("&lt;script&gt;");
    expect(out).toContain("a&amp;b");
    // 关键：转义后的字符串不能再被解析成 HTML
    expect(out).not.toContain("<script>");
  });

  it("18. link type chip 渲染成 <a> 包裹（点击直接跳转）", () => {
    const out = replaceRefs(
      `[[ref type=link url="https://github.com/foo/bar" title="X"]]`,
      renderRefChip,
    );
    // chip 用 <a> 标签 + href + target="_blank"
    expect(out).toMatch(/<a class="ref-chip"[^>]+href="https:\/\/github\.com\/foo\/bar"/);
    expect(out).toContain('target="_blank"');
    // v5.1：rel 改成 noopener noreferrer（spec/requirements/ref-chip-external-open.md）
    expect(out).toContain('rel="noopener noreferrer"');
  });

  it("19. link popover v5.1：type 行 + content section（desc），不含 URL", () => {
    const out = replaceRefs(
      `[[ref type=link url="https://github.com/foo/bar" title="X" desc="github 仓库介绍"]]`,
      renderRefChip,
    );
    // type 行
    expect(out).toContain('class="ref-type-badge"');
    expect(out).toContain('class="ref-icon-emoji"');
    expect(out).toContain('>link<');
    // content section
    expect(out).toContain('class="ref-pop-section"');
    expect(out).toContain('>Content<');
    expect(out).toContain("github 仓库介绍");
    // 不含 URL section / favicon（v5.1 删了）
    expect(out).not.toContain('class="ref-url-display"');
    expect(out).not.toContain('class="ref-pop-favicon"');
    expect(out).not.toContain("https://www.google.com/s2/favicons");
  });

  it("20. 非 link type chip 是 <span>（不走 click 跳转）", () => {
    const out = replaceRefs(
      `[[ref type=memory key="k" snippet="s"]]`,
      renderRefChip,
    );
    expect(out).not.toMatch(/<a class="ref-chip"/);
    expect(out).toMatch(/<span class="ref-chip"/);
  });

  it("21. memory popover v5.1：type 行 + snippet section（content-preview）", () => {
    const out = replaceRefs(
      `[[ref type=memory key="identity/monox" snippet="text"]]`,
      renderRefChip,
    );
    // type 行（memory emoji 📒 + label "memory" + 紫底）
    expect(out).toContain('class="ref-type-badge"');
    expect(out).toContain("📒");
    expect(out).toContain("memory");
    expect(out).toContain("#f0e8fc");
    // snippet section（content-preview 样式）
    expect(out).toContain('class="ref-pop-section"');
    expect(out).toContain('class="ref-content-preview"');
    expect(out).toContain("text");
  });

  it("22. chip 总是带 type-specific emoji icon (span.ref-icon-emoji)", () => {
    const emojiMap: Record<string, string> = {
      link: "🔗",
      memory: "📒",
      snippet: "💬",
      tool: "🔧",
      other: "❓",
    };
    for (const t of ["link", "memory", "snippet", "tool", "other"]) {
      const out = replaceRefs(
        `[[ref type=${t}${t === "link" ? ` url="https://x"` : ""}]]`,
        renderRefChip,
      );
      expect(out).toContain('class="ref-icon-emoji"');
      expect(out).toContain(emojiMap[t]);
      // 不再含 SVG icon（v4 形态）
      expect(out).not.toMatch(/<svg class="ref-icon"/);
    }
  });

  it("23. tool popover v5.1：type 行 + kv 网格", () => {
    const out = replaceRefs(
      `[[ref type=tool tool_name="mono_search" call_id="c1" result_summary="5 篇"]]`,
      renderRefChip,
    );
    expect(out).toContain('class="ref-type-badge"');
    expect(out).toContain("🔧");
    expect(out).toContain("tool");
    expect(out).toContain('class="ref-pop-section"');
    expect(out).toContain('class="ref-pop-kv"');
    expect(out).toContain("mono_search");
    expect(out).toContain("5 篇");
  });

  it("24. dangerous scheme 链接不走 <a>，chip 仍为 <span>", () => {
    const out = replaceRefs(
      `[[ref type=link url="javascript:alert(1)" title="X"]]`,
      renderRefChip,
    );
    expect(out).not.toMatch(/<a class="ref-chip"[^>]+href="javascript:/);
    expect(out).toMatch(/<span class="ref-chip"/);
  });

  it("25. link popover v5.1：desc 是 URL 时不渲染 desc 区（避免字符级断行）", () => {
    // 跟 Image 60 同样的判别：desc 内容是 URL（含 http/https/mailto）时跳过 desc section。
    const url = "https://news.qq.com/rain/a/20260729A05LG600";
    const out = replaceRefs(
      `[[ref type=link url="${url}" title="港股收评" desc="${url}"]]`,
      renderRefChip,
    );
    // type 行 + content section（label="Content"）渲染，但 content section 内部不渲染 url 字符串
    expect(out).toContain('class="ref-type-badge"');
    // 由于 desc 是 url 不渲染,content section 不含 url 字符串
    // (但 chip 里的 title "港股收评" 是有的)
    expect(out).toContain("港股收评");
    // url 不应在 popover 的 content section 里（通过 popover textContent 间接验证）
    const popover = out.match(/<div class="ref-popover"[^>]*>([\s\S]*?)<\/div>/);
    expect(popover).toBeTruthy();
    expect(popover![1]).not.toContain(url);
  });

  it("26. link 无 desc 字段时 popover 只剩 type 行（无 content section）", () => {
    const out = replaceRefs(
      `[[ref type=link url="https://x.com" title="T"]]`,
      renderRefChip,
    );
    // type 行存在
    expect(out).toContain('class="ref-type-badge"');
    // 不含 Content section（desc 缺失 → content section 整个省略）
    expect(out).not.toContain('>Content<');
  });

  // ---- v5: chip 完整字段 + emoji icon ----

  it("27. chip 文本 link 用 a.title（v5 完整字段，不再截短 domain）", () => {
    const out = replaceRefs(
      `[[ref type=link url="https://www.nvidia.com/en-us/" title="NVIDIA 官网"]]`,
      renderRefChip,
    );
    expect(out).toMatch(/<span class="ref-num">NVIDIA 官网<\/span>/);
    expect(out).not.toMatch(/<span class="ref-num">nvidia\.com<\/span>/);
  });

  it("28. chip 文本 link 无 title 时 fallback 到 url domain", () => {
    const out = replaceRefs(
      `[[ref type=link url="https://www.nvidia.com/en-us/"]]`,
      renderRefChip,
    );
    expect(out).toMatch(/<span class="ref-num">nvidia\.com<\/span>/);
  });

  it("29. chip 文本 memory 用 a.title（v5 完整字段）", () => {
    const out = replaceRefs(
      `[[ref type=memory key="identity/monox" title="Monox 介绍"]]`,
      renderRefChip,
    );
    expect(out).toMatch(/<span class="ref-num">Monox 介绍<\/span>/);
    expect(out).not.toMatch(/<span class="ref-num">monox<\/span>/);
  });

  it("30. chip 文本 memory 无 title 时 fallback 到完整 key", () => {
    const out = replaceRefs(
      `[[ref type=memory key="identity/monox"]]`,
      renderRefChip,
    );
    expect(out).toMatch(/<span class="ref-num">identity\/monox<\/span>/);
  });

  it("31. chip 文本 snippet 用完整 a.from", () => {
    const out = replaceRefs(
      `[[ref type=snippet from="user msg #5" content="hi there"]]`,
      renderRefChip,
    );
    expect(out).toMatch(/<span class="ref-num">user msg #5<\/span>/);
  });

  it("32. chip 文本 tool 用完整 a.tool_name", () => {
    const out = replaceRefs(
      `[[ref type=tool tool_name="mono_search"]]`,
      renderRefChip,
    );
    expect(out).toMatch(/<span class="ref-num">mono_search<\/span>/);
  });

  it("33. chip 长度上限 24（v4 各 type 独立 10/12/14 → v5 统一 24）", () => {
    const longTitle = "x".repeat(40);
    const out = replaceRefs(
      `[[ref type=link url="https://x.com" title="${longTitle}"]]`,
      renderRefChip,
    );
    expect(out).toMatch(/<span class="ref-num">x{24}…<\/span>/);
  });

  it("34. emoji icon: 4 种已知 type 各输出对应 emoji（other 走 ❓ fallback）", () => {
    const cases: Array<[string, string]> = [
      ["link", "🔗"],
      ["memory", "📒"],
      ["snippet", "💬"],
      ["tool", "🔧"],
      ["other", "❓"],
    ];
    for (const [t, e] of cases) {
      const out = replaceRefs(
        `[[ref type=${t}${t === "link" ? ` url="https://x"` : ""}]]`,
        renderRefChip,
      );
      expect(out).toContain(`<span class="ref-icon-emoji" aria-hidden="true">${e}</span>`);
    }
  });

  // ---- v5.1: 协议删 id + seq 分配 ----

  it("35. 旧 token 带 id=N：ref-parser 忽略 id，data-ref-id 仍按 seq 分配", () => {
    // 旧 LLM emit `id=N`，parser 静默忽略；replaceRefs 仍按出现顺序分配 seq。
    const out = replaceRefs(
      `A [[ref id=42 type=link url="https://x.com" title="T"]] B [[ref id=99 type=memory key="k" snippet="s"]]`,
      renderRefChip,
    );
    // seq 跟 id 无关：第一个 chip seq=1,第二个 seq=2
    expect(out).toContain('data-ref-id="1"');
    expect(out).toContain('data-ref-id="2"');
    expect(out).not.toContain('data-ref-id="42"');
    expect(out).not.toContain('data-ref-id="99"');
  });

  it("36. renderRefChip 第二个参数 seq 直接控制 data-ref-id", () => {
    // 直接调用 renderRefChip 时,seq 跟 replaceRefs 行为一致
    const r1 = renderRefChip({ type: "memory", attrs: { key: "k", snippet: "s" } }, 5);
    const r2 = renderRefChip({ type: "memory", attrs: { key: "k", snippet: "s" } }, 7);
    expect(r1).toContain('data-ref-id="5"');
    expect(r2).toContain('data-ref-id="7"');
  });
});