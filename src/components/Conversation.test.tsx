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
    toolArgs?: string;
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
          args: args.toolArgs ?? "{}",
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

  it("skill_load tool head shows loaded skill name (Image 62)", () => {
    // Image 62 反馈：SKILL_LOAD 之前只显示名字本身，看不出加载了哪个 skill。
    // 修法：head 里展示 args.name（≤30 字截断），跟 bash target 同位。
    const engine = makeEngine();
    const msg = toolMsg({
      name: "skill_load",
      state: "done",
      toolArgs: '{"name":"mono_search"}',
      result: {
        call_id: "c1",
        status: "ok",
        stdout: "ok",
        stderr: "",
        exit_code: 0,
      },
      latencyMs: 12,
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
    // summary 必须包含 skill 名字（共用 .t-summary class，跟 bash target 视觉一致）
    const summary = container.querySelector(".t-summary");
    expect(summary).toBeTruthy();
    expect(summary?.textContent).toBe("mono_search");
    // tool block 的 label 应该含 skill_load
    const labels = Array.from(container.querySelectorAll(".label")).map((el) => el.textContent);
    expect(labels.some((l) => l?.includes("skill_load"))).toBe(true);
  });

  it("skill_load tool with no name arg does NOT show summary", () => {
    const engine = makeEngine();
    const msg = toolMsg({
      name: "skill_load",
      state: "done",
      toolArgs: "{}",
      result: {
        call_id: "c1",
        status: "ok",
        stdout: "ok",
        stderr: "",
        exit_code: 0,
      },
      latencyMs: 5,
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
    expect(container.querySelector(".t-summary")).toBeNull();
  });

  it("skill_load tool with very long name truncates to 30 chars + …", () => {
    const longName = "a".repeat(60);
    const engine = makeEngine();
    const msg = toolMsg({
      name: "skill_load",
      state: "done",
      toolArgs: `{"name":"${longName}"}`,
      result: {
        call_id: "c1",
        status: "ok",
        stdout: "ok",
        stderr: "",
        exit_code: 0,
      },
      latencyMs: 3,
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
    const summary = container.querySelector(".t-summary");
    expect(summary?.textContent?.length).toBeLessThanOrEqual(31);
    expect(summary?.textContent?.endsWith("…")).toBe(true);
  });
});

describe("Conversation evidence chain ref chip + popover", () => {
  // 协议见 spec/requirements/evidence-chain.md。freeze 阶段 text 字段
  // 已经 frozen → TextStream 走 dangerouslySetInnerHTML 静态渲染；
  // 渲染结果里 ref token 已被替换成 .ref-chip + .ref-popover HTML。
  function assistantWithText(text: string): Msg {
    return {
      id: "a-ref",
      role: "assistant",
      children: [{ id: "c-ref", kind: "text", text }],
    };
  }

  it("renders ref chip + popover when assistant text contains [[ref]] token", () => {
    const engine = makeEngine();
    const text = `观点 [1] 引用了某来源 [[ref type=link url="https://x.com" title="T" desc="一句话摘要"]]`;
    const { container } = render(
      <Conversation
        sessionKey={TEST_SESSION_KEY}
        msgs={[userMsg, assistantWithText(text)]}
        engine={engine}
        onSend={() => {}}
        onInspectRun={() => {}}
      />
    );
    const chip = container.querySelector(".ref-chip");
    expect(chip).toBeTruthy();
    // v5.1: data-ref-id 由 seq 分配（单 ref = 1）
    expect(chip?.getAttribute("data-ref-id")).toBe("1");
    expect(chip?.getAttribute("data-ref-type")).toBe("link");
    const popover = container.querySelector(".ref-popover");
    expect(popover).toBeTruthy();
    // 初始不可见：没有 .visible 类
    expect(popover?.classList.contains("visible")).toBe(false);
    // raw token 已经被替换走
    expect(container.textContent).not.toContain("[[ref");
    // v5.1: chip 含完整 title + emoji icon（shortLabel = a.title = "T"）
    expect(chip?.textContent).toContain("T");
    expect(chip?.textContent).toContain("🔗");
    // v5.1 popover: type 行 + content section（desc 字段）
    const typeBadge = popover?.querySelector(".ref-type-badge");
    expect(typeBadge).toBeTruthy();
    expect(typeBadge?.textContent).toContain("link");
    expect(typeBadge?.textContent).toContain("🔗");
    expect(popover?.textContent).toContain("一句话摘要");
    // URL 不再渲染在 popover（v5.1 删了，走 <a> native 跳转）
    expect(popover?.textContent).not.toContain("https://x.com");
    expect(popover?.querySelector(".ref-url-display")).toBeNull();
    expect(popover?.querySelector(".ref-pop-favicon")).toBeNull();
  });

  it("popover 初始 display 来自 CSS（默认 hidden，JS hover 才会 .visible）", () => {
    // 不直接读 computed style（jsdom 对 absolute 定位不真实计算），
    // 而是断言 popover 的 .visible 类**不在**初始 class list 里。
    const engine = makeEngine();
    const text = `观点 [[ref type=memory key="k" snippet="s"]]`;
    const { container } = render(
      <Conversation
        sessionKey={TEST_SESSION_KEY}
        msgs={[userMsg, assistantWithText(text)]}
        engine={engine}
        onSend={() => {}}
        onInspectRun={() => {}}
      />
    );
    const popover = container.querySelector(".ref-popover");
    expect(popover?.classList.contains("visible")).toBe(false);
  });

  it("mouseenter on chip toggles popover visible (delegation on #conversation-wrap)", () => {
    // 监听挂在 #conversation-wrap 上（不是 document 全局），
    // 用 fireEvent 在 chip 元素上派 mouseenter → capture phase 触发监听。
    const engine = makeEngine();
    const text = `观点 [[ref type=link url="https://x.com" title="T"]]`;
    const { container } = render(
      <Conversation
        sessionKey={TEST_SESSION_KEY}
        msgs={[userMsg, assistantWithText(text)]}
        engine={engine}
        onSend={() => {}}
        onInspectRun={() => {}}
      />
    );
    const chip = container.querySelector(".ref-chip") as HTMLElement;
    fireEvent.mouseEnter(chip);
    const popover = container.querySelector(".ref-popover");
    expect(popover?.classList.contains("visible")).toBe(true);
  });

  it("mouseleave on chip hides popover (removes .visible)", () => {
    const engine = makeEngine();
    const text = `观点 [[ref type=link url="https://x.com" title="T"]]`;
    const { container } = render(
      <Conversation
        sessionKey={TEST_SESSION_KEY}
        msgs={[userMsg, assistantWithText(text)]}
        engine={engine}
        onSend={() => {}}
        onInspectRun={() => {}}
      />
    );
    const chip = container.querySelector(".ref-chip") as HTMLElement;
    fireEvent.mouseEnter(chip);
    expect(container.querySelector(".ref-popover")?.classList.contains("visible")).toBe(true);
    fireEvent.mouseLeave(chip);
    expect(container.querySelector(".ref-popover")?.classList.contains("visible")).toBe(false);
  });

  it("click on non-link chip toggles popover (mobile / tap)", () => {
    // link type chip 是 <a>，click 走 JS 主动 open（不再 toggle popover）；
    // 移动端 click toggle 只对非 link type 有意义。
    const engine = makeEngine();
    const text = `观点 [[ref type=memory key="k" snippet="s"]]`;
    const { container } = render(
      <Conversation
        sessionKey={TEST_SESSION_KEY}
        msgs={[userMsg, assistantWithText(text)]}
        engine={engine}
        onSend={() => {}}
        onInspectRun={() => {}}
      />
    );
    const chip = container.querySelector(".ref-chip") as HTMLElement;
    fireEvent.click(chip);
    expect(container.querySelector(".ref-popover")?.classList.contains("visible")).toBe(true);
    fireEvent.click(chip);
    expect(container.querySelector(".ref-popover")?.classList.contains("visible")).toBe(false);
  });

  it("click on link chip hides popover + triggers navigation (does NOT toggle)", () => {
    // v5.1: link chip click → JS 主动 open (browser: window.open, Tauri:
    // plugin-shell open) + hide popover。不是 toggle，避免 tap → 弹窗+跳转
    // 双重动作。
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    const engine = makeEngine();
    const text = `观点 [[ref type=link url="https://x.com" title="T"]]`;
    const { container } = render(
      <Conversation
        sessionKey={TEST_SESSION_KEY}
        msgs={[userMsg, assistantWithText(text)]}
        engine={engine}
        onSend={() => {}}
        onInspectRun={() => {}}
      />
    );
    const chip = container.querySelector(".ref-chip") as HTMLElement;
    expect(chip.tagName.toLowerCase()).toBe("a");
    // 先 hover 让 popover visible，然后 click → 应该被 hide（不是 toggle）
    fireEvent.mouseEnter(chip);
    expect(container.querySelector(".ref-popover")?.classList.contains("visible")).toBe(true);
    fireEvent.click(chip);
    // 主动 open (browser mode 是 window.open)
    expect(openSpy).toHaveBeenCalled();
    // 不应 toggle popover：click 后立即 hide
    expect(container.querySelector(".ref-popover")?.classList.contains("visible")).toBe(false);
    openSpy.mockRestore();
  });

  it("click on link chip calls window.open with href + _blank + noopener (browser mode)", () => {
    // jsdom 不存在 __TAURI_INTERNALS__ → 走 browser 分支
    // Image 59 反馈：点 chip 后浏览器选中 chip 文字造成「选中态」。
    // 修法：click handler preventDefault + 主动 window.open，避免 <a> 默认
    // 行为选中态 + 异步开窗的视觉错位。
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    const engine = makeEngine();
    const text = `观点 [[ref type=link url="https://x.com/x" title="T"]]`;
    const { container } = render(
      <Conversation
        sessionKey={TEST_SESSION_KEY}
        msgs={[userMsg, assistantWithText(text)]}
        engine={engine}
        onSend={() => {}}
        onInspectRun={() => {}}
      />
    );
    const chip = container.querySelector(".ref-chip") as HTMLElement;
    fireEvent.click(chip);
    expect(openSpy).toHaveBeenCalled();
    const call = openSpy.mock.calls[0];
    expect(call[0]).toBe("https://x.com/x");
    expect(call[1]).toBe("_blank");
    expect(call[2]).toContain("noopener");
    openSpy.mockRestore();
  });

  it("unmount removes popover state (cleanup)", () => {
    // ensure no leaked listeners across mount/unmount — verify by remount and hover.
    const engine = makeEngine();
    const text = `观点 [[ref type=link url="https://x.com" title="T"]]`;
    const first = render(
      <Conversation
        sessionKey={TEST_SESSION_KEY}
        msgs={[userMsg, assistantWithText(text)]}
        engine={engine}
        onSend={() => {}}
        onInspectRun={() => {}}
      />
    );
    first.unmount();
    const second = render(
      <Conversation
        sessionKey={TEST_SESSION_KEY}
        msgs={[userMsg, assistantWithText(text)]}
        engine={engine}
        onSend={() => {}}
        onInspectRun={() => {}}
      />
    );
    const chip = second.container.querySelector(".ref-chip") as HTMLElement;
    fireEvent.mouseEnter(chip);
    expect(second.container.querySelector(".ref-popover")?.classList.contains("visible")).toBe(true);
  });

  it("multiple refs in same msg render multiple chip/popover pairs", () => {
    const engine = makeEngine();
    const text =
      `A [[ref type=link url="https://a" title="A"]] B [[ref type=memory key="k" snippet="s"]]`;
    const { container } = render(
      <Conversation
        sessionKey={TEST_SESSION_KEY}
        msgs={[userMsg, assistantWithText(text)]}
        engine={engine}
        onSend={() => {}}
        onInspectRun={() => {}}
      />
    );
    expect(container.querySelectorAll(".ref-chip").length).toBe(2);
    expect(container.querySelectorAll(".ref-popover").length).toBe(2);
  });
});