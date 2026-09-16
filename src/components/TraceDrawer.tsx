// TraceDrawer: 右侧抽屉，展示一次 Run 的 tree trace。
//
// 设计原则：
// - 是 tree，不是 timeline
// - messages 节点美化渲染（不是裸 JSON）
// - 折叠/展开：reasoning 默认展开（最重要），act/compress 默认折叠
// - 大字段默认折叠 + "show full"
//
// 不实现 trace 存储 / 拉取逻辑（TraceClient 负责），Drawer 只渲染。

import { memo, useEffect, useState } from "react";
import type { TraceClient } from "../observability/client";
import type {
  TraceRun,
  TraceSpan,
  TraceTurn,
} from "../ws/protocol";
import { fmtMs } from "../stream/markdown";

const COLLAPSE_AT = 200;

function fmtTime(ts: number): string {
  const d = new Date(ts * 1000);
  return d.toLocaleTimeString([], { hour12: false });
}

function shortId(id: string): string {
  // trace_<12 hex> / u_<12 hex> / s_<12 hex>
  return id.length > 8 ? id.slice(0, 4) + "…" + id.slice(-4) : id;
}

function safeStr(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

// ---- 折叠展开控件 ----

function useOpen(defaultOpen: boolean) {
  const [open, setOpen] = useState(defaultOpen);
  return [open, setOpen] as const;
}

function Toggle({
  open,
  onClick,
}: {
  open: boolean;
  onClick: () => void;
}) {
  return (
    <span
      className={"trace-chev" + (open ? " open" : "")}
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onClick()}
    >
      <svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M3 5l3 3 3-3" />
      </svg>
    </span>
  );
}

function MaybeCollapse({ text }: { text: string }) {
  const [open, setOpen] = useOpen(false);
  if (text.length <= COLLAPSE_AT) return <pre className="trace-pre">{text}</pre>;
  return (
    <>
      <pre className="trace-pre">{open ? text : text.slice(0, COLLAPSE_AT) + "…"}</pre>
      <button className="trace-more" onClick={() => setOpen((o) => !o)}>
        {open ? "show less" : "show full"}
      </button>
    </>
  );
}

// ---- Messages 美化渲染 ----

type Role = "system" | "user" | "assistant" | "tool";

function asRole(s: string): Role {
  if (s === "system" || s === "user" || s === "assistant" || s === "tool") return s;
  return "assistant";
}

function extractContent(msg: any): string {
  if (typeof msg?.content === "string") return msg.content;
  if (Array.isArray(msg?.content)) {
    return msg.content
      .map((p: any) => {
        if (typeof p === "string") return p;
        if (p?.text) return p.text;
        return safeStr(p);
      })
      .join("\n");
  }
  return safeStr(msg?.content ?? msg);
}

function extractToolCalls(msg: any): Array<{ id: string; name: string; args: any }> {
  const tc = msg?.tool_calls;
  if (!Array.isArray(tc)) return [];
  return tc.map((c: any) => ({
    id: c?.id ?? "",
    name: c?.function?.name ?? "",
    args: c?.function?.arguments ?? "",
  }));
}

