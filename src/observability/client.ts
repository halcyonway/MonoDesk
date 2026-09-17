// TraceClient: 拉取 MonoX DebugServer 上的 Run 数据。
//
// 故意做得很薄：MonoDesk 不实现 trace 存储 / 解析，只做 fetch + 内存 cache。
// HMR 安全：通过 window 单例复用 cache，避免反复创建。

import type { TraceRun, TraceRunSummary } from "../ws/protocol";

const DEFAULT_BASE_URL = "http://127.0.0.1:8768";

interface WindowWithTrace extends Window {
  __monodeskTraceClient?: TraceClient;
}

export class TraceClient {
  private baseUrl: string;
  private cache = new Map<string, TraceRun>();
  private recentCache = new Map<string, TraceRunSummary[]>();

  constructor(baseUrl: string = DEFAULT_BASE_URL) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  // 复用一个 client 实例（HMR 跨刷新保 cache + 单例 fetch in-flight）
  static shared(baseUrl?: string): TraceClient {
    const w = window as unknown as WindowWithTrace;
    if (w.__monodeskTraceClient) return w.__monodeskTraceClient;
    const c = new TraceClient(baseUrl);
    if (import.meta.env.DEV) w.__monodeskTraceClient = c;
    return c;
  }

  private key(sessionKey: string, runId?: string): string {
    // cache key 加 schema_version=v2 后缀：v1 / v2 不可混存（list/get 都按
    // 同一 key 复用就坏了），而且 v1 数据后端归档后再不会来，加后缀让老 cache
    // 自然失效。
    const v = "v2";
    return runId ? `${sessionKey}:${runId}:${v}` : `${sessionKey}:*:${v}`;
  }

  async getRun(sessionKey: string, runId: string): Promise<TraceRun> {
    const cacheKey = this.key(sessionKey, runId);
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;
    const url = `${this.baseUrl}/debug/runs/${encodeURIComponent(runId)}?session_key=${encodeURIComponent(sessionKey)}`;
    const resp = await fetch(url);
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`trace fetch ${resp.status}: ${text || resp.statusText}`);
    }
    const run = (await resp.json()) as TraceRun;
    // v1 协议后端已归档，理论上不会到这里；防御性 reject 让 UI 端拿到的
    // 都是 v2，避免 kind / schema_version 字段缺失导致渲染崩。
    if ((run.schema_version ?? 1) < 2) {
      throw new Error(`trace run ${runId} is legacy v1; not renderable`);
    }
    this.cache.set(cacheKey, run);
    return run;
  }

  async getRecent(sessionKey: string, limit = 20): Promise<TraceRunSummary[]> {
    const cacheKey = this.key(sessionKey);
    const cached = this.recentCache.get(cacheKey);
    if (cached) return cached;
    const url = `${this.baseUrl}/debug/runs/recent?session_key=${encodeURIComponent(sessionKey)}&limit=${limit}`;
    const resp = await fetch(url);
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`trace recent fetch ${resp.status}: ${text || resp.statusText}`);
    }
    const body = (await resp.json()) as { runs: TraceRunSummary[] };
    // 过滤 v1：MonoX 启动时全 v1 文件已归档，理论上 list 不会带；但混合
    // 文件残留或迁移期还是可能见到，UI 不渲染 v1。
    const v2only = body.runs.filter((r) => (r.schema_version ?? 1) >= 2);
    this.recentCache.set(cacheKey, v2only);
    return v2only;
  }

  invalidate(sessionKey: string): void {
    for (const k of [...this.cache.keys()]) {
      if (k.startsWith(sessionKey + ":")) this.cache.delete(k);
    }
    this.recentCache.delete(this.key(sessionKey));
  }
}