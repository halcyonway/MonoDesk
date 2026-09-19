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
    // v5: link popover 只剩 URL section（去掉 type badge + Title section）
    expect(out).not.toContain('class="ref-type-badge"');
    expect(out).toContain('class="ref-pop-section"');
    expect(out).toContain('class="ref-url-display"');
    expect(out).toContain("https://x.com");
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

  it("14. 危险 scheme URL 不渲染 <a>，走 unsafe 分支（chip 退回 <span>，popover 无 Open 按钮）", () => {
    const out = replaceRefs(
      `[[ref id=1 type=link url="javascript:alert(1)" title="X"]]`,
      renderRefChip,
    );
    expect(out).not.toContain("href=\"javascript:");
    // chip 退回 span（无法跳转目标）
    expect(out).toMatch(/<span class="ref-chip"/);
    // popover 无 Open 按钮（Image 61 设计决策）
    expect(out).not.toContain('class="ref-pop-open"');
    expect(out).not.toContain("Open ↗");
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

  // ---- preview card + chip-as-a (link type) ----
  // Image 54 需求：link type 走 ChatGPT 风格 preview card + chip 整体包成
  // <a>（点击直接跳转新窗口）。

  it("18. link type chip 渲染成 <a> 包裹（点击直接跳转，href=safeUrl）", () => {
    const out = replaceRefs(
      `[[ref id=1 type=link url="https://github.com/foo/bar" title="X"]]`,
      renderRefChip,
    );
    // chip 用 <a> 标签
    expect(out).toMatch(/<a class="ref-chip"[^>]+href="https:\/\/github\.com\/foo\/bar"/);
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noopener"');
  });

  it("19. link type popover v5 (只剩 URL section，type badge / Title 都不再渲染)", () => {
    const out = replaceRefs(
      `[[ref id=1 type=link url="https://github.com/foo/bar" title="X"]]`,
      renderRefChip,
    );
    // v5: 无 type badge section（emoji 已在 chip 里）+ 无 Title section（title 跟 chip 重复）
    expect(out).not.toContain('class="ref-type-badge"');
    // popover 仍含 URL section + favicon
    expect(out).toContain('class="ref-pop-section"');
    expect(out).toContain('class="ref-url-display"');
    expect(out).toContain('class="ref-url-text"');
    expect(out).toContain(
      `https://www.google.com/s2/favicons?domain=github.com&amp;sz=32`,
    );
    expect(out).toContain("github.com");
    // title 仍然在 chip 里显示（shortLabel 走 title）
    expect(out).toContain("X");
    // 没有 desc 字段 → 不渲染 ref-pop-desc
    expect(out).not.toContain('class="ref-pop-desc"');
  });

  it("20. 非 link type chip 是 <span>（不走 click 跳转，hover/click 弹 popover）", () => {
    const out = replaceRefs(
      `[[ref id=1 type=memory key="k" snippet="s"]]`,
      renderRefChip,
    );
    // 不能包成 <a>；chip 是 span
    expect(out).not.toMatch(/<a class="ref-chip"/);
    expect(out).toMatch(/<span class="ref-chip"/);
  });

  it("21. non-link type popover v5 (无 type badge，保留 Key + Snippet section)", () => {
    const out = replaceRefs(
      `[[ref id=2 type=memory key="identity/monox" snippet="text"]]`,
      renderRefChip,
    );
    // v5: 无 type badge section（emoji 已在 chip 里），但 content preview 保留
    expect(out).not.toContain('class="ref-type-badge"');
    expect(out).toContain('class="ref-pop-section"');
    expect(out).toContain('class="ref-content-preview"');
    expect(out).toContain("identity/monox");
    expect(out).toContain("text");
  });

  it("22. chip 总是带 type-specific emoji icon (span.ref-icon-emoji)", () => {
    // v5: 5 种 type 各对应一个 emoji 字符（🔗 📒 💬 🔧 ❓），不再用 SVG
    const emojiMap: Record<string, string> = {
      link: "🔗",
      memory: "📒",
      snippet: "💬",
      tool: "🔧",
      other: "❓",
    };
    for (const t of ["link", "memory", "snippet", "tool", "other"]) {
      const out = replaceRefs(
        `[[ref id=1 type=${t}${t === "link" ? ` url="https://x"` : ""}]]`,
        renderRefChip,
      );
      expect(out).toContain('class="ref-icon-emoji"');
      expect(out).toContain(emojiMap[t]);
      // 不再含 SVG icon（v4 形态）
      expect(out).not.toMatch(/<svg class="ref-icon"/);
    }
  });

  it("23. tool type v5 (无 type badge，保留 key-value grid section)", () => {
    const out = replaceRefs(
      `[[ref id=1 type=tool tool_name="mono_search" call_id="c1" result_summary="5 篇"]]`,
      renderRefChip,
    );
    // v5: 无 type badge，保留 section + kv grid
    expect(out).not.toContain('class="ref-type-badge"');
    expect(out).toContain('class="ref-pop-section"');
    expect(out).toContain('class="ref-pop-kv"');
    expect(out).toContain("mono_search");
    expect(out).toContain("5 篇");
  });

  it("24. dangerous scheme 链接不走 <a>，chip 仍为 <span>（无跳转目标）", () => {
    const out = replaceRefs(
      `[[ref id=1 type=link url="javascript:alert(1)" title="X"]]`,
      renderRefChip,
    );
    // chip 不能包 <a href="javascript:...">
    expect(out).not.toMatch(/<a class="ref-chip"[^>]+href="javascript:/);
    // chip 退回 span
    expect(out).toMatch(/<span class="ref-chip"/);
    // popover 不渲染 Open 按钮（Image 61 设计决策）
    expect(out).not.toContain('class="ref-pop-open"');
    expect(out).not.toContain("Open ↗");
  });

  it("25. link type v5: popover 不再渲染 desc（v4 有 Description section，v5 删了）", () => {
    // v5: link popover 只剩 URL section；desc 字段即便 LLM 填了也不再渲染
    //（避免字符级断行，参考 Image 60；desc 内容通常跟 title / url 重复）。
    const out = replaceRefs(
      `[[ref id=1 type=link url="https://x.com" title="T" desc="a custom description"]]`,
      renderRefChip,
    );
    expect(out).not.toContain("a custom description");
    // title 仍然在 chip 里展示（shortLabel = a.title）
    expect(out).toContain("T");
  });

  it("26. link type 没有 desc 字段时不显示 ref-pop-desc（避免重复 URL + 字符级断行）", () => {
    // Image 60 反馈：LLM 不填 desc 时，popover 不该把完整 URL 塞进 ref-pop-desc
    // → 字符级断行难看（htt / ps / .....）。URL 已经在 domain + Open 按钮里展示，
    // desc 区域省略。
    const out = replaceRefs(
      `[[ref id=1 type=link url="https://news.qq.com/rain/a/20260729A05LG600" title="港股收评"]]`,
      renderRefChip,
    );
    expect(out).not.toContain('class="ref-pop-desc"');
    // URL 仍然在 Open 按钮的 href 里
    expect(out).toContain('href="https://news.qq.com/rain/a/20260729A05LG600"');
    // domain 也仍然显示
    expect(out).toContain("news.qq.com");
  });

  it("27. link type 即使 LLM 把 url 塞进 desc 字段也不显示（避免 字符级断行）", () => {
    // Image 60 真实场景：LLM 学过 ChatGPT/Notion AI 的 web preview card 格式，
    // 把 title 和 url 都填进 [[ref ...]] 字段。desc 是 URL 时不渲染 desc 区，
    // 否则在 320px popover 里字符级断行（"htt / ps / ....."）。
    const url = "https://news.qq.com/rain/a/20260729A05LG600";
    const out = replaceRefs(
      `[[ref id=1 type=link url="${url}" title="港股收评" desc="${url}"]]`,
      renderRefChip,
    );
    expect(out).not.toContain('class="ref-pop-desc"');
    // title 仍然显示
    expect(out).toContain("港股收评");
  });

  it("28. link type desc 是 mailto URL 同样不渲染 desc 区", () => {
    // 同 27 规则：mailto: 开头的 desc 也视为 URL，不进 desc 区
    const out = replaceRefs(
      `[[ref id=1 type=link url="mailto:x@y.com" title="mail" desc="mailto:x@y.com"]]`,
      renderRefChip,
    );
    expect(out).not.toContain('class="ref-pop-desc"');
  });

  it("29. link type favicon <img> 带 data-favicon-stage + domain（驱动 Google → site fallback 链）", () => {
    // Image 61：Google s2 服务对小众站不稳 → 失败时换 site /favicon.ico。
    // ref-parser 输出 data 属性，Conversation.tsx 的 error delegation 读这些属性
    // 决定下一跳的 src。
    const out = replaceRefs(
      `[[ref id=1 type=link url="https://developer.apple.com" title="X"]]`,
      renderRefChip,
    );
    expect(out).toContain('data-favicon-stage="google"');
    expect(out).toContain('data-favicon-domain="developer.apple.com"');
  });

  // ---- v5: chip 完整字段 + emoji icon ----
  // 协议不变（title / key / from / tool_name 已经在 emit）；前端只是换怎么展示。
  // spec: spec/requirements/ref-chip-label-and-icon.md §1。

  it("30. chip 文本 link 用 a.title（v5 完整字段，不再截短 domain）", () => {
    const out = replaceRefs(
      `[[ref id=1 type=link url="https://www.nvidia.com/en-us/" title="NVIDIA 官网"]]`,
      renderRefChip,
    );
    // chip 内的 ref-num 含完整 title
    expect(out).toMatch(/<span class="ref-num">NVIDIA 官网<\/span>/);
    // 不应再回退到 domain 截短
    expect(out).not.toMatch(/<span class="ref-num">nvidia\.com<\/span>/);
  });

  it("31. chip 文本 link 无 title 时 fallback 到 url domain", () => {
    const out = replaceRefs(
      `[[ref id=1 type=link url="https://www.nvidia.com/en-us/"]]`,
      renderRefChip,
    );
    // fallback 链：title 缺失 → extractDomain 去掉 www.
    expect(out).toMatch(/<span class="ref-num">nvidia\.com<\/span>/);
  });

  it("32. chip 文本 memory 用 a.title（v5 完整字段）", () => {
    const out = replaceRefs(
      `[[ref id=1 type=memory key="identity/monox" title="Monox 介绍"]]`,
      renderRefChip,
    );
    expect(out).toMatch(/<span class="ref-num">Monox 介绍<\/span>/);
    // 不应回退到 key 截短
    expect(out).not.toMatch(/<span class="ref-num">monox<\/span>/);
  });

  it("33. chip 文本 memory 无 title 时 fallback 到完整 key（不是截短末段）", () => {
    const out = replaceRefs(
      `[[ref id=1 type=memory key="identity/monox"]]`,
      renderRefChip,
    );
    // 完整 key path，不再是 split('/').pop()
    expect(out).toMatch(/<span class="ref-num">identity\/monox<\/span>/);
  });

  it("34. chip 文本 snippet 用完整 a.from（不再是 first word 截短）", () => {
    const out = replaceRefs(
      `[[ref id=1 type=snippet from="user msg #5" content="hi there"]]`,
      renderRefChip,
    );
    expect(out).toMatch(/<span class="ref-num">user msg #5<\/span>/);
  });

  it("35. chip 文本 tool 用完整 a.tool_name（不再去前缀 mono_）", () => {
    const out = replaceRefs(
      `[[ref id=1 type=tool tool_name="mono_search"]]`,
      renderRefChip,
    );
    expect(out).toMatch(/<span class="ref-num">mono_search<\/span>/);
  });

  it("36. chip 长度上限 24（v4 各 type 独立 10/12/14 → v5 统一 24）", () => {
    const longTitle = "x".repeat(40);
    const out = replaceRefs(
      `[[ref id=1 type=link url="https://x.com" title="${longTitle}"]]`,
      renderRefChip,
    );
    // 截断到 24 字符 + …
    expect(out).toMatch(/<span class="ref-num">x{24}…<\/span>/);
  });

  it("37. emoji icon: 4 种已知 type 各输出对应 emoji（other 走 ❓ fallback）", () => {
    const cases: Array<[string, string]> = [
      ["link", "🔗"],
      ["memory", "📒"],
      ["snippet", "💬"],
      ["tool", "🔧"],
      ["other", "❓"],
    ];
    for (const [t, e] of cases) {
      const out = replaceRefs(
        `[[ref id=1 type=${t}${t === "link" ? ` url="https://x"` : ""}]]`,
        renderRefChip,
      );
      // emoji 字符包在 span.ref-icon-emoji 里
      expect(out).toContain(`<span class="ref-icon-emoji" aria-hidden="true">${e}</span>`);
    }
  });
});