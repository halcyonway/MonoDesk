// SkillsClient — 调 MonoX DebugServer 上的 /debug/skills/* 接口做 skill 管理。
//
// 设计：镜像 TraceClient 模式（singleton + 内存 cache + HMR 复用）。
//   - list() 有 cache（list 通常被反复调用，server-side 是 filesystem 扫）
//   - get / save / remove / upload 都直接 fetch（写后立即 invalidate list）
//
// 错误约定：
//   - HTTP 4xx → Error(message = body.error)
//   - HTTP 5xx → Error(message = body.error or statusText)
//   - 非 JSON 错误 body → Error(message = statusText)

import type { SkillMeta, SkillFull } from "./types";

const DEFAULT_BASE_URL = "http://127.0.0.1:8768";

interface WindowWithSkills extends Window {
  __monodeskSkillsClient?: SkillsClient;
}

export class SkillsClient {
  private baseUrl: string;
  private listCache: SkillMeta[] | null = null;

  constructor(baseUrl: string = DEFAULT_BASE_URL) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  static shared(baseUrl?: string): SkillsClient {
    const w = window as unknown as WindowWithSkills;
    if (w.__monodeskSkillsClient) return w.__monodeskSkillsClient;
    const c = new SkillsClient(baseUrl);
    if (import.meta.env.DEV) w.__monodeskSkillsClient = c;
    return c;
  }

  // ---- list ----

  async list(): Promise<SkillMeta[]> {
    if (this.listCache) return this.listCache;
    const resp = await fetch(`${this.baseUrl}/debug/skills/list`);
    if (!resp.ok) throw await _asError(resp, "skills list");
    const body = (await resp.json()) as { skills: SkillMeta[] };
    this.listCache = body.skills;
    return body.skills;
  }

  // ---- get one ----

  async get(name: string): Promise<SkillFull> {
    const resp = await fetch(
      `${this.baseUrl}/debug/skills/${encodeURIComponent(name)}`,
    );
    if (!resp.ok) throw await _asError(resp, `skill get ${name}`);
    return (await resp.json()) as SkillFull;
  }

  // ---- write ----

  async save(name: string, body: string): Promise<void> {
    const resp = await fetch(
      `${this.baseUrl}/debug/skills/${encodeURIComponent(name)}`,
      {
        method: "PUT",
        headers: { "Content-Type": "text/markdown; charset=utf-8" },
        body,
      },
    );
    if (!resp.ok) throw await _asError(resp, `skill save ${name}`);
    this.invalidate();
  }

  // ---- delete ----

  async remove(name: string): Promise<void> {
    const resp = await fetch(
      `${this.baseUrl}/debug/skills/${encodeURIComponent(name)}`,
      { method: "DELETE" },
    );
    if (!resp.ok) throw await _asError(resp, `skill delete ${name}`);
    this.invalidate();
  }

  // ---- upload zip ----

  async upload(zip: Blob): Promise<{ added: string[] }> {
    const resp = await fetch(`${this.baseUrl}/debug/skills/upload`, {
      method: "POST",
      headers: { "Content-Type": "application/zip" },
      body: zip,
    });
    if (!resp.ok) throw await _asError(resp, "skill upload");
    const body = (await resp.json()) as { added: string[] };
    this.invalidate();
    return body;
  }

  // ---- cache ----

  invalidate(): void {
    this.listCache = null;
  }
}

// ---- 错误处理 helper ----

async function _asError(resp: Response, ctx: string): Promise<Error> {
  let detail = "";
  try {
    const data = (await resp.json()) as { error?: string };
    if (data && typeof data.error === "string") detail = data.error;
  } catch {
    // body 不是 JSON
    try {
      detail = await resp.text();
    } catch {
      // ignore
    }
  }
  const msg = detail
    ? `${ctx}: ${resp.status} ${detail}`
    : `${ctx}: ${resp.status} ${resp.statusText}`;
  return new Error(msg);
}
