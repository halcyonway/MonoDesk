// Conversation 单测：自动锚定到底部行为。
//
// 用户原话：「重启后打开会话，请你默认滚到最下面。」
// 这条覆盖两个场景：
//   1) 初次 mount 时已经有历史 msgs → 自动 scrollTop = scrollHeight - clientHeight
//      （再加 140px 留白给 composer）
//   2) 流式响应 msgs 变化 → 同步锚到底（不跑就收不到 streaming token）

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { Conversation } from "./Conversation";
import { StreamEngine } from "../stream/engine";
import type { Msg } from "../stream/engine";

// 让 jsdom 能撑起一个有 scrollHeight 的 #conversation 容器。
// scrollHeight 在 jsdom 里默认返回 0，需要靠 clientHeight + 子节点尺寸算出。
function setScrollMetrics(el: HTMLElement, scrollHeight: number, clientHeight: number) {
  Object.defineProperty(el, "scrollHeight", {
    configurable: true,
    get: () => scrollHeight,
  });
  Object.defineProperty(el, "clientHeight", {
    configurable: true,
    get: () => clientHeight,
  });
}

function makeEngine(): StreamEngine {
  // #73: 构造签名改为 router(key) → EngineCallbacks。
  // #74: bind* 现在带 sessionKey 参数；Conversation 测试不触发 dispatch / startTurn，
  // 但 bind 调用会在 mount 时跑，router 用占位即可（Conversation 用固定 sessionKey="s1"）。
  return new StreamEngine(() => ({
    setMsgs: () => {},
    setStatus: () => {},
    setMetrics: () => {},
    setSteps: () => {},
    setModel: () => {},
    setAvailableProviders: () => {},
    setConnected: () => {},
  }));
}

const TEST_SESSION_KEY = "s1";

const userMsg: Msg = { id: "m1", role: "user", text: "hi" };
const assistantMsg: Msg = {
  id: "m2",
  role: "assistant",
  children: [{ id: "c1", kind: "text", text: "hello back" }],
  runId: "t_1",
};

beforeEach(() => {
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = function () {};
});

afterEach(() => {
  cleanup();
});

describe("Conversation auto-scroll on mount", () => {
  it("scrolls to bottom when mounted with non-empty msgs (overflow case)", async () => {
    const engine = makeEngine();
    const { container } = render(
      <Conversation
        sessionKey={TEST_SESSION_KEY}
        msgs={[userMsg, assistantMsg]}
        engine={engine}
        onSend={() => {}}
        onInspectRun={() => {}}
      />
    );
    const el = container.querySelector("#conversation") as HTMLElement;
    expect(el).toBeTruthy();

    // 模拟内容溢出：scrollHeight=500, clientHeight=200 → overflow=300
    setScrollMetrics(el, 500, 200);

    // 等 raf + effect：scrollTop 应等于 overflow + 140 = 440
    await waitFor(() => {
      expect(el.scrollTop).toBe(440);
    });
  });

  it("does not scroll when msgs is empty (skip breathing for empty state)", async () => {
    const engine = makeEngine();
    const { container } = render(
      <Conversation
        sessionKey={TEST_SESSION_KEY}
        msgs={[]}
        engine={engine}
        onSend={() => {}}
        onInspectRun={() => {}}
      />
    );
    const el = container.querySelector("#conversation") as HTMLElement;
    setScrollMetrics(el, 500, 200);

    // 等一帧，scrollTop 应保持 0（没有 msgs 不滚）
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    expect(el.scrollTop).toBe(0);
  });

  it("pins to top when content fits in viewport (no overflow)", async () => {
    const engine = makeEngine();
    const { container } = render(
      <Conversation
        sessionKey={TEST_SESSION_KEY}
        msgs={[userMsg]}
        engine={engine}
        onSend={() => {}}
        onInspectRun={() => {}}
      />
    );
    const el = container.querySelector("#conversation") as HTMLElement;
    // 内容比视口短：scrollHeight=100, clientHeight=500 → 不滚
    setScrollMetrics(el, 100, 500);

    await waitFor(() => {
      expect(el.scrollTop).toBe(0);
    });
  });

  it("re-scrolls when msgs reference changes (streaming / session switch)", async () => {
    const engine = makeEngine();
    const { container, rerender } = render(
      <Conversation
        sessionKey={TEST_SESSION_KEY}
        msgs={[userMsg]}
        engine={engine}
        onSend={() => {}}
        onInspectRun={() => {}}
      />
    );
    const el = container.querySelector("#conversation") as HTMLElement;
    setScrollMetrics(el, 500, 200);

    await waitFor(() => {
      expect(el.scrollTop).toBe(440);
    });

    // 模拟新消息进来（流式 token / 切会话）→ msgs 引用变化 → 再次滚到底
    const moreMsgs: Msg[] = [
      userMsg,
      assistantMsg,
      { id: "m3", role: "user", text: "follow-up" },
      { id: "m4", role: "assistant", children: [{ id: "c2", kind: "text", text: "ok" }] },
    ];
    rerender(
      <Conversation
        sessionKey={TEST_SESSION_KEY}
        msgs={moreMsgs}
        engine={engine}
        onSend={() => {}}
        onInspectRun={() => {}}
      />
    );
    // scrollHeight 增大 → 新 overflow = 800 - 200 = 600 → scrollTop = 740
    setScrollMetrics(el, 800, 200);

    await waitFor(() => {
      expect(el.scrollTop).toBe(740);
    });
  });
});

