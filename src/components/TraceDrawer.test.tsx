// TraceDrawer 单测：loading → loaded / error / close / retry + v2 OTel 字段渲染。
//
// 用 @testing-library/react render 真实组件，注入 fake TraceClient。
// 单测焦点放在「可观察的语义」上（aria-hidden、retry 按钮、OTel attr 渲染、
// 默认折叠规则），不验证 querySelector 字符串细节。

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";
import { TraceDrawer } from "./TraceDrawer";
import type { TraceClient } from "../observability/client";
import type { TraceRun, TraceSpan, TraceTurn } from "../ws/protocol";

// v2 fixture：OTel-style 扁平 attr；schema_version=2 必填（client.ts 会 reject v1）。
// 单 turn + 单 reasoning span + 2 条 messages + 完整 token 用量 —— 覆盖 tree +
// detail 面板最常用的渲染分支。
const SAMPLE_RUN: TraceRun = {
  run_id: "t_abc123def456",
  session_key: "default",
  user_text: "hi",
  final_text: "hello back",
  start_ts: 1_700_000_000,
  end_ts: 1_700_000_001,
  status: "ok",
  schema_version: 2,
  spans: [], // run-level phase spans（bootstrap/loop/finalize）—— fixture 里空
  turns: [
    {
      turn_id: "u_xyz",
      turn_idx: 0,
      spans: [
        {
          span_id: "s_r1",
          parent_id: "u_xyz", // 指向 TURN 容器 span_id（== turn_id）
          kind: "reasoning",
          name: "reasoning",
          start_ts: 1.0,
          end_ts: 1.4,
          status: "ok",
          attributes: {
            "gen_ai.request.model": "test-model",
            "gen_ai.client.operation.duration": 412,
            "gen_ai.usage.input_tokens": 10,
            "gen_ai.usage.output_tokens": 4,
            "gen_ai.request.messages": [
              { role: "system", content: "you are a helper" },
              { role: "user", content: "hi" },
            ],
            "gen_ai.response.text": "hello back",
            "gen_ai.response.finish_reasons": "stop",
          },
        },
      ],
    },
  ],
};

class FakeClient {
  getRun = vi.fn(async (_sessionKey: string, _runId: string): Promise<TraceRun> => SAMPLE_RUN);
  getRecent = vi.fn(async (_sessionKey: string, _limit?: number) => []);
  invalidate = vi.fn();
}

function makeClient(opts: { fail?: boolean } = {}): TraceClient {
  const c = new FakeClient() as unknown as TraceClient;
  if (opts.fail) {
    (c as unknown as FakeClient).getRun = vi.fn(async () => {
      throw new Error("boom");
    });
  }
  return c;
}

beforeEach(() => {
  // 让 querySelector / getBoundingClientRect 在 jsdom 里正常
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = function () {};
});

afterEach(() => {
  cleanup();
});

describe("TraceDrawer", () => {
  it("renders closed when runId is null", () => {
    const client = makeClient();
    const onClose = vi.fn();
    const { container } = render(
      <TraceDrawer runId={null} sessionKey="default" client={client} onClose={onClose} />
    );
    const drawer = container.querySelector(".trace-drawer");
    expect(drawer).toBeTruthy();
    expect(drawer?.getAttribute("aria-hidden")).toBe("true");
  });

  it("opens and shows loading skeleton then loaded run", async () => {
    const client = makeClient();
    const onClose = vi.fn();

    const { container } = render(
      <TraceDrawer runId="t_abc" sessionKey="default" client={client} onClose={onClose} />
    );

    // 打开后应该有 skeleton
    await waitFor(() => {
      expect(container.querySelector(".trace-skel")).toBeTruthy();
    });

    // 加载完成后 skeleton 消失，tree pane 出现
    await waitFor(() => {
      expect(container.querySelector(".trace-tree-pane")).toBeTruthy();
      expect(container.querySelector(".trace-skel")).toBeFalsy();
    });

    // Run header 显示 run_id + user_text
    expect(container.textContent).toContain("hi");
    // tree pane 含 turn 节点（默认折叠），展开后才能看到 span
    expect(container.querySelector(".trace-tree-turn")).toBeTruthy();
    fireEvent.click(container.querySelector(".trace-tree-turn .trace-chev") as HTMLElement);
    await waitFor(() => {
      expect(container.querySelector(".trace-tree-span")).toBeTruthy();
    });
    // aria-hidden=false
    const drawer = container.querySelector(".trace-drawer");
    expect(drawer?.getAttribute("aria-hidden")).toBe("false");
  });

  it("shows error state and retry button on fetch failure", async () => {
    const client = makeClient({ fail: true });
    const onClose = vi.fn();
    const { container } = render(
      <TraceDrawer runId="t_abc" sessionKey="default" client={client} onClose={onClose} />
    );

    await waitFor(() => {
      expect(container.querySelector(".trace-error")).toBeTruthy();
      expect(container.textContent).toContain("boom");
    });

    const retry = container.querySelector(".trace-retry");
    expect(retry).toBeTruthy();
  });

  it("retry button re-invokes getRun and recovers", async () => {
    const fake = new FakeClient() as unknown as TraceClient;
    (fake as unknown as FakeClient).getRun = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce(SAMPLE_RUN);
    const onClose = vi.fn();

    const { container } = render(
      <TraceDrawer runId="t_abc" sessionKey="default" client={fake} onClose={onClose} />
    );

    await waitFor(() => {
      expect(container.querySelector(".trace-error")).toBeTruthy();
    });

    const retry = container.querySelector(".trace-retry") as HTMLButtonElement;
    fireEvent.click(retry);

    await waitFor(() => {
      expect(container.querySelector(".trace-tree-pane")).toBeTruthy();
      expect(container.querySelector(".trace-error")).toBeFalsy();
    });
  });

  it("close button triggers onClose callback", async () => {
    const client = makeClient();
    const onClose = vi.fn();
    const { container } = render(
      <TraceDrawer runId="t_abc" sessionKey="default" client={client} onClose={onClose} />
    );

    await waitFor(() => {
      expect(container.querySelector(".trace-close")).toBeTruthy();
    });

    const closeBtn = container.querySelector(".trace-close") as HTMLButtonElement;
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Escape key closes the drawer when open", async () => {
    const client = makeClient();
    const onClose = vi.fn();
    const { container } = render(
      <TraceDrawer runId="t_abc" sessionKey="default" client={client} onClose={onClose} />
    );

    await waitFor(() => {
      expect(container.querySelector(".trace-drawer")?.getAttribute("aria-hidden")).toBe("false");
    });

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("scrim click closes the drawer", async () => {
    const client = makeClient();
    const onClose = vi.fn();
    const { container } = render(
      <TraceDrawer runId="t_abc" sessionKey="default" client={client} onClose={onClose} />
    );

    await waitFor(() => {
      expect(container.querySelector(".trace-scrim.open")).toBeTruthy();
    });

    const scrim = container.querySelector(".trace-scrim") as HTMLDivElement;
    fireEvent.click(scrim);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("switching runId triggers a fresh fetch", async () => {
    const fake = new FakeClient() as unknown as TraceClient;
    const resolvers: Array<(r: TraceRun) => void> = [];
    (fake as unknown as FakeClient).getRun = vi.fn(
      () => new Promise<TraceRun>((r) => { resolvers.push(r); })
    );
    const onClose = vi.fn();

    const { container, rerender } = render(
      <TraceDrawer runId="t_first" sessionKey="default" client={fake} onClose={onClose} />
    );

    expect((fake as unknown as FakeClient).getRun).toHaveBeenCalledWith("default", "t_first");

    rerender(
      <TraceDrawer runId="t_second" sessionKey="default" client={fake} onClose={onClose} />
    );
    expect((fake as unknown as FakeClient).getRun).toHaveBeenCalledWith("default", "t_second");

    resolvers[0]?.(SAMPLE_RUN);
    await waitFor(() => {
      expect(container.querySelector(".trace-skel")).toBeTruthy();
    });

    resolvers[1]?.(SAMPLE_RUN);
    await waitFor(() => {
      expect(container.querySelector(".trace-tree-pane")).toBeTruthy();
    });
  });

  it("renders 'no spans' empty state for an empty run", async () => {
    const fake = new FakeClient() as unknown as TraceClient;
    (fake as unknown as FakeClient).getRun = vi.fn(async () => ({
      ...SAMPLE_RUN,
      turns: [],
      spans: [],
    }));
    const { container } = render(
      <TraceDrawer runId="t_empty" sessionKey="default" client={fake} onClose={vi.fn()} />
    );

    await waitFor(() => {
      // 新 UI 的空状态文案
      expect(container.textContent).toContain("no spans");
    });
  });
});

describe("TraceDrawer v2 trace shape", () => {
  function reasoningSpan(overrides: Partial<TraceSpan> = {}): TraceSpan {
    return {
      span_id: "s_a1",
      parent_id: "u_a",
      kind: "reasoning",
      name: "reasoning",
      start_ts: 1.0,
      end_ts: 1.1,
      status: "ok",
      attributes: {
        "gen_ai.request.model": "m",
        "gen_ai.client.operation.duration": 100,
        "gen_ai.usage.input_tokens": 1000,
        "gen_ai.usage.output_tokens": 50,
        "gen_ai.usage.cached_tokens": 800,
      },
      ...overrides,
    };
  }

  function turn(turnId: string, turnIdx: number, spans: TraceSpan[]): TraceTurn {
    return { turn_id: turnId, turn_idx: turnIdx, spans };
  }

  function runWith(turns: TraceTurn[]): TraceRun {
    return {
      ...SAMPLE_RUN,
      turns,
      spans: [],
    };
  }

  it("shows per-call cached_tokens in the right detail panel (not the tree)", async () => {
    // cache / tokens / TTFT 不在 tree row 上展示；右栏 detail panel 的 OUTPUT
    // section 通过 OTel key gen_ai.usage.cached_tokens 暴露。
    const fake = new FakeClient() as unknown as TraceClient;
    (fake as unknown as FakeClient).getRun = vi.fn(async () =>
      runWith([turn("u_a", 0, [reasoningSpan()])])
    );
    const { container } = render(
      <TraceDrawer runId="t_cache" sessionKey="default" client={fake} onClose={vi.fn()} />
    );

    await waitFor(() => {
      expect(container.querySelector(".trace-tree-pane")).toBeTruthy();
    });
    // tree 上不显示 cache chip
    expect(container.querySelector(".trace-tree-span-cache")).toBeFalsy();
    expect(container.querySelector(".trace-tree-turn-cache")).toBeFalsy();

    // 展开 turn → 选中 span
    fireEvent.click(container.querySelector(".trace-tree-turn .trace-chev") as HTMLElement);
    fireEvent.click(container.querySelector(".trace-tree-span-head") as HTMLElement);

    await waitFor(() => {
      // 右栏 detail panel 显示 OTel keys：cache 来自 gen_ai.usage.cached_tokens
      const detailText = container.querySelector(".trace-detail")?.textContent || "";
      expect(detailText).toContain("cached_tokens");
    });
  });

  it("does not show cache chip when cached_tokens is absent", async () => {
    const fake = new FakeClient() as unknown as TraceClient;
    (fake as unknown as FakeClient).getRun = vi.fn(async () =>
      runWith([
        turn("u_a", 0, [
          reasoningSpan({
            attributes: {
              "gen_ai.request.model": "m",
              "gen_ai.usage.input_tokens": 10,
              "gen_ai.usage.output_tokens": 4,
            },
          }),
        ]),
      ])
    );
    const { container } = render(
      <TraceDrawer runId="t_no_cache" sessionKey="default" client={fake} onClose={vi.fn()} />
    );

    await waitFor(() => {
      expect(container.querySelector(".trace-tree-pane")).toBeTruthy();
    });

    expect(container.querySelector(".trace-tree-span-cache")).toBeFalsy();
  });

  it("hides token counts when reasoning span usage is empty (legacy trace)", async () => {
    const fake = new FakeClient() as unknown as TraceClient;
    (fake as unknown as FakeClient).getRun = vi.fn(async () =>
      runWith([
        turn("u_legacy", 0, [
          reasoningSpan({
            span_id: "s_legacy",
            name: "reasoning:MiniMax-M2.7",
            attributes: {
              "gen_ai.request.model": "MiniMax-M2.7",
              "gen_ai.client.operation.duration": 412,
              // usage 完全缺 → tokenSummary 返回 null → 不显示 tokens
            },
          }),
        ]),
      ])
    );
    const { container } = render(
      <TraceDrawer runId="t_legacy" sessionKey="default" client={fake} onClose={vi.fn()} />
    );

    await waitFor(() => {
      // 旧 bug：usage 是空 dict 时显示 "0→0 tok" / "tokens 0 → 0"
      // 新 UI 应该完全隐藏 token 计数
      expect(container.querySelector(".trace-tree-span-tokens")).toBeFalsy();
      expect(container.querySelector(".trace-tree-turn-tokens")).toBeFalsy();
    });
  });

  it("shows token counts in the right detail panel (not the tree)", async () => {
    // tokens（input_tokens / output_tokens）不在 tree row 上展示；
    // 右栏 detail panel 的 OUTPUT section 通过 OTel keys 暴露。
    const fake = new FakeClient() as unknown as TraceClient;
    (fake as unknown as FakeClient).getRun = vi.fn(async () =>
      runWith([turn("u_a", 0, [reasoningSpan()])]) // input=1000, output=50
    );
    const { container } = render(
      <TraceDrawer runId="t_abc" sessionKey="default" client={fake} onClose={vi.fn()} />
    );

    await waitFor(() => {
      expect(container.querySelector(".trace-tree-pane")).toBeTruthy();
    });
    expect(container.querySelector(".trace-tree-span-tokens")).toBeFalsy();

    // 展开 turn → 选中 span
    fireEvent.click(container.querySelector(".trace-tree-turn .trace-chev") as HTMLElement);
    fireEvent.click(container.querySelector(".trace-tree-span-head") as HTMLElement);

    await waitFor(() => {
      const detailText = container.querySelector(".trace-detail")?.textContent || "";
      expect(detailText).toContain("input_tokens");
      expect(detailText).toContain("output_tokens");
      expect(detailText).toContain("1000");
      expect(detailText).toContain("50");
    });
  });

  it("uses run-local turn numbering (#1, #2, ...) ignoring turn_idx", async () => {
    // 重启 MonoX 后从 checkpoint 恢复：turn_idx 不从 0 开始，但 UI 必须从 #1 开始。
    const fake = new FakeClient() as unknown as TraceClient;
    (fake as unknown as FakeClient).getRun = vi.fn(async () =>
      runWith([
        turn("u_a", 7, [reasoningSpan({ span_id: "s_a1" })]),
        turn("u_b", 8, [reasoningSpan({ span_id: "s_b1" })]),
        turn("u_c", 9, [reasoningSpan({ span_id: "s_c1" })]),
      ])
    );
    const { container } = render(
      <TraceDrawer runId="t_multi" sessionKey="default" client={fake} onClose={vi.fn()} />
    );

    await waitFor(() => {
      expect(container.querySelectorAll(".trace-tree-turn")).toHaveLength(3);
    });

    const labels = Array.from(container.querySelectorAll(".trace-tree-turn-label")).map(
      (n) => n.textContent
    );
    expect(labels).toEqual(["turn #1", "turn #2", "turn #3"]);
  });

  it("renders turn nodes default-collapsed (open=false on .trace-tree-turn)", async () => {
    const fake = new FakeClient() as unknown as TraceClient;
    (fake as unknown as FakeClient).getRun = vi.fn(async () =>
      runWith([turn("u_a", 0, [reasoningSpan()])])
    );
    const { container } = render(
      <TraceDrawer runId="t_collapse" sessionKey="default" client={fake} onClose={vi.fn()} />
    );

    await waitFor(() => {
      const t = container.querySelector(".trace-tree-turn");
      expect(t).toBeTruthy();
      // 默认折叠：body 不渲染，class 没有 .open
      expect(t?.classList.contains("open")).toBe(false);
      // body div 不存在（条件渲染）
      expect(container.querySelector(".trace-tree-turn-body")).toBeFalsy();
    });
  });

  it("expanding a turn shows its child span nodes", async () => {
    const fake = new FakeClient() as unknown as TraceClient;
    (fake as unknown as FakeClient).getRun = vi.fn(async () =>
      runWith([turn("u_a", 0, [reasoningSpan()])])
    );
    const { container } = render(
      <TraceDrawer runId="t_expand" sessionKey="default" client={fake} onClose={vi.fn()} />
    );

    await waitFor(() => {
      expect(container.querySelector(".trace-tree-turn")).toBeTruthy();
    });

    // 默认折叠 → body 没渲染
    expect(container.querySelector(".trace-tree-turn-body")).toBeFalsy();

    // 点 chevron 展开
    const chev = container.querySelector(".trace-tree-turn .trace-chev") as HTMLElement;
    fireEvent.click(chev);

    await waitFor(() => {
      expect(container.querySelector(".trace-tree-turn-body")).toBeTruthy();
      expect(container.querySelector(".trace-tree-span")).toBeTruthy();
    });
  });

  it("shows trace_id (run_id) in full — no truncation", async () => {
    const fake = new FakeClient() as unknown as TraceClient;
    const longId = "t_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; // 33 chars，远超短码
    (fake as unknown as FakeClient).getRun = vi.fn(async () => ({
      ...SAMPLE_RUN,
      run_id: longId,
    }));
    const { container } = render(
      <TraceDrawer runId={longId} sessionKey="default" client={fake} onClose={vi.fn()} />
    );

    await waitFor(() => {
      // .trace-run-id 里必须出现完整 run_id（旧的 shortId 截断 bug 这里抓）
      const runIdEl = container.querySelector(".trace-run-id");
      expect(runIdEl?.textContent).toContain(longId);
      // 不应该有 "…" 截断符
      expect(runIdEl?.textContent).not.toContain("…");
    });
  });

  it("shows full span_id (no truncation) in tree and detail panel", async () => {
    const fake = new FakeClient() as unknown as TraceClient;
    const longSpanId = "s_zzzzzzzzzzzzzzzz"; // 18 chars
    (fake as unknown as FakeClient).getRun = vi.fn(async () =>
      runWith([turn("u_a", 0, [reasoningSpan({ span_id: longSpanId })])])
    );
    const { container } = render(
      <TraceDrawer runId="t_long_span" sessionKey="default" client={fake} onClose={vi.fn()} />
    );

    await waitFor(() => {
      expect(container.querySelector(".trace-tree-pane")).toBeTruthy();
    });
    // turn 默认折叠 → 展开后才能看到 span_id
    fireEvent.click(container.querySelector(".trace-tree-turn .trace-chev") as HTMLElement);

    await waitFor(() => {
      const treeSpanId = container.querySelector(".trace-tree-span-id");
      expect(treeSpanId?.textContent).toBe(longSpanId);
    });
  });

  it("renders INPUT/OUTPUT JSON trees with OTel attribute keys after selecting a reasoning span", async () => {
    const fake = new FakeClient() as unknown as TraceClient;
    (fake as unknown as FakeClient).getRun = vi.fn(async () =>
      runWith([
        turn("u_a", 0, [
          reasoningSpan({
            attributes: {
              "gen_ai.request.model": "m",
              "gen_ai.client.operation.duration": 100,
              "gen_ai.usage.input_tokens": 10,
              "gen_ai.usage.output_tokens": 4,
              "gen_ai.request.messages": [
                { role: "system", content: "you are a helper" },
              ],
            },
          }),
        ]),
      ])
    );
    const { container } = render(
      <TraceDrawer runId="t_otel" sessionKey="default" client={fake} onClose={vi.fn()} />
    );

    // 默认选中 RUN 节点 → detail 面板的 SUMMARY 应有 schema_version
    await waitFor(() => {
      expect(container.querySelector(".trace-detail-pane")).toBeTruthy();
      expect(container.textContent).toContain("schema_version");
      expect(container.textContent).toContain("2");
    });

    // 展开 turn → 点选 span 节点 → detail 面板切换到 span
    fireEvent.click(container.querySelector(".trace-tree-turn .trace-chev") as HTMLElement);
    await waitFor(() => {
      expect(container.querySelector(".trace-tree-span-head")).toBeTruthy();
    });
    fireEvent.click(container.querySelector(".trace-tree-span-head") as HTMLElement);

    await waitFor(() => {
      // INPUT / OUTPUT 两个 section 都在
      const sectionTitles = container.querySelectorAll(".trace-section-title");
      const titles = Array.from(sectionTitles).map((t) => t.textContent);
      expect(titles).toContain("INPUT");
      expect(titles).toContain("OUTPUT");
      // 没有 META · other attributes 这种碎区了
      expect(titles.find((t) => t && t.includes("META"))).toBeFalsy();
      // JSON tree 渲染了
      expect(container.querySelector(".trace-jt")).toBeTruthy();
      // OTel key 出现在 JSON tree 里
      expect(container.textContent).toContain("gen_ai.request.model");
      expect(container.textContent).toContain("gen_ai.usage.input_tokens");
    });
  });

  it("messages array renders as JSON tree (no longer bespoke message rows)", async () => {
    // 旧 UI 用 MessageRow 美化 messages；现在 messages 跟其他 attr 一样走 JSON tree。
    const fake = new FakeClient() as unknown as TraceClient;
    (fake as unknown as FakeClient).getRun = vi.fn(async () =>
      runWith([
        turn("u_a", 0, [
          reasoningSpan({
            attributes: {
              "gen_ai.request.model": "m",
              "gen_ai.request.messages": [
                { role: "system", content: "you are a helper" },
                { role: "user", content: "hi" },
                { role: "assistant", content: "hello back" },
              ],
            },
          }),
        ]),
      ])
    );
    const { container } = render(
      <TraceDrawer runId="t_msgs" sessionKey="default" client={fake} onClose={vi.fn()} />
    );

    // 展开 turn → 选中 span → 看到 JSON tree
    await waitFor(() => {
      expect(container.querySelector(".trace-tree-turn")).toBeTruthy();
    });
    fireEvent.click(container.querySelector(".trace-tree-turn .trace-chev") as HTMLElement);
    fireEvent.click(container.querySelector(".trace-tree-span-head") as HTMLElement);

    await waitFor(() => {
      // 没有 bespoke .trace-msg / .trace-messages 了
      expect(container.querySelector(".trace-msg")).toBeFalsy();
      expect(container.querySelector(".trace-messages")).toBeFalsy();
      // messages 出现在 JSON tree 里
      const jt = container.querySelector(".trace-jt");
      expect(jt).toBeTruthy();
      expect(container.textContent).toContain("you are a helper");
      expect(container.textContent).toContain("hello back");
    });
  });

  it("long string values can be expanded in JSON tree", async () => {
    const fake = new FakeClient() as unknown as TraceClient;
    (fake as unknown as FakeClient).getRun = vi.fn(async () =>
      runWith([
        turn("u_a", 0, [
          reasoningSpan({
            attributes: {
              "gen_ai.request.model": "m",
              "gen_ai.response.text": "a".repeat(500),
            },
          }),
        ]),
      ])
    );
    const { container } = render(
      <TraceDrawer runId="t_long_string" sessionKey="default" client={fake} onClose={vi.fn()} />
    );

    // 展开 turn → 选中 span
    await waitFor(() => {
      expect(container.querySelector(".trace-tree-turn")).toBeTruthy();
    });
    fireEvent.click(container.querySelector(".trace-tree-turn .trace-chev") as HTMLElement);
    fireEvent.click(container.querySelector(".trace-tree-span-head") as HTMLElement);

    await waitFor(() => {
      // JsonRow 渲染了，response.text 行存在
      const jtRows = container.querySelectorAll(".trace-jt-row");
      expect(jtRows.length).toBeGreaterThan(0);
      // 字符串 value 出现在 .trace-jt-string
      expect(container.querySelector(".trace-jt-string")).toBeTruthy();
    });
  });

  it("long strings show preview with show full button (no truncation when expanded)", async () => {
    // 长字符串默认显示预览（前 160 字符 + …提示），点 show full 看全量；
    // 展开后字符串必须完整，绝不能被 word-break 切字符。
    const longText = "x".repeat(500);
    const fake = new FakeClient() as unknown as TraceClient;
    (fake as unknown as FakeClient).getRun = vi.fn(async () =>
      runWith([
        turn("u_a", 0, [
          reasoningSpan({
            attributes: {
              "gen_ai.request.model": "m",
              "gen_ai.response.text": longText,
            },
          }),
        ]),
      ])
    );
    const { container } = render(
      <TraceDrawer runId="t_long_preview" sessionKey="default" client={fake} onClose={vi.fn()} />
    );

    await waitFor(() => {
      expect(container.querySelector(".trace-tree-turn")).toBeTruthy();
    });
    fireEvent.click(container.querySelector(".trace-tree-turn .trace-chev") as HTMLElement);
    fireEvent.click(container.querySelector(".trace-tree-span-head") as HTMLElement);

    await waitFor(() => {
      // 默认折叠：JsonRow 没有 open 属性
      const jtRows = container.querySelectorAll(".trace-jt-row-tree");
      jtRows.forEach((r) => {
        expect(r.hasAttribute("open")).toBe(false);
      });
      // "show full" 按钮存在
      expect(container.querySelector(".trace-jt-more")).toBeTruthy();
    });

    // 点 show full → 长字符串完全展开（500 个 x 全部出现，没有截断）
    fireEvent.click(container.querySelector(".trace-jt-more") as HTMLElement);
    await waitFor(() => {
      // .trace-jt-string-wrap 内的 .trace-jt-string 才是被展开的长字符串；
      // 第一个 .trace-jt-string 是 model="m"（短字符串，没 show full）。
      const text =
        container.querySelector(".trace-jt-string-wrap .trace-jt-string")?.textContent || "";
      // 字符串计数 = 500 个 x + 2 个引号
      expect(text.match(/x/g)?.length).toBe(500);
      expect(text).not.toContain("…");
    });
  });

  it("ACT node has nested tool spans as children in the tree", async () => {
    // ACT 节点的 body 渲染所有 parent_id 指向它的 tool 子 span；
    // 同时 tool 不能跟 ACT 同级出现在 turn body 下（避免双渲染）。
    // ACT span 的 parent_id = turn span_id；TOOL span 的 parent_id = act span_id。
    const fake = new FakeClient() as unknown as TraceClient;
    (fake as unknown as FakeClient).getRun = vi.fn(async () => ({
      ...SAMPLE_RUN,
      turns: [
        {
          turn_id: "u_act",
          turn_idx: 0,
          spans: [
            {
              span_id: "s_a_reasoning",
              parent_id: "u_act",
              kind: "reasoning",
              name: "reasoning",
              start_ts: 1.0,
              end_ts: 1.5,
              status: "ok",
              attributes: {
                "gen_ai.request.model": "m",
                "gen_ai.client.operation.duration": 100,
              },
            },
            {
              span_id: "s_act_1",
              parent_id: "u_act",
              kind: "act",
              name: "act",
              start_ts: 1.5,
              end_ts: 1.7,
              status: "ok",
              attributes: {},
            },
            {
              span_id: "s_tool_bash",
              parent_id: "s_act_1", // ← 挂在 ACT 下面
              kind: "tool",
              name: "tool:bash",
              start_ts: 1.5,
              end_ts: 1.6,
              status: "ok",
              attributes: { "tool.name": "bash" },
            },
            {
              span_id: "s_tool_read",
              parent_id: "s_act_1", // ← 同 ACT 下的另一个 tool
              kind: "tool",
              name: "tool:read_doc",
              start_ts: 1.6,
              end_ts: 1.7,
              status: "ok",
              attributes: { "tool.name": "read_doc" },
            },
          ],
        },
      ],
      spans: [],
    }));
    const { container } = render(
      <TraceDrawer runId="t_act_tools" sessionKey="default" client={fake} onClose={vi.fn()} />
    );

    // 展开 turn
    await waitFor(() => {
      expect(container.querySelector(".trace-tree-turn")).toBeTruthy();
    });
    fireEvent.click(container.querySelector(".trace-tree-turn .trace-chev") as HTMLElement);

    await waitFor(() => {
      // 关键不变量：tool 不能跟 ACT 同级出现（避免双渲染）。
      // turn body 里只能看到 reasoning + act 两个 span；两个 tool 必须藏在 ACT 里。
      const topLevelSpans = container.querySelectorAll(".trace-tree-turn-body > .trace-tree-span");
      expect(topLevelSpans.length).toBe(2);
      const topLevelNames = Array.from(topLevelSpans).map(
        (n) => n.querySelector(".trace-tree-span-name")?.textContent || ""
      );
      expect(topLevelNames.some((n) => n.includes("reasoning"))).toBe(true);
      expect(topLevelNames.some((n) => n === "act" || n.startsWith("act"))).toBe(true);
      // tool 不能直接挂在 turn body 下
      const toolAtTopLevel = topLevelNames.find((n) => n.includes("tool:"));
      expect(toolAtTopLevel).toBeFalsy();
    });

    // 展开 ACT：点击 ACT 的 chevron
    const actSpan = container.querySelector(
      ".trace-tree-turn-body > .trace-tree-span:nth-child(2)"
    ) as HTMLElement;
    fireEvent.click(actSpan.querySelector(".trace-chev") as HTMLElement);

    await waitFor(() => {
      // ACT body 渲染了 tool children（tool span 必须出现在 ACT 内部）
      const actTools = actSpan.querySelector(".trace-tree-act-tools");
      expect(actTools).toBeTruthy();
      const toolsInside = actTools?.querySelectorAll(".trace-tree-span");
      // 2 个 tool 嵌在 ACT 下
      expect(toolsInside?.length).toBe(2);
      const toolNames = Array.from(toolsInside || []).map((t) =>
        t.querySelector(".trace-tree-span-name")?.textContent || ""
      );
      // tool node 的 name 渲染成 "tool:bash· bash"（span.name + tool.name 副名），
      // 所以这里用 includes 而不是 toContain 全等。
      expect(toolNames.some((n) => n.includes("tool:bash"))).toBe(true);
      expect(toolNames.some((n) => n.includes("tool:read_doc"))).toBe(true);
    });
  });
});
