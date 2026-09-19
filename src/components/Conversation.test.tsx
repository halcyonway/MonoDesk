// Conversation 单测：自动锚定到底部行为。
//
// 会话视图挂载时如果已经有 msgs → 自动 scrollTop = scrollHeight - clientHeight
// （再加 140px 留白给 composer），流式响应 msgs 变化 → 同步锚到底。
// 覆盖两个场景：
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

describe("Conversation ToolBlock error body", () => {
  // tool child 助手：构造一个含 tool child 的 assistant msg。
  // ToolBlock 不在 Conversation 测试范围内（之前没覆盖），
  // 但 ToolBlock 渲染依赖 Conversation 的 MsgView → ChildView → ToolBlock 链路，
  // 这里通过 Conversation 组件间接挂载，再 query DOM 验证。
  type AssistantMsg = Extract<Msg, { role: "assistant" }>;
  type ToolChild = Extract<AssistantMsg["children"][number], { kind: "tool" }>;
  function toolMsg(args: {
    name: string;
    state: "running" | "done";
    result?: ToolChild["result"];
    latencyMs?: number;
  }): Msg {
    return {
      id: "a-tool",
      role: "assistant",
      runId: "t_x",
      children: [
        {
          id: "c-tool",
          kind: "tool",
          name: args.name,
          args: "{}",
          state: args.state,
          result: args.result,
          latencyMs: args.latencyMs,
        } as ToolChild,
      ],
    };
  }

  it("ok + exit 0 shows exit line, no stdout / stderr / reason", () => {
    const engine = makeEngine();
    const { container } = render(
      <Conversation
        sessionKey={TEST_SESSION_KEY}
        msgs={[userMsg, toolMsg({ name: "bash", state: "done", result: {
          call_id: "c1", status: "ok", stdout: "", stderr: "",
          exit_code: 0, truncated: false, budget_id: null,
        }, latencyMs: 50 })]}
        engine={engine}
        onSend={() => {}}
        onInspectRun={() => {}}
      />
    );
    expect(container.querySelector(".t-exit")?.textContent).toBe("exit 0");
    expect(container.querySelector("pre")?.textContent ?? "").not.toContain("anything");
    expect(container.querySelector(".t-reason")).toBeFalsy();
    expect(container.querySelector(".t-empty")).toBeFalsy();
  });

  it("ok + stdout shows stdout then exit 0", () => {
    const engine = makeEngine();
    const { container } = render(
      <Conversation
        sessionKey={TEST_SESSION_KEY}
        msgs={[userMsg, toolMsg({ name: "bash", state: "done", result: {
          call_id: "c1", status: "ok", stdout: "hello world", stderr: "",
          exit_code: 0, truncated: false, budget_id: null,
        }, latencyMs: 50 })]}
        engine={engine}
        onSend={() => {}}
        onInspectRun={() => {}}
      />
    );
    expect(container.querySelector("pre")?.textContent).toBe("hello world");
    expect(container.querySelector(".t-exit")?.textContent).toBe("exit 0");
  });

  it("error + stderr shows stderr (red) + exit code, no reason line", () => {
    const engine = makeEngine();
    const { container } = render(
      <Conversation
        sessionKey={TEST_SESSION_KEY}
        msgs={[userMsg, toolMsg({ name: "bash", state: "done", result: {
          call_id: "c1", status: "error", stdout: "", stderr: "command failed",
          exit_code: 1, truncated: false, budget_id: null,
        }, latencyMs: 20 })]}
        engine={engine}
        onSend={() => {}}
        onInspectRun={() => {}}
      />
    );
    const stderr = container.querySelector(".stderr");
    expect(stderr?.textContent).toBe("command failed");
    expect(container.querySelector(".t-exit")?.textContent).toBe("exit 1");
    expect(container.querySelector(".t-reason")).toBeFalsy();
  });

  it("error + empty stderr just shows exit code (silent exit case)", () => {
    // 典型 case：grep 无匹配 → exit_code=1 + stderr 空。不补任何 stderr 提示文字
    // （silent exit 不是 error 含义），只显示 exit_code 让用户自行判断语义。
    const engine = makeEngine();
    const { container } = render(
      <Conversation
        sessionKey={TEST_SESSION_KEY}
        msgs={[userMsg, toolMsg({ name: "bash", state: "done", result: {
          call_id: "c1", status: "error", stdout: "", stderr: "",
          exit_code: 1, truncated: false, budget_id: null,
        }, latencyMs: 20 })]}
        engine={engine}
        onSend={() => {}}
        onInspectRun={() => {}}
      />
    );
    expect(container.querySelector(".t-exit")?.textContent).toBe("exit 1");
    expect(container.querySelector(".stderr")).toBeFalsy();
    expect(container.querySelector(".t-empty")).toBeFalsy();
  });

  it("error + stdout and stderr both present shows both + exit code", () => {
    const engine = makeEngine();
    const { container } = render(
      <Conversation
        sessionKey={TEST_SESSION_KEY}
        msgs={[userMsg, toolMsg({ name: "bash", state: "done", result: {
          call_id: "c1", status: "error", stdout: "partial out", stderr: "err text",
          exit_code: 2, truncated: false, budget_id: null,
        }, latencyMs: 20 })]}
        engine={engine}
        onSend={() => {}}
        onInspectRun={() => {}}
      />
    );
    expect(container.querySelector("pre")?.textContent).toBe("partial out");
    expect(container.querySelector(".stderr")?.textContent).toBe("err text");
    expect(container.querySelector(".t-exit")?.textContent).toBe("exit 2");
  });

  it("timeout shows 'timeout after Xs' reason + stderr + exit 124", () => {
    const engine = makeEngine();
    const { container } = render(
      <Conversation
        sessionKey={TEST_SESSION_KEY}
        msgs={[userMsg, toolMsg({ name: "bash", state: "done", result: {
          call_id: "c1", status: "timeout", stdout: "", stderr: "killed",
          exit_code: 124, truncated: false, budget_id: null,
        }, latencyMs: 30020 })]}
        engine={engine}
        onSend={() => {}}
        onInspectRun={() => {}}
      />
    );
    const reason = container.querySelector(".t-reason");
    expect(reason?.textContent).toMatch(/timeout after \d+\.\d{2}s/);
    expect(reason?.textContent).toContain("30.02");
    expect(container.querySelector(".stderr")?.textContent).toBe("killed");
    expect(container.querySelector(".t-exit")?.textContent).toBe("exit 124");
  });

  it("cancelled shows 'cancelled by user' reason + stdout + exit -1, no stderr", () => {
    // cancelled 不显示 stderr（避免误导用户以为是命令本身错）
    const engine = makeEngine();
    const { container } = render(
      <Conversation
        sessionKey={TEST_SESSION_KEY}
        msgs={[userMsg, toolMsg({ name: "bash", state: "done", result: {
          call_id: "c1", status: "cancelled", stdout: "partial", stderr: "should not show",
          exit_code: -1, truncated: false, budget_id: null,
        }, latencyMs: 50 })]}
        engine={engine}
        onSend={() => {}}
        onInspectRun={() => {}}
      />
    );
    expect(container.querySelector(".t-reason")?.textContent).toBe("cancelled by user");
    expect(container.querySelector("pre")?.textContent).toBe("partial");
    expect(container.querySelector(".stderr")).toBeFalsy();
    expect(container.querySelector(".t-exit")?.textContent).toBe("exit -1");
  });
});