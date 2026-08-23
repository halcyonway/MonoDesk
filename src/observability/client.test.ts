// TraceClient 单测：cache / invalidate / fetch 错误路径。
import { afterEach, describe, expect, it, vi } from "vitest";
import { TraceClient } from "./client";
import type { TraceRun, TraceRunSummary } from "../ws/protocol";

const SAMPLE_RUN: TraceRun = {
  run_id: "t_abc",
  session_key: "default",
  user_text: "hi",
  final_text: "hello back",
  start_ts: 1.0,
  end_ts: 1.5,
  status: "ok",
  turns: [],
};

const SAMPLE_SUMMARY: TraceRunSummary = {
  run_id: "t_abc",
  session_key: "default",
  user_text: "hi",
  start_ts: 1.0,
  end_ts: 1.5,
  status: "ok",
  turn_count: 1,
};

// 给 fetchMock 一个明确签名，让 mock.calls[0][0] 类型是 string 而不是 never。
type FetchMock = ReturnType<typeof vi.fn<(input: string) => Promise<Response>>>;

function makeFetchMock(impl: (input: string) => Promise<Response>): FetchMock {
  return vi.fn<(input: string) => Promise<Response>>(impl);
}

function urlOf(mock: FetchMock, callIdx: number): string {
  return mock.mock.calls[callIdx]![0] as string;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("TraceClient.getRun", () => {
  it("fetches and returns the run", async () => {
    const fetchMock = makeFetchMock(async () =>
      new Response(JSON.stringify(SAMPLE_RUN), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const c = new TraceClient("http://127.0.0.1:8768");
    const r = await c.getRun("default", "t_abc");

    expect(r).toEqual(SAMPLE_RUN);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = urlOf(fetchMock, 0);
    expect(url).toContain("/debug/runs/t_abc");
    expect(url).toContain("session_key=default");
  });

  it("caches by sessionKey:runId and skips second fetch", async () => {
    const fetchMock = makeFetchMock(async () =>
      new Response(JSON.stringify(SAMPLE_RUN), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const c = new TraceClient("http://127.0.0.1:8768");
    const a = await c.getRun("default", "t_abc");
    const b = await c.getRun("default", "t_abc");

    expect(a).toBe(b); // 同一引用 = 命中 cache
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("different sessions do not share cache", async () => {
    const fetchMock = makeFetchMock(async () =>
      new Response(JSON.stringify(SAMPLE_RUN), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const c = new TraceClient("http://127.0.0.1:8768");
    await c.getRun("alpha", "t_abc");
    await c.getRun("beta", "t_abc");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(urlOf(fetchMock, 0)).toContain("session_key=alpha");
    expect(urlOf(fetchMock, 1)).toContain("session_key=beta");
  });

  it("invalidate() evicts cache for a session only", async () => {
    const fetchMock = makeFetchMock(async () =>
      new Response(JSON.stringify(SAMPLE_RUN), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const c = new TraceClient("http://127.0.0.1:8768");
    await c.getRun("alpha", "t_abc");
    await c.getRun("beta", "t_abc");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    c.invalidate("alpha");
    await c.getRun("alpha", "t_abc");
    await c.getRun("beta", "t_abc");
    expect(fetchMock).toHaveBeenCalledTimes(3); // alpha 重新拉，beta 命中 cache

    expect(urlOf(fetchMock, 2)).toContain("session_key=alpha");
  });

  it("URL-encodes run_id with special characters", async () => {
    const fetchMock = makeFetchMock(async () =>
      new Response(JSON.stringify(SAMPLE_RUN), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const c = new TraceClient("http://127.0.0.1:8768");
    await c.getRun("default", "t/a b");

    const url = urlOf(fetchMock, 0);
    expect(url).toContain("/debug/runs/t%2Fa%20b");
  });

  it("throws with status + body on non-ok response", async () => {
    const fetchMock = makeFetchMock(async () =>
      new Response("not found body", { status: 404, statusText: "Not Found" })
    );
    vi.stubGlobal("fetch", fetchMock);

    const c = new TraceClient("http://127.0.0.1:8768");
    await expect(c.getRun("default", "t_abc")).rejects.toThrow(
      /trace fetch 404/
    );
  });

  it("error response does not pollute cache (retry can succeed)", async () => {
    let n = 0;
    const fetchMock = makeFetchMock(async () => {
      n++;
      if (n === 1) return new Response("boom", { status: 500 });
      return new Response(JSON.stringify(SAMPLE_RUN), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const c = new TraceClient("http://127.0.0.1:8768");
    await expect(c.getRun("default", "t_abc")).rejects.toThrow();
    const r = await c.getRun("default", "t_abc"); // 重试
    expect(r).toEqual(SAMPLE_RUN);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("TraceClient.getRecent", () => {
  it("fetches summaries and returns runs array", async () => {
    const fetchMock = makeFetchMock(async () =>
      new Response(JSON.stringify({ runs: [SAMPLE_SUMMARY] }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const c = new TraceClient("http://127.0.0.1:8768");
    const runs = await c.getRecent("default", 10);

    expect(runs).toEqual([SAMPLE_SUMMARY]);
    const url = urlOf(fetchMock, 0);
    expect(url).toContain("/debug/runs/recent");
    expect(url).toContain("limit=10");
  });

  it("caches recent by sessionKey", async () => {
    const fetchMock = makeFetchMock(async () =>
      new Response(JSON.stringify({ runs: [] }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const c = new TraceClient("http://127.0.0.1:8768");
    await c.getRecent("default");
    await c.getRecent("default");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("invalidate() also clears recent cache", async () => {
    const fetchMock = makeFetchMock(async () =>
      new Response(JSON.stringify({ runs: [] }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const c = new TraceClient("http://127.0.0.1:8768");
    await c.getRecent("default");
    c.invalidate("default");
    await c.getRecent("default");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("TraceClient URL handling", () => {
  it("strips trailing slash from base URL", async () => {
    const fetchMock = makeFetchMock(async () =>
      new Response(JSON.stringify(SAMPLE_RUN), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const c = new TraceClient("http://127.0.0.1:8768/");
    await c.getRun("default", "t_abc");
    const url = urlOf(fetchMock, 0);
    expect(url.startsWith("http://127.0.0.1:8768/debug/")).toBe(true);
    expect(url.startsWith("http://127.0.0.1:8768//")).toBe(false);
  });
});