const MessageRow = memo(function MessageRow({
  role,
  content,
  toolCalls,
}: {
  role: Role;
  content: string;
  toolCalls: Array<{ id: string; name: string; args: any }>;
}) {
  return (
    <div className={"trace-msg trace-msg-role-" + role}>
      <div className="trace-msg-role">{role}</div>
      <div className="trace-msg-body">
        {content && <div className="trace-msg-text">{content}</div>}
        {toolCalls.length > 0 && (
          <div className="trace-msg-tools">
            {toolCalls.map((tc, i) => (
              <div className="trace-msg-tool" key={(tc.id || "tc") + i}>
                <span className="trace-msg-tool-name">{tc.name || "(unnamed)"}</span>
                <MaybeCollapse text={safeStr(tc.args)} />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
});

function Messages({ messages }: { messages: any[] }) {
  const [expanded, setExpanded] = useOpen(false);
  if (!Array.isArray(messages) || messages.length === 0) {
    return <div className="trace-empty">no messages</div>;
  }
  // > 5 条 messages 默认折叠到只显示前 5，点 "show all" 展开。第一个 message
  // 通常是 system（不变），所以折叠 system + 最近 N 条更合理，但简单起见就
  // 折叠到前 N 条 — 用户想看完整可点开。
  const VISIBLE = 5;
  const visible = expanded ? messages : messages.slice(0, VISIBLE);
  const hidden = messages.length - VISIBLE;
  return (
    <div className="trace-messages">
      {visible.map((m: any, i: number) => {
        const role = asRole(String(m?.role ?? ""));
        const content = extractContent(m);
        const toolCalls = extractToolCalls(m);
        return (
          <MessageRow
            key={i}
            role={role}
            content={content}
            toolCalls={toolCalls}
          />
        );
      })}
      {!expanded && hidden > 0 && (
        <button className="trace-more" onClick={() => setExpanded(true)}>
          show all {messages.length} messages (+{hidden})
        </button>
      )}
      {expanded && hidden > 0 && (
        <button className="trace-more" onClick={() => setExpanded(false)}>
          show less
        </button>
      )}
    </div>
  );
}

// ---- Span tree ----

// 计算单次 LLM call 的 prompt cache hit ratio：cached_tokens / prompt_tokens。
// 缺字段返回 null（UI 不显示）。
function cacheHitRatio(usage: any): number | null {
  const cached = usage?.cached_tokens;
  const prompt = usage?.prompt_tokens;
  if (typeof cached === "number" && typeof prompt === "number" && prompt > 0) {
    return cached / prompt;
  }
  return null;
}

// 计算一个 run 内所有 reasoning span 的平均 cache hit ratio。
// 没有 cached_tokens 信息的 turn 不计入分母（不是当 0 处理）。
function avgCacheHitRatio(run: TraceRun): number | null {
  const ratios: number[] = [];
  for (const t of run.turns) {
    for (const s of t.spans) {
      if (s.kind !== "reasoning") continue;
      const r = cacheHitRatio(s.attributes?.usage);
      if (r != null) ratios.push(r);
    }
  }
  if (ratios.length === 0) return null;
  return ratios.reduce((a, b) => a + b, 0) / ratios.length;
}

function fmtPct(x: number): string {
  return (x * 100).toFixed(1) + "%";
}

function SpanNode({ span, depth }: { span: TraceSpan; depth: number }) {
  // reasoning 默认展开；其它默认折叠
  const [open, setOpen] = useOpen(span.kind === "reasoning");
  const a = span.attributes || {};
  const latency = a.latency_ms;
  const usage = a.usage || {};
  const model = a.model;
  const cacheRatio = cacheHitRatio(usage);

  return (
    <div className="trace-node" style={{ marginLeft: depth * 14 }}>
      <div className="trace-node-head" onClick={() => setOpen((o) => !o)}>
        <Toggle open={open} onClick={() => setOpen((o) => !o)} />
        <span className={"trace-node-kind trace-node-kind-" + span.kind}>{span.kind}</span>
        <span className="trace-node-name">{span.name}</span>
        <span className="trace-node-id">{shortId(span.span_id)}</span>
        {typeof latency === "number" && <span className="trace-node-latency">{fmtMs(latency)}</span>}
        {model && <span className="trace-node-model">{model}</span>}
        {((typeof usage.completion_tokens === "number" && usage.completion_tokens > 0) ||
          (typeof usage.prompt_tokens === "number" && usage.prompt_tokens > 0)) && (
          <span className="trace-node-tokens">
            {usage.prompt_tokens ?? "?"}→{usage.completion_tokens} tok
          </span>
        )}
        {cacheRatio != null && (
          <span className="trace-node-cache" title="prompt cache hit ratio">
            ⚡ {fmtPct(cacheRatio)}
          </span>
        )}
        {span.status !== "ok" && <span className="trace-node-status">{span.status}</span>}
      </div>
      {open && (
        <div className="trace-node-body">
          {span.kind === "reasoning" && (
            <>
              <div className="trace-section">messages</div>
              <Messages messages={Array.isArray(a.messages) ? a.messages : []} />
              {a.response_text && (
                <>
                  <div className="trace-section">response</div>
                  <MaybeCollapse text={String(a.response_text)} />
                </>
              )}
              {a.finish_reason && (
                <div className="trace-section">finish_reason · {a.finish_reason}</div>
              )}
              {cacheRatio != null && (
                <div className="trace-section">
                  prompt cache · {usage.cached_tokens ?? "?"}/{usage.prompt_tokens ?? "?"} tok ·
                  hit {fmtPct(cacheRatio)}
                </div>
              )}
            </>
          )}
          {span.kind === "act" && (
            <>
              {a.tool_name && (
                <div className="trace-section">tool · {a.tool_name}</div>
              )}
              <div className="trace-section">args</div>
              <MaybeCollapse text={safeStr(a.args)} />
              <div className="trace-section">result</div>
              <MaybeCollapse text={safeStr(a.result)} />
            </>
          )}
          {span.kind === "compress" && (
            <>
              <div className="trace-section">level · {a.level}</div>
              <div className="trace-section">summary</div>
              <MaybeCollapse text={String(a.summary ?? "")} />
              <div className="trace-section">folded_count · {a.folded_count ?? 0}</div>
              {Array.isArray(a.budget_ids) && a.budget_ids.length > 0 && (
                <div className="trace-section">budget_ids · {a.budget_ids.join(", ")}</div>
              )}
            </>
          )}
          <details className="trace-raw">
            <summary>raw attributes</summary>
            <MaybeCollapse text={safeStr(span.attributes)} />
          </details>
        </div>
      )}
    </div>
  );
}

function TurnNode({
  turn,
  index,
  depth,
}: {
  turn: TraceTurn;
  index: number; // run-local 编号（1-based），跟 MonoX 端的 step_idx 无关
  depth: number;
}) {
  const [open, setOpen] = useOpen(true);
  // 找第一个 reasoning span 拿 model / latency 给 header
  const reasoning = turn.spans.find((s) => s.kind === "reasoning");
  const a = reasoning?.attributes || {};
  const usage = a.usage || {};
  const model = a.model;
  const cacheRatio = cacheHitRatio(usage);

  return (
    <div className="trace-turn" style={{ marginLeft: depth * 14 }}>
      <div className="trace-turn-head" onClick={() => setOpen((o) => !o)}>
        <Toggle open={open} onClick={() => setOpen((o) => !o)} />
        <span className="trace-turn-label">Turn #{index}</span>
        <span className="trace-turn-id">{shortId(turn.turn_id)}</span>
        <span className="trace-turn-count">{turn.spans.length} span(s)</span>
        {typeof a.latency_ms === "number" && <span className="trace-turn-latency">{fmtMs(a.latency_ms)}</span>}
        {model && <span className="trace-turn-model">{model}</span>}
        {((typeof usage.completion_tokens === "number" && usage.completion_tokens > 0) ||
          (typeof usage.prompt_tokens === "number" && usage.prompt_tokens > 0)) && (
          <span className="trace-turn-tokens">{usage.prompt_tokens ?? "?"}→{usage.completion_tokens} tok</span>
        )}
        {cacheRatio != null && (
          <span className="trace-turn-cache" title="prompt cache hit ratio">
            ⚡ {fmtPct(cacheRatio)}
          </span>
        )}
      </div>
      {open && (
        <div className="trace-turn-body">
          {turn.spans.map((s) => (
            <SpanNode key={s.span_id} span={s} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

// 聚合一个 run 的所有 reasoning span 的 token 数。
// 必须至少有一个**实际有值**的字段才返回 totals：旧 trace（LLM 没报 usage）的
// usage 是空 dict `{}`，不算「有数据」——否则会显示 "tokens 0 → 0" 噪声。
function aggregateTokens(run: TraceRun): { prompt: number; completion: number; cached: number } | null {
  let prompt = 0, completion = 0, cached = 0;
  let hasPrompt = false, hasCompletion = false, hasCached = false;
  for (const t of run.turns) {
    for (const s of t.spans) {
      if (s.kind !== "reasoning") continue;
      const u = s.attributes?.usage;
      if (!u) continue;
      if (typeof u.prompt_tokens === "number") { prompt += u.prompt_tokens; hasPrompt = true; }
      if (typeof u.completion_tokens === "number") { completion += u.completion_tokens; hasCompletion = true; }
      if (typeof u.cached_tokens === "number") { cached += u.cached_tokens; hasCached = true; }
    }
  }
  if (!hasPrompt && !hasCompletion && !hasCached) return null;
  return { prompt, completion, cached };
}

function RunHeader({ run }: { run: TraceRun }) {
  const turns = run.turns.length;
  const dur = run.end_ts ? run.end_ts - run.start_ts : null;
  const avgCache = avgCacheHitRatio(run);
  const totals = aggregateTokens(run);
  return (
    <div className="trace-run-head">
      <div className="trace-run-title">
        <span className="trace-run-label">Run</span>
        <span className="trace-run-id">{shortId(run.run_id)}</span>
      </div>
      <div className="trace-run-meta">
        <span className={"trace-run-status trace-run-status-" + run.status}>{run.status}</span>
        <span>{turns} turn(s)</span>
        {dur != null && <span>{fmtMs(Math.round(dur * 1000))}</span>}
        <span>{fmtTime(run.start_ts)}</span>
      </div>
      <div className="trace-run-user">"{run.user_text}"</div>
      {(avgCache != null || totals != null) && (
        <div className="trace-run-summary">
          {totals != null && (
            <span className="trace-run-totals">
              tokens {totals.prompt.toLocaleString()} → {totals.completion.toLocaleString()}
              {totals.cached > 0 && (
                <span className="trace-run-cached"> · ⚡ {totals.cached.toLocaleString()} cached</span>
              )}
            </span>
          )}
          {avgCache != null && (
            <span className="trace-run-cache-pill">
              avg prompt cache ⚡ {fmtPct(avgCache)}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

export function TraceDrawer({
  runId,
  sessionKey,
  client,
  onClose,
}: {
  runId: string | null;
  sessionKey: string;
  client: TraceClient;
  onClose: () => void;
}) {
  const open = runId !== null;
  const [run, setRun] = useState<TraceRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!runId) {
      setRun(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setRun(null);
    client
      .getRun(sessionKey, runId)
      .then((r) => {
        if (!cancelled) {
          setRun(r);
          setLoading(false);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e?.message || String(e));
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [runId, sessionKey, client]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return (
    <>
      <div
        className={"trace-scrim" + (open ? " open" : "")}
        onClick={onClose}
        aria-hidden={!open}
      />
      <aside className={"trace-drawer" + (open ? " open" : "")} aria-hidden={!open}>
        <header className="trace-drawer-head">
          <span>trace</span>
          <span className="trace-drawer-spacer" />
          <button className="trace-close" onClick={onClose} title="close (Esc)">×</button>
        </header>
        <div className="trace-drawer-body">
          {!open && <div className="trace-empty">pick a run to inspect</div>}
          {open && loading && (
            <div className="trace-skel">
              <div className="trace-skel-line" />
              <div className="trace-skel-line w70" />
              <div className="trace-skel-line w40" />
            </div>
          )}
          {open && error && (
            <div className="trace-error">
              <div className="trace-error-msg">fetch failed · {error}</div>
              <button
                className="trace-retry"
                onClick={() => {
                  if (runId) {
                    setError(null);
                    setLoading(true);
                    client
                      .getRun(sessionKey, runId)
                      .then(setRun)
                      .catch((e) => setError(e?.message || String(e)))
                      .finally(() => setLoading(false));
                  }
                }}
              >
                retry
              </button>
            </div>
          )}
          {open && run && (
            <div className="trace-tree">
              <RunHeader run={run} />
              {run.turns.length === 0 && (
                <div className="trace-empty">no turns</div>
              )}
              {run.turns.map((t, i) => (
                <TurnNode key={t.turn_id} turn={t} index={i + 1} depth={0} />
              ))}
            </div>
          )}
        </div>
      </aside>
    </>
  );
}