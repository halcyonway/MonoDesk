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
    return runId ? `${sessionKey}:${runId}` : `${sessionKey}:*`;
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
    this.recentCache.set(cacheKey, body.runs);
    return body.runs;
  }

  invalidate(sessionKey: string): void {
    for (const k of [...this.cache.keys()]) {
      if (k.startsWith(sessionKey + ":")) this.cache.delete(k);
    }
    this.recentCache.delete(this.key(sessionKey));
  }
}