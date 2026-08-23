// TraceDrawer 单测：loading → loaded / error / close / retry。
//
// 用 @testing-library/react render 真实组件，注入 fake TraceClient。
// 不直接验 querySelector 字符串，而是验可观察的语义（drawer 关闭时的 aria-hidden、
// retry 按钮存在、retry 后成功显示 run 内容等）。

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";
import { TraceDrawer } from "./TraceDrawer";
import type { TraceClient } from "../observability/client";
import type { TraceRun } from "../ws/protocol";

const SAMPLE_RUN: TraceRun = {
  run_id: "t_abc123def456",
  session_key: "default",
  user_text: "hi",
  final_text: "hello back",
  start_ts: 1_700_000_000,
  end_ts: 1_700_000_001,
  status: "ok",
  turns: [
    {
      turn_id: "u_xyz",
      turn_idx: 0,
      spans: [
        {
          span_id: "s_r1",
          parent_id: null,
          kind: "reasoning",
          name: "reasoning",
          start_ts: 1.0,
          end_ts: 1.4,
          status: "ok",
          attributes: {
            model: "test-model",
            latency_ms: 412,
            usage: { prompt_tokens: 10, completion_tokens: 4 },
            messages: [
              { role: "system", content: "you are a helper" },
              { role: "user", content: "hi" },
            ],
            response_text: "hello back",
            finish_reason: "stop",
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

    // 加载完成后 skeleton 消失，run 内容出现
    await waitFor(() => {
      expect(container.querySelector(".trace-tree")).toBeTruthy();
      expect(container.querySelector(".trace-skel")).toBeFalsy();
    });

    // Run header 显示 run_id 短码 + user_text
    expect(container.textContent).toContain("hi");
    // Turn / Span 节点
    expect(container.querySelector(".trace-turn")).toBeTruthy();
    expect(container.querySelector(".trace-node")).toBeTruthy();
    // Reasoning 节点默认展开 → messages 美化出现
    expect(container.querySelector(".trace-messages")).toBeTruthy();
    expect(container.querySelector(".trace-msg")).toBeTruthy();
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
    // 第一次失败
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
      expect(container.querySelector(".trace-tree")).toBeTruthy();
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

    // 第一个 fetch 挂起
    expect((fake as unknown as FakeClient).getRun).toHaveBeenCalledWith("default", "t_first");

    // 切换到另一个 runId：上一个 fetch 应该被 abort（cancelled），下一个开始
    rerender(
      <TraceDrawer runId="t_second" sessionKey="default" client={fake} onClose={onClose} />
    );
    expect((fake as unknown as FakeClient).getRun).toHaveBeenCalledWith("default", "t_second");

    // 让第一个 resolve 也不应该污染 state
    resolvers[0]?.(SAMPLE_RUN);
    await waitFor(() => {
      expect(container.querySelector(".trace-skel")).toBeTruthy();
    });

    // 让第二个 resolve
    resolvers[1]?.(SAMPLE_RUN);
    await waitFor(() => {
      expect(container.querySelector(".trace-tree")).toBeTruthy();
    });
  });

  it("renders 'no turns' empty state for an empty run", async () => {
    const fake = new FakeClient() as unknown as TraceClient;
    (fake as unknown as FakeClient).getRun = vi.fn(async () => ({
      ...SAMPLE_RUN,
      turns: [],
    }));
    const { container } = render(
      <TraceDrawer runId="t_empty" sessionKey="default" client={fake} onClose={vi.fn()} />
    );

    await waitFor(() => {
      expect(container.querySelector(".trace-empty")).toBeTruthy();
    });
  });

  it("shows per-call cached_tokens + run-level avg cache hit ratio", async () => {
    const fake = new FakeClient() as unknown as TraceClient;
    (fake as unknown as FakeClient).getRun = vi.fn(async () => ({
      ...SAMPLE_RUN,
      turns: [
        {
          turn_id: "u_a",
          turn_idx: 0,
          spans: [
            {
              span_id: "s_a1",
              parent_id: null,
              kind: "reasoning",
              name: "reasoning",
              start_ts: 1.0,
              end_ts: 1.1,
              status: "ok",
              attributes: {
                model: "m",
                latency_ms: 100,
                usage: { prompt_tokens: 1000, completion_tokens: 50, cached_tokens: 800 },
              },
            },
          ],
        },
        {
          turn_id: "u_b",
          turn_idx: 1,
          spans: [
            {
              span_id: "s_b1",
              parent_id: null,
              kind: "reasoning",
              name: "reasoning",
              start_ts: 2.0,
              end_ts: 2.1,
              status: "ok",
              attributes: {
                model: "m",
                latency_ms: 100,
                usage: { prompt_tokens: 1000, completion_tokens: 50, cached_tokens: 600 },
              },
            },
          ],
        },
      ],
    }));
    const { container } = render(
      <TraceDrawer runId="t_cache" sessionKey="default" client={fake} onClose={vi.fn()} />
    );

    await waitFor(() => {
      expect(container.querySelector(".trace-run-cache-pill")).toBeTruthy();
    });

    // 每 turn / span 的 cache
    const turnCaches = container.querySelectorAll(".trace-turn-cache");
    expect(turnCaches.length).toBe(2);
    // 第一个 turn: 800/1000 = 80.0%
    expect(turnCaches[0].textContent).toContain("80.0%");
    // 第二个 turn: 600/1000 = 60.0%
    expect(turnCaches[1].textContent).toContain("60.0%");

    // span-level 也显示
    const nodeCaches = container.querySelectorAll(".trace-node-cache");
    expect(nodeCaches.length).toBe(2);

    // run-level avg = (0.8 + 0.6) / 2 = 70.0%
    const runCache = container.querySelector(".trace-run-cache-pill");
    expect(runCache?.textContent).toContain("70.0%");
  });

  it("does not show cache UI when usage has no cached_tokens", async () => {
    const fake = new FakeClient() as unknown as TraceClient;
    (fake as unknown as FakeClient).getRun = vi.fn(async () => ({
      ...SAMPLE_RUN,
      // SAMPLE_RUN 的 span usage 是 {}，没有 prompt_tokens / cached_tokens
    }));
    const { container } = render(
      <TraceDrawer runId="t_no_cache" sessionKey="default" client={fake} onClose={vi.fn()} />
    );

    await waitFor(() => {
      expect(container.querySelector(".trace-tree")).toBeTruthy();
    });

    expect(container.querySelector(".trace-run-cache")).toBeFalsy();
    expect(container.querySelector(".trace-turn-cache")).toBeFalsy();
    expect(container.querySelector(".trace-node-cache")).toBeFalsy();
  });

  it("aggregates total tokens across all reasoning spans in run header", async () => {
    const fake = new FakeClient() as unknown as TraceClient;
    (fake as unknown as FakeClient).getRun = vi.fn(async () => ({
      ...SAMPLE_RUN,
      turns: [
        {
          turn_id: "u_a", turn_idx: 0,
          spans: [{
            span_id: "s_a1", parent_id: null, kind: "reasoning",
            name: "r", start_ts: 1, end_ts: 1.1, status: "ok",
            attributes: { usage: { prompt_tokens: 1000, completion_tokens: 50, cached_tokens: 800 } },
          }],
        },
        {
          turn_id: "u_b", turn_idx: 1,
          spans: [{
            span_id: "s_b1", parent_id: null, kind: "reasoning",
            name: "r", start_ts: 2, end_ts: 2.1, status: "ok",
            attributes: { usage: { prompt_tokens: 500, completion_tokens: 30 } }, // 没有 cached
          }],
        },
      ],
    }));
    const { container } = render(
      <TraceDrawer runId="t_total" sessionKey="default" client={fake} onClose={vi.fn()} />
    );

    await waitFor(() => {
      expect(container.querySelector(".trace-run-totals")).toBeTruthy();
    });
    const totals = container.querySelector(".trace-run-totals");
    expect(totals?.textContent).toContain("1,500"); // 1000 + 500 prompt
    expect(totals?.textContent).toContain("80");    // 50 + 30 completion
    expect(totals?.textContent).toContain("800");   // cached 只有 turn A 有
  });

  it("collapses long message lists (>5) by default", async () => {
    const fake = new FakeClient() as unknown as TraceClient;
    const messages = Array.from({ length: 8 }, (_, i) => ({
      role: i % 2 ? "user" : "assistant",
      content: `msg ${i}`,
    }));
    (fake as unknown as FakeClient).getRun = vi.fn(async () => ({
      ...SAMPLE_RUN,
      turns: [{
        turn_id: "u_x", turn_idx: 0,
        spans: [{
          span_id: "s_x1", parent_id: null, kind: "reasoning",
          name: "r", start_ts: 1, end_ts: 1.1, status: "ok",
          attributes: { messages },
        }],
      }],
    }));
    const { container } = render(
      <TraceDrawer runId="t_long" sessionKey="default" client={fake} onClose={vi.fn()} />
    );

    await waitFor(() => {
      expect(container.querySelector(".trace-tree")).toBeTruthy();
    });

    // 默认只显示前 5 条 + show all 按钮
    let msgCount = container.querySelectorAll(".trace-msg").length;
    expect(msgCount).toBe(5);
    const showAll = Array.from(container.querySelectorAll(".trace-more")).find(
      (b) => b.textContent?.includes("show all")
    );
    expect(showAll).toBeTruthy();

    // 点开后全部 8 条 + show less
    fireEvent.click(showAll!);
    msgCount = container.querySelectorAll(".trace-msg").length;
    expect(msgCount).toBe(8);
  });

  it("uses run-local turn numbering (#1, #2, ...) ignoring turn_idx", async () => {
    // 模拟重启 MonoX 后从 checkpoint 恢复的 run：turn_idx 不从 0 开始，
    // 但 UI 必须从 #1 开始（run-local 语义）。
    const fake = new FakeClient() as unknown as TraceClient;
    (fake as unknown as FakeClient).getRun = vi.fn(async () => ({
      ...SAMPLE_RUN,
      turns: [
        {
          turn_id: "u_a",
          turn_idx: 7, // 故意非零 / 非 1，证明 UI 不直接显示
          spans: [
            {
              span_id: "s_a1",
              parent_id: null,
              kind: "reasoning",
              name: "reasoning",
              start_ts: 1.0,
              end_ts: 1.1,
              status: "ok",
              attributes: { model: "m", latency_ms: 100, usage: {} },
            },
          ],
        },
        {
          turn_id: "u_b",
          turn_idx: 8,
          spans: [
            {
              span_id: "s_b1",
              parent_id: null,
              kind: "reasoning",
              name: "reasoning",
              start_ts: 2.0,
              end_ts: 2.1,
              status: "ok",
              attributes: { model: "m", latency_ms: 100, usage: {} },
            },
          ],
        },
        {
          turn_id: "u_c",
          turn_idx: 9,
          spans: [
            {
              span_id: "s_c1",
              parent_id: null,
              kind: "reasoning",
              name: "reasoning",
              start_ts: 3.0,
              end_ts: 3.1,
              status: "ok",
              attributes: { model: "m", latency_ms: 100, usage: {} },
            },
          ],
        },
      ],
    }));
    const { container } = render(
      <TraceDrawer runId="t_multi" sessionKey="default" client={fake} onClose={vi.fn()} />
    );

    await waitFor(() => {
      expect(container.querySelectorAll(".trace-turn")).toHaveLength(3);
    });

    const labels = Array.from(container.querySelectorAll(".trace-turn-label")).map(
      (n) => n.textContent
    );
    // run-local 编号，必须从 #1 开始；不能显示 turn_idx (7/8/9)
    expect(labels).toEqual(["Turn #1", "Turn #2", "Turn #3"]);
  });

  it("hides token counts when reasoning span usage is empty {} (legacy trace)", () => {
    // 旧 trace 数据（fix include_usage 之前抓的）：usage 是空 dict `{}`。
    // 不应该显示 "0→0 tok" / "tokens 0 → 0" 噪声。
    const run: TraceRun = {
      ...SAMPLE_RUN,
      turns: [
        {
          turn_id: "u_legacy",
          turn_idx: 0,
          spans: [
            {
              span_id: "s_legacy",
              parent_id: null,
              kind: "reasoning",
              name: "reasoning:MiniMax-M2.7",
              start_ts: 1.0,
              end_ts: 1.4,
              status: "ok",
              attributes: {
                model: "MiniMax-M2.7",
                latency_ms: 412,
                usage: {}, // ← 空：LLM 没报 usage
                messages: [],
                response_text: "",
              },
            },
          ],
        },
      ],
    };
    const fake = new FakeClient() as unknown as TraceClient;
    (fake as unknown as FakeClient).getRun = vi.fn(async () => run);
    const { container } = render(
      <TraceDrawer runId="t_legacy" sessionKey="default" client={fake} onClose={() => {}} />
    );

    // 等加载完成
    return waitFor(() => {
      // SpanNode / TurnNode 头部不应显示 token 计数（之前 bug：显示 "0→0 tok"）
      expect(container.querySelector(".trace-node-tokens")).toBeFalsy();
      expect(container.querySelector(".trace-turn-tokens")).toBeFalsy();
      // RunHeader 的 aggregate tokens 也应隐藏（之前 bug：显示 "tokens 0 → 0"）
      expect(container.querySelector(".trace-run-totals")).toBeFalsy();
    });
  });

  it("shows token counts when usage is populated", () => {
    const fake = new FakeClient() as unknown as TraceClient;
    (fake as unknown as FakeClient).getRun = vi.fn(async () => SAMPLE_RUN); // usage {prompt:10, completion:4}
    const { container } = render(
      <TraceDrawer runId="t_abc" sessionKey="default" client={fake} onClose={() => {}} />
    );

    return waitFor(() => {
      expect(container.querySelector(".trace-node-tokens")?.textContent).toContain("10→4 tok");
      expect(container.querySelector(".trace-run-totals")?.textContent).toContain("10");
    });
  });
});