describe("Conversation inline agent metrics (#70)", () => {
  function assistantWithMetrics(
    extras: Partial<Extract<Msg, { role: "assistant" }>>
  ): Msg {
    return {
      id: "a1",
      role: "assistant",
      children: [{ id: "c1", kind: "text", text: "hi" }],
      ...extras,
    };
  }

  it("renders tokens / latency / cache ratio inline in assistant label", () => {
    const engine = makeEngine();
    const msg = assistantWithMetrics({
      runId: "t_1",
      tokens: { prompt: 3500, completion: 80, cached: 3000 },
      latencyMs: 412,
    });
    const { container } = render(
      <Conversation
        sessionKey={TEST_SESSION_KEY}
        msgs={[userMsg, msg]}
        engine={engine}
        onSend={() => {}}
        onInspectRun={() => {}}
      />
    );

    const tokens = container.querySelector(".msg-meta-tokens");
    expect(tokens?.textContent).toBe("80 tok"); // completion only

    const lat = container.querySelector(".msg-meta-lat");
    expect(lat?.textContent).toBeTruthy(); // fmtMs(412) → "412ms"

    const cache = container.querySelector(".msg-meta-cache");
    // 3000/3500 = 85.7%
    expect(cache?.textContent).toContain("85.7%");
  });

  it("hides inline metric when tokens not present (streaming / no data yet)", () => {
    const engine = makeEngine();
    const msg = assistantWithMetrics({ runId: "t_1" });
    const { container } = render(
      <Conversation
        sessionKey={TEST_SESSION_KEY}
        msgs={[userMsg, msg]}
        engine={engine}
        onSend={() => {}}
        onInspectRun={() => {}}
      />
    );
    expect(container.querySelector(".msg-meta-tokens")).toBeFalsy();
    expect(container.querySelector(".msg-meta-lat")).toBeFalsy();
    expect(container.querySelector(".msg-meta-cache")).toBeFalsy();
  });

  it("hides cache pill when prompt=0 or cached=0 (avoids 0.0% noise)", () => {
    const engine = makeEngine();
    const msg = assistantWithMetrics({
      runId: "t_1",
      tokens: { prompt: 0, completion: 10, cached: 0 },
      latencyMs: 100,
    });
    const { container } = render(
      <Conversation
        sessionKey={TEST_SESSION_KEY}
        msgs={[userMsg, msg]}
        engine={engine}
        onSend={() => {}}
        onInspectRun={() => {}}
      />
    );
    expect(container.querySelector(".msg-meta-cache")).toBeFalsy();
    // tokens 和 latency 仍显示
    expect(container.querySelector(".msg-meta-tokens")?.textContent).toBe("10 tok");
  });

  it("hides cache pill when cached field is absent (LLM did not report cache stats)", () => {
    // 场景：MiniMax 流式响应的 usage chunk 不一定带 prompt_tokens_details.cached_tokens
    // （< 512 token prompt、cache build-up 阶段都会缺失）。此时 msg.tokens 没 cached
    // 字段 → 不应该显示 ⚡ 0.0% 噪声。
    const engine = makeEngine();
    const msg = assistantWithMetrics({
      runId: "t_1",
      tokens: { prompt: 200, completion: 30 }, // 无 cached 字段
      latencyMs: 100,
    });
    const { container } = render(
      <Conversation
        sessionKey={TEST_SESSION_KEY}
        msgs={[userMsg, msg]}
        engine={engine}
        onSend={() => {}}
        onInspectRun={() => {}}
      />
    );
    expect(container.querySelector(".msg-meta-cache")).toBeFalsy();
    // tokens / latency 仍显示（这些字段与 cache 独立）
    expect(container.querySelector(".msg-meta-tokens")?.textContent).toBe("30 tok");
  });

  it("shows cache pill when cached > 0 (real cache hit)", () => {
    const engine = makeEngine();
    const msg = assistantWithMetrics({
      runId: "t_1",
      tokens: { prompt: 500, completion: 20, cached: 300 }, // 60% cache hit
      latencyMs: 100,
    });
    const { container } = render(
      <Conversation
        sessionKey={TEST_SESSION_KEY}
        msgs={[userMsg, msg]}
        engine={engine}
        onSend={() => {}}
        onInspectRun={() => {}}
      />
    );
    expect(container.querySelector(".msg-meta-cache")?.textContent).toContain("60.0%");
  });

  it("trace button click triggers onInspectRun with runId", () => {
    const engine = makeEngine();
    const onInspectRun = vi.fn();
    const msg = assistantWithMetrics({
      runId: "t_xyz",
      tokens: { prompt: 100, completion: 5, cached: 50 },
      latencyMs: 100,
    });
    const { container } = render(
      <Conversation
        sessionKey={TEST_SESSION_KEY}
        msgs={[userMsg, msg]}
        engine={engine}
        onSend={() => {}}
        onInspectRun={onInspectRun}
      />
    );
    const btn = container.querySelector(".trace-btn") as HTMLButtonElement;
    fireEvent.click(btn);
    expect(onInspectRun).toHaveBeenCalledWith("t_xyz");
  });
});

