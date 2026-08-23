// SkillsClient 单测 — 5 方法 + cache + 错误处理。
// 模板仿 src/observability/client.test.ts：vi.stubGlobal("fetch") + fake response。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SkillsClient } from "./client";
import type { SkillFull, SkillMeta } from "./types";

const BASE = "http://127.0.0.1:8768";

function _ok(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
}

function _err(status: number, errorMsg: string): Response {
  return new Response(JSON.stringify({ error: errorMsg }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("SkillsClient.list", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches and caches list", async () => {
    const skills: SkillMeta[] = [
      { name: "foo", description: "Foo", tier: 1, path: "/x/foo" },
      { name: "bar", description: "Bar", tier: 2, path: "/x/bar" },
    ];
    fetchMock.mockResolvedValueOnce(_ok({ skills }));
    const c = new SkillsClient(BASE);
    const a = await c.list();
    expect(a).toEqual(skills);
    // 第二次 call 走 cache（不发请求）
    const b = await c.list();
    expect(b).toEqual(skills);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("invalidates cache after invalidate()", async () => {
    const skills: SkillMeta[] = [];
    fetchMock.mockImplementation(() => Promise.resolve(_ok({ skills })));
    const c = new SkillsClient(BASE);
    await c.list();
    c.invalidate();
    await c.list();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws on 4xx with server error message", async () => {
    fetchMock.mockResolvedValueOnce(_err(500, "boom"));
    const c = new SkillsClient(BASE);
    await expect(c.list()).rejects.toThrow(/boom/);
  });
});

describe("SkillsClient.get", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("returns full skill with body", async () => {
    const full: SkillFull = {
      name: "foo",
      description: "Foo",
      tier: 1,
      path: "/x/foo",
      body: "# Foo\n\nbody\n",
    };
    fetchMock.mockResolvedValueOnce(_ok(full));
    const c = new SkillsClient(BASE);
    const got = await c.get("foo");
    expect(got).toEqual(full);
    expect(fetchMock).toHaveBeenCalledWith(
      `${BASE}/debug/skills/${encodeURIComponent("foo")}`,
    );
  });

  it("404 throws with not found message", async () => {
    fetchMock.mockResolvedValueOnce(_err(404, "skill not found"));
    const c = new SkillsClient(BASE);
    await expect(c.get("missing")).rejects.toThrow(/not found/);
  });

  it("encodes names with special chars", async () => {
    fetchMock.mockResolvedValueOnce(_ok({ name: "with space", body: "" }));
    const c = new SkillsClient(BASE);
    await c.get("with space");
    expect(fetchMock).toHaveBeenCalledWith(
      `${BASE}/debug/skills/${encodeURIComponent("with space")}`,
    );
  });
});

describe("SkillsClient.save", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("sends PUT with text body and invalidates list cache", async () => {
    fetchMock.mockResolvedValueOnce(_ok({ ok: true, name: "foo" }));
    const c = new SkillsClient(BASE);
    // 先预热 list cache
    fetchMock.mockResolvedValueOnce(
      _ok({ skills: [{ name: "x", description: "x", tier: 1, path: "/x" }] }),
    );
    await c.list();
    await c.save("foo", "# Foo\n");
    expect(fetchMock).toHaveBeenLastCalledWith(
      `${BASE}/debug/skills/foo`,
      expect.objectContaining({
        method: "PUT",
        headers: expect.objectContaining({ "Content-Type": expect.stringContaining("markdown") }),
        body: "# Foo\n",
      }),
    );
    // list cache 被清
    fetchMock.mockResolvedValueOnce(_ok({ skills: [] }));
    await c.list();
    expect(fetchMock).toHaveBeenCalledTimes(3); // initial list, put, re-list
  });

  it("throws on 400 with server message", async () => {
    fetchMock.mockResolvedValueOnce(_err(400, "invalid skill name"));
    const c = new SkillsClient(BASE);
    await expect(c.save("../escape", "x")).rejects.toThrow(/invalid skill name/);
  });
});

describe("SkillsClient.remove", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("sends DELETE and invalidates cache", async () => {
    fetchMock.mockResolvedValueOnce(_ok({ ok: true, name: "foo" }));
    const c = new SkillsClient(BASE);
    await c.remove("foo");
    expect(fetchMock).toHaveBeenCalledWith(
      `${BASE}/debug/skills/foo`,
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("404 throws", async () => {
    fetchMock.mockResolvedValueOnce(_err(404, "skill not found"));
    const c = new SkillsClient(BASE);
    await expect(c.remove("missing")).rejects.toThrow(/not found/);
  });
});

describe("SkillsClient.upload", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("sends POST with zip blob", async () => {
    fetchMock.mockResolvedValueOnce(_ok({ added: ["foo", "bar"] }));
    const c = new SkillsClient(BASE);
    const blob = new Blob([new Uint8Array([0x50, 0x4b])], {
      type: "application/zip",
    });
    const result = await c.upload(blob);
    expect(result).toEqual({ added: ["foo", "bar"] });
    expect(fetchMock).toHaveBeenCalledWith(
      `${BASE}/debug/skills/upload`,
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "Content-Type": "application/zip" }),
        body: blob,
      }),
    );
  });

  it("throws on bad zip with server message", async () => {
    fetchMock.mockResolvedValueOnce(_err(400, "invalid zip: bad magic"));
    const c = new SkillsClient(BASE);
    await expect(c.upload(new Blob([]))).rejects.toThrow(/invalid zip/);
  });
});
