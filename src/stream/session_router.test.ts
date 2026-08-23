// SessionRouter 单测：覆盖用户原话「切换新会话输入框还在 compressing…
// 历史错放到新会话里」这个 bug 类。
//
// 关键性质：所有 setter 写「streamKey 当前指向的 entry」，streamKey 由 App 控制
//（切视图不切 streamKey，只在发消息时切 streamKey）。所以即使 UI 正在看 session B，
// session A 的 agent 还在后台跑时，事件写回 A 的 entry，绝不串到 B。

import { describe, expect, it } from "vitest";
import {
  buildSessionRoutedSetters,
  viewForState,
  type StateMap,
} from "./session_router";

const EMPTY = {
  msgs: [],
  status: "idle",
  metrics: { ttft: null, total: null, tps: null, prompt: null, completion: null },
  steps: [],
  model: "",
};

describe("buildSessionRoutedSetters", () => {
  it("routes setMsgs writes to the streamKey's entry, not the active view", () => {
    // 模拟场景：用户当前看 session B 的视图；session A 的 agent 还在跑，发了 token 进来。
    let map: StateMap = { A: { ...EMPTY, msgs: [] }, B: { ...EMPTY, msgs: [] } };
    const streamKey = { current: "A" }; // 流式属于 A
    const cb = buildSessionRoutedSetters(
      (updater) => (map = updater(map)),
      () => streamKey.current,
      EMPTY
    );
    cb.msgs((prev) => [...prev, { id: "x", role: "user", text: "hi" }]);

    // A 收到了消息；B 完全不变
    expect(map.A.msgs).toHaveLength(1);
    expect(map.B.msgs).toHaveLength(0);
  });

  it("routes status / metrics / steps / model to the streamKey's entry", () => {
    let map: StateMap = { A: { ...EMPTY }, B: { ...EMPTY } };
    const streamKey = { current: "A" };
    const cb = buildSessionRoutedSetters(
      (updater) => (map = updater(map)),
      () => streamKey.current,
      EMPTY
    );

    cb.status("thinking");
    cb.metrics({ ttft: 250, total: null, tps: null, prompt: null, completion: null });
    cb.steps((prev) => [...prev, { idx: 0, latencyMs: 250, tokens: 5, tools: 0 }]);
    cb.model("claude-test");

    expect(map.A.status).toBe("thinking");
    expect(map.A.metrics.ttft).toBe(250);
    expect(map.A.steps).toHaveLength(1);
    expect(map.A.model).toBe("claude-test");

    expect(map.B.status).toBe("idle");
    expect(map.B.metrics.ttft).toBeNull();
    expect(map.B.steps).toHaveLength(0);
    expect(map.B.model).toBe("");
  });

  it("lazy-creates entry when streamKey points to a session not yet in map", () => {
    // 切到新会话 A 后立刻开始 stream，但 App 还没在 map 里建 A 的 entry。
    // setter 应该用 EMPTY default 填上，不报错也不写错 key。
    let map: StateMap = {};
    const streamKey = { current: "A" };
    const cb = buildSessionRoutedSetters(
      (updater) => (map = updater(map)),
      () => streamKey.current,
      EMPTY
    );
    cb.status("compressing");
    expect(map.A.status).toBe("compressing");
    expect(map.A.msgs).toEqual([]);
  });

  it("supports functional updater (passes previous value of that field)", () => {
    let map: StateMap = { A: { ...EMPTY, msgs: [{ id: "1", role: "user", text: "hi" }] } };
    const streamKey = { current: "A" };
    const cb = buildSessionRoutedSetters(
      (updater) => (map = updater(map)),
      () => streamKey.current,
      EMPTY
    );
    cb.msgs((prev) => [...prev, { id: "2", role: "assistant", text: "yo" } as any]);
    expect(map.A.msgs).toHaveLength(2);
  });

  it("does not leak fields across sessions when streamKey switches mid-stream", () => {
    // 场景：用户先在 A 发消息，streamKey=A；切到 B 看 A 的流；中途 streamKey
    // 不变（agent 还在 A 上跑）；但如果误把 streamKey 切到 B，setter 应改写到 B。
    let map: StateMap = { A: { ...EMPTY, msgs: [] }, B: { ...EMPTY, msgs: [] } };
    const streamKey = { current: "A" };
    const cb = buildSessionRoutedSetters(
      (updater) => (map = updater(map)),
      () => streamKey.current,
      EMPTY
    );

    cb.msgs([{ id: "1", role: "user", text: "from-A" } as any]);
    expect(map.A.msgs).toHaveLength(1);

    // 现在 streamKey 指向 B（模拟 bug：路由切错）
    streamKey.current = "B";
    cb.status("thinking");
    expect(map.B.status).toBe("thinking");
    // A 的 status 不被覆盖（也不应被清掉 —— 它的流已经跑过了）
    expect(map.A.status).toBe("idle");
  });

  it("functional updater sees each session's own previous value, not another session's", () => {
    // session A 有 1 条消息；session B 有 5 条。setMsgs(prev => [...prev, ...])
    // 在不同 streamKey 下应该读到不同的 prev。
    let map: StateMap = {
      A: { ...EMPTY, msgs: [{ id: "1" } as any] },
      B: { ...EMPTY, msgs: [{ id: "1" } as any, { id: "2" } as any, { id: "3" } as any, { id: "4" } as any, { id: "5" } as any] },
    };
    const streamKey = { current: "A" };
    const cb = buildSessionRoutedSetters(
      (updater) => (map = updater(map)),
      () => streamKey.current,
      EMPTY
    );
    cb.msgs((prev) => [...prev, { id: "next" } as any]);
    expect(map.A.msgs).toHaveLength(2); // 1 → 2

    streamKey.current = "B";
    cb.msgs((prev) => [...prev, { id: "next" } as any]);
    expect(map.B.msgs).toHaveLength(6); // 5 → 6
    // A 没被动过
    expect(map.A.msgs).toHaveLength(2);
  });
});

describe("viewForState", () => {
  it("returns the active session's entry when present", () => {
    const map: StateMap = {
      A: { ...EMPTY, status: "thinking", msgs: [] },
      B: { ...EMPTY, status: "idle", msgs: [] },
    };
    const v = viewForState(map, "A", EMPTY);
    expect(v.status).toBe("thinking");
  });

  it("returns empty default when active session has no entry (e.g. brand-new session)", () => {
    // 用户原话 bug 类：「切到新会话，输入框还在 compressing… 历史串到新会话」。
    // 这个不变量保证：active key 不在 map 时，绝对拿不到「上一个会话」的数据。
    const map: StateMap = {
      A: { ...EMPTY, status: "compressing", msgs: [{ id: "1" } as any], model: "M1" },
      // B 没有 entry —— 用户刚切过去
    };
    const v = viewForState(map, "B", EMPTY);
    expect(v.status).toBe("idle");
    expect(v.msgs).toEqual([]);
    expect(v.model).toBe("");
  });

  it("returns the same entry reference on repeated calls (cheap derive)", () => {
    // viewForState 是纯 derive —— 不需要每次都 spread 出新对象。
    // App.tsx 已经保证：当 entry 内容真的变了，setSessionStates 写入的是 NEW 对象
    // （{...cur, [field]: next}），所以 view 的「引用变化」=「内容变化」，
    // 不需要 derive 层再加一层浅拷贝。
    const map: StateMap = { A: { ...EMPTY, status: "thinking" } };
    const v1 = viewForState(map, "A", EMPTY);
    const v2 = viewForState(map, "A", EMPTY);
    expect(v1).toBe(v2); // 引用稳定
    expect(v1.status).toBe("thinking");
  });
});