describe("Conversation attachment rendering by mime (doc-tool-universal)", () => {
  // 之前 bug：所有 attachment 一律用 <img>，PDF 不是图片 → broken image icon。
  // 修法：按 mime 分流 — image/* → <img>，application/pdf → <object>，
  //       其它（text/* / json）→ doc thumb（icon + 文件名）。
  it("image attachment renders as <img>", () => {
    const engine = makeEngine();
    const msg: Msg = {
      id: "m1",
      role: "user",
      text: "see this",
      attachments: [
        { url: "http://x/y.png", name: "y.png", mime: "image/png" },
      ],
    };
    const { container } = render(
      <Conversation sessionKey="s1" msgs={[msg]} engine={engine} onSend={() => {}} onInspectRun={() => {}} />
    );
    const img = container.querySelector(".msg-attachment-thumb img") as HTMLImageElement;
    expect(img).toBeTruthy();
    expect(img.getAttribute("src")).toBe("http://x/y.png");
  });

  it("PDF attachment renders as <object type=application/pdf> (NOT <img>)", () => {
    const engine = makeEngine();
    const msg: Msg = {
      id: "m1",
      role: "user",
      text: "read this",
      attachments: [
        { url: "http://x/doc.pdf", name: "doc.pdf", mime: "application/pdf" },
      ],
    };
    const { container } = render(
      <Conversation sessionKey="s1" msgs={[msg]} engine={engine} onSend={() => {}} onInspectRun={() => {}} />
    );
    // 不应该有 <img>（之前 bug：PDF 走了 <img> → broken icon）
    const img = container.querySelector(".msg-attachment-thumb img");
    expect(img).toBeFalsy();
    // 应该有 <object type=application/pdf>
    const obj = container.querySelector('.msg-attachment-thumb object[type="application/pdf"]') as HTMLObjectElement;
    expect(obj).toBeTruthy();
    expect(obj.getAttribute("data")).toBe("http://x/doc.pdf");
  });

  it("text/csv attachment renders as doc-thumb (not <img>, not <object>)", () => {
    const engine = makeEngine();
    const msg: Msg = {
      id: "m1",
      role: "user",
      text: "table",
      attachments: [
        { url: "http://x/data.csv", name: "data.csv", mime: "text/csv" },
      ],
    };
    const { container } = render(
      <Conversation sessionKey="s1" msgs={[msg]} engine={engine} onSend={() => {}} onInspectRun={() => {}} />
    );
    expect(container.querySelector(".msg-attachment-thumb img")).toBeFalsy();
    expect(container.querySelector(".msg-attachment-thumb object")).toBeFalsy();
    const doc = container.querySelector(".doc-thumb");
    expect(doc).toBeTruthy();
    expect(doc?.textContent).toContain("data.csv");
  });

  it("mixed attachments route independently per mime", () => {
    const engine = makeEngine();
    const msg: Msg = {
      id: "m1",
      role: "user",
      text: "three files",
      attachments: [
        { url: "http://x/a.png", name: "a.png", mime: "image/png" },
        { url: "http://x/b.pdf", name: "b.pdf", mime: "application/pdf" },
        { url: "http://x/c.json", name: "c.json", mime: "application/json" },
      ],
    };
    const { container } = render(
      <Conversation sessionKey="s1" msgs={[msg]} engine={engine} onSend={() => {}} onInspectRun={() => {}} />
    );
    expect(container.querySelectorAll(".msg-attachment-thumb img")).toHaveLength(1);
    expect(container.querySelectorAll('.msg-attachment-thumb object[type="application/pdf"]')).toHaveLength(1);
    expect(container.querySelectorAll(".doc-thumb")).toHaveLength(1);
  });
});