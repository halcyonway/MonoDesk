// TraceDrawer: 右侧抽屉，展示一次 Run 的 tree trace + 选中节点的 I/O 详情。
//
// v2 设计（spec/requirements/trace-tree-redesign.md）：
// - 左右分栏：左 = tree，右 = detail panel（drawer 宽度 min(1800px, 96vw)）
// - 默认折叠：Run 节点展开；turn 折叠；message / JSON 折叠
// - trace_id 全量展示（monospace，no truncation）
// - tree 形状：Run → bootstrap / loop / finalize → turn → reasoning + act → tool
// - Detail 面板：kind badge + name + 完整 span_id + duration + INPUT / OUTPUT / ERRORS / META
// - reason 和 act 是 turn 的同层子节点（act 仅 tool_calls > 0 时出现）
// - 属性键全部走 OTel Semantic Convention

import React, { useEffect, useMemo, useState } from "react";
import type { TraceClient } from "../observability/client";
import type {
  SpanKind,
  TraceRun,
  TraceSpan,
  TraceTurn,
} from "../ws/protocol";
import { fmtMs } from "../stream/markdown";

// OTel attribute key 常量（前端镜像 MonoX core/observability/otel_attrs.py）。
// 单一来源是 MonoX 端；这里只引用名字，避免在多个地方硬编码字符串。
const ATTR = {
  // GenAI
  MODEL_REQ: "gen_ai.request.model",
  MESSAGES: "gen_ai.request.messages",
  TOOL_SPECS: "gen_ai.request.tool_specs",
  MODEL_RES: "gen_ai.response.model",
  TEXT: "gen_ai.response.text",
  REASONING: "gen_ai.response.reasoning",
  FINISH_REASONS: "gen_ai.response.finish_reasons",
  USAGE_IN: "gen_ai.usage.input_tokens",
  USAGE_OUT: "gen_ai.usage.output_tokens",
  USAGE_CACHED: "gen_ai.usage.cached_tokens",
  DURATION: "gen_ai.client.operation.duration",
  TTFT: "gen_ai.client.time_to_first_token",
  // Tool
  TOOL_NAME: "tool.name",
  TOOL_CALL_ID: "tool.call.id",
  TOOL_CALL_ARGS: "tool.call.arguments",
  TOOL_RESULT: "tool.result",
  TOOL_RESULT_STATUS: "tool.result.status",
  TOOL_RESULT_TRUNCATED: "tool.result.truncated",
  // Loop
  TURN_IDX: "loop.turn.idx",
  COMPRESS_LEVEL: "loop.compress.level",
  COMPRESS_SUMMARY: "loop.compress.summary",
  COMPRESS_FOLDED: "loop.compress.folded_count",
  COMPRESS_BUDGETS: "loop.compress.budget_ids",
  // Error
  ERROR_TYPE: "error.type",
  ERROR_MESSAGE: "error.message",
  LOOP_CANCELLED: "loop.cancelled",
  // Service
  SERVICE_NAME: "service.name",
} as const;

// ---- 工具函数 ----

function fmtTime(ts: number): string {
  const d = new Date(ts * 1000);
  return d.toLocaleTimeString([], { hour12: false });
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

function fmtPct(x: number): string {
  return (x * 100).toFixed(1) + "%";
}

// ---- 折叠展开 ----

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
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
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

// 值的快速摘要（用于折叠头部的一行提示）。
function summarize(v: unknown): string {
  if (v == null) return "(null)";
  if (typeof v === "string") {
    const parsed = maybeParseJson(v);
    if (parsed !== v && Array.isArray(parsed)) return `[${parsed.length} items]`;
    if (parsed !== v && typeof parsed === "object") {
      return `{${Object.keys(parsed as object).length} keys}`;
    }
    return v.length > 40 ? v.slice(0, 40) + "…" : v;
  }
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return `[${v.length} items]`;
  if (typeof v === "object") return `{${Object.keys(v as object).length} keys}`;
  return safeStr(v);
}

// ---- Tree node helpers ----

// Span duration（毫秒）— 优先取 attributes.gen_ai.client.operation.duration，否则由 start_ts/end_ts 算
function spanDuration(span: TraceSpan): number | null {
  const dur = span.attributes?.[ATTR.DURATION];
  if (typeof dur === "number") return dur;
  if (span.end_ts != null) return Math.max(0, Math.round((span.end_ts - span.start_ts) * 1000));
  return null;
}

// token 总数（从 reasoning span 的 OTel 字段抽）
function tokenSummary(span: TraceSpan): { prompt: number; completion: number; cached: number } | null {
  const a = span.attributes || {};
  const prompt = a[ATTR.USAGE_IN];
  const completion = a[ATTR.USAGE_OUT];
  const cached = a[ATTR.USAGE_CACHED];
  if (typeof prompt !== "number" && typeof completion !== "number" && typeof cached !== "number") {
    return null;
  }
  return {
    prompt: typeof prompt === "number" ? prompt : 0,
    completion: typeof completion === "number" ? completion : 0,
    cached: typeof cached === "number" ? cached : 0,
  };
}

// ---- Detail panel（选中节点的 I/O 详情）----

type DetailNode =
  | { kind: "span"; span: TraceSpan }
  | { kind: "turn"; turn: TraceTurn; turnIdx: number }
  | { kind: "run" };

// ---- 通用 JSON tree renderer（右栏 detail 用的 OTel key-value 渲染）----

// 把 OTel JSON 字符串（tool.call.arguments / tool.result / tool.result.status 等）
// 解析成对象；解析失败当字符串处理。
function maybeParseJson(v: unknown): unknown {
  if (typeof v !== "string") return v;
  const t = v.trim();
  if (!t || (t[0] !== "{" && t[0] !== "[" && t[0] !== '"')) return v;
  try {
    return JSON.parse(t);
  } catch {
    return v;
  }
}

// 长字符串 preview 阈值：超过这个字符数显示预览 + "show full" 按钮；
// 展开后看全量（不靠 word-break 切字符，避免「tim…time」这种断词）。
const STRING_PREVIEW_AT = 160;

// 长字符串：默认显示预览（仅切前 N 字符 + …提示），点按钮看全量。
// 预览部分用 pre-wrap 保留换行、overflow-wrap 在窄列下自然换行；
// 按钮独立一行永远可见（不跟 inline 文字挤一起被裁掉）。
function StringValue({ value }: { value: string }) {
  const [expanded, setExpanded] = useState(false);
  if (value.length <= STRING_PREVIEW_AT) {
    return <span className="trace-jt-string">"{value}"</span>;
  }
  return (
    <span className="trace-jt-string-wrap">
      <span className="trace-jt-string">
        "{expanded ? value : value.slice(0, STRING_PREVIEW_AT) + "…"}"
      </span>{" "}
      <button
        className="trace-jt-more"
        onClick={(e) => {
          e.stopPropagation();
          setExpanded((o) => !o);
        }}
      >
        {expanded ? "show less" : "show full"}
      </button>
    </span>
  );
}

function JsonScalar({ value }: { value: unknown }) {
  if (value == null) return <span className="trace-jt-null">null</span>;
  if (typeof value === "string") return <StringValue value={value} />;
  if (typeof value === "number") return <span className="trace-jt-number">{value}</span>;
  if (typeof value === "boolean") return <span className="trace-jt-bool">{String(value)}</span>;
  return <span>{safeStr(value)}</span>;
}

// 单个 key/value 行。标量直接显示；对象/数组用 <details> 默认折叠。
function JsonRow({ k, v }: { k: string; v: unknown }) {
  const parsed = maybeParseJson(v);
  const isScalar = parsed == null || typeof parsed === "string" || typeof parsed === "number" || typeof parsed === "boolean";
  if (isScalar) {
    return (
      <div className="trace-jt-row trace-jt-row-scalar">
        <span className="trace-jt-key">{k}</span>
        <span className="trace-jt-colon">: </span>
        <JsonScalar value={parsed} />
      </div>
    );
  }
  return (
    <details className="trace-jt-row trace-jt-row-tree">
      <summary>
        <span className="trace-jt-key">{k}</span>
        <span className="trace-jt-summary">{summarize(parsed)}</span>
      </summary>
      <div className="trace-jt-children">
        <JsonTree value={parsed} />
      </div>
    </details>
  );
}

// 递归渲染数组 / 对象。数组里每个 item 也可折叠。
function JsonTree({ value }: { value: unknown }) {
  if (Array.isArray(value)) {
    if (value.length === 0) return <div className="trace-jt-empty">[]</div>;
    return (
      <div className="trace-jt-array">
        {value.map((item, i) => (
          <div key={i} className="trace-jt-array-item">
            {isContainer(item) ? (
              <details className="trace-jt-row trace-jt-row-tree">
                <summary>
                  <span className="trace-jt-idx">[{i}]</span>
                  <span className="trace-jt-summary">{summarize(item)}</span>
                </summary>
                <div className="trace-jt-children">
                  <JsonTree value={item} />
                </div>
              </details>
            ) : (
              <div className="trace-jt-row trace-jt-row-scalar">
                <span className="trace-jt-idx">[{i}]</span>
                <span className="trace-jt-colon">: </span>
                <JsonScalar value={item} />
              </div>
            )}
          </div>
        ))}
      </div>
    );
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value);
    if (entries.length === 0) return <div className="trace-jt-empty">{"{}"}</div>;
    return (
      <div className="trace-jt-object">
        {entries.map(([k, v]) => (
          <JsonRow key={k} k={k} v={v} />
        ))}
      </div>
    );
  }
  return <JsonScalar value={value} />;
}

function isContainer(v: unknown): boolean {
  return (typeof v === "object" && v !== null) || Array.isArray(v);
}

// 按 span kind 把 attributes 拆成 input / output / artifacts / errors 几组。
// 统一 INPUT + OUTPUT 两块，每块内部是 OTel key-value 的 JSON tree；
// 不再分 INPUT · messages / INPUT · tool_specs 这种小标题。
function classifyAttrs(span: TraceSpan): {
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  artifacts: Record<string, unknown>;
  errors: Record<string, unknown>;
} {
  const a = span.attributes || {};
  const pick = (keys: string[]) => {
    const r: Record<string, unknown> = {};
    for (const k of keys) if (a[k] !== undefined) r[k] = a[k];
    return r;
  };

  let inputKeys: string[] = [];
  let outputKeys: string[] = [];

  if (span.kind === "reasoning") {
    inputKeys = [ATTR.MODEL_REQ, ATTR.MESSAGES, ATTR.TOOL_SPECS];
    outputKeys = [
      ATTR.MODEL_RES,
      ATTR.TEXT,
      ATTR.REASONING,
      ATTR.FINISH_REASONS,
      ATTR.USAGE_IN,
      ATTR.USAGE_OUT,
      ATTR.USAGE_CACHED,
      ATTR.DURATION,
      ATTR.TTFT,
    ];
  } else if (span.kind === "tool") {
    inputKeys = [ATTR.TOOL_NAME, ATTR.TOOL_CALL_ID, ATTR.TOOL_CALL_ARGS];
    outputKeys = [ATTR.TOOL_RESULT, ATTR.TOOL_RESULT_STATUS, ATTR.TOOL_RESULT_TRUNCATED];
  } else if (span.kind === "compress") {
    outputKeys = [
      ATTR.COMPRESS_LEVEL,
      ATTR.COMPRESS_SUMMARY,
      ATTR.COMPRESS_FOLDED,
      ATTR.COMPRESS_BUDGETS,
    ];
  } else if (span.kind === "act") {
    // ACT 没有 I/O attrs；children 由其它分支处理
  } else {
    // bootstrap / loop / finalize / turn：把所有非 OTel-internal 的 attr 都塞 output
    outputKeys = Object.keys(a).filter(
      (k) => !k.startsWith("error.") && k !== ATTR.LOOP_CANCELLED
    );
  }

  // artifacts（loop.tool.artifact.* 命名空间）
  const artifacts: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(a)) {
    if (k.startsWith("loop.tool.artifact.")) artifacts[k.slice("loop.tool.artifact.".length)] = v;
  }

  // errors
  const errors = pick([ATTR.ERROR_TYPE, ATTR.ERROR_MESSAGE, ATTR.LOOP_CANCELLED]);

  return { input: pick(inputKeys), output: pick(outputKeys), artifacts, errors };
}

function JsonSection({ title, value }: { title: string; value: Record<string, unknown> }) {
  const keys = Object.keys(value);
  return (
    <section className="trace-section-block">
      <div className="trace-section-title">{title}</div>
      {keys.length === 0 ? (
        <div className="trace-empty">—</div>
      ) : (
        <div className="trace-jt">
          {keys.map((k) => (
            <JsonRow key={k} k={k} v={value[k]} />
          ))}
        </div>
      )}
    </section>
  );
}

function ActChildrenBlock({
  run,
  parentSpan,
  onJumpToSpan,
}: {
  run: TraceRun;
  parentSpan: TraceSpan;
  onJumpToSpan: (spanId: string) => void;
}) {
  const turn = run.turns.find((t) => t.turn_id === parentSpan.parent_id);
  if (!turn) return <div className="trace-empty">act not found under any turn</div>;
  const children = turn.spans.filter((s) => s.parent_id === parentSpan.span_id);
  if (children.length === 0) return <div className="trace-empty">no tool children</div>;
  return (
    <div className="trace-children-list">
      {children.map((s) => (
        <button key={s.span_id} className="trace-child-link" onClick={() => onJumpToSpan(s.span_id)}>
          <span className="trace-kind-pill trace-kind-pill-tool">{s.kind}</span>
          <span className="trace-child-name">{s.name}</span>
          <span className="mono trace-child-id">{s.span_id}</span>
        </button>
      ))}
    </div>
  );
}

function DetailPanel({
  node,
  run,
  onJumpToSpan,
}: {
  node: DetailNode;
  run: TraceRun;
  onJumpToSpan: (spanId: string) => void;
}) {
  if (node.kind === "run") {
    return (
      <div className="trace-detail">
        <div className="trace-detail-head">
          <span className="trace-detail-kind trace-detail-kind-run">RUN</span>
          <span className="trace-detail-id mono">{run.run_id}</span>
          <span className="trace-detail-name">{run.session_key}</span>
        </div>
        <section className="trace-section-block">
          <div className="trace-section-title">SUMMARY</div>
          <table className="trace-meta-table">
            <tbody>
              <tr><td>status</td><td>{run.status}</td></tr>
              <tr><td>start</td><td>{fmtTime(run.start_ts)}</td></tr>
              {run.end_ts != null && (
                <tr><td>end</td><td>{fmtTime(run.end_ts)}</td></tr>
              )}
              <tr><td>turns</td><td>{run.turns.length}</td></tr>
              <tr><td>user_text</td><td className="mono">"{run.user_text}"</td></tr>
              {run.final_text != null && (
                <tr><td>final_text</td><td className="mono">{run.final_text}</td></tr>
              )}
              <tr><td>schema_version</td><td>{run.schema_version}</td></tr>
            </tbody>
          </table>
        </section>
      </div>
    );
  }

  const span = node.kind === "span" ? node.span : null;
  const dur = span ? spanDuration(span) : null;

  if (node.kind === "turn") {
    const t = node.turn;
    return (
      <div className="trace-detail">
        <div className="trace-detail-head">
          <span className="trace-detail-kind trace-detail-kind-turn">TURN</span>
          <span className="trace-detail-id mono">{t.turn_id}</span>
          <span className="trace-detail-name">turn #{node.turnIdx}</span>
          <span className="trace-detail-count">{t.spans.length} spans</span>
        </div>
        <section className="trace-section-block">
          <div className="trace-section-title">CHILDREN</div>
          <div className="trace-children-list">
            {t.spans
              .filter((s) => s.kind !== "turn")
              .map((s) => (
                <button
                  key={s.span_id}
                  className="trace-child-link"
                  onClick={() => onJumpToSpan(s.span_id)}
                >
                  <span className={"trace-kind-pill trace-kind-pill-" + s.kind}>{s.kind}</span>
                  <span className="trace-child-name">{s.name}</span>
                  <span className="mono trace-child-id">{s.span_id}</span>
                </button>
              ))}
          </div>
        </section>
      </div>
    );
  }

  // span detail：按 kind 分 input/output/act children；没有 META · OTHER ATTRIBUTES
  const a = span!.attributes || {};
  const { input, output, artifacts, errors } = classifyAttrs(span!);

  return (
    <div className="trace-detail">
      <div className="trace-detail-head">
        <span className={"trace-detail-kind trace-detail-kind-" + span!.kind}>{span!.kind.toUpperCase()}</span>
        <span className="trace-detail-id mono">{span!.span_id}</span>
        <span className="trace-detail-name">{span!.name}</span>
        {dur != null && <span className="trace-detail-dur">{fmtMs(dur)}</span>}
        <span className={"trace-detail-status trace-detail-status-" + span!.status}>{span!.status}</span>
      </div>

      {Object.keys(input).length > 0 && <JsonSection title="INPUT" value={input} />}
      {Object.keys(output).length > 0 && <JsonSection title="OUTPUT" value={output} />}

      {span!.kind === "tool" && Object.keys(artifacts).length > 0 && (
        <JsonSection title="ARTIFACTS" value={artifacts} />
      )}

      {span!.kind === "act" && (
        <section className="trace-section-block">
          <div className="trace-section-title">CHILDREN</div>
          <ActChildrenBlock run={run} parentSpan={span!} onJumpToSpan={onJumpToSpan} />
        </section>
      )}

      {(Object.keys(errors).length > 0 || span!.status !== "ok") && (
        <section className="trace-section-block">
          <div className="trace-section-title trace-section-title-error">ERRORS</div>
          {Object.keys(errors).length > 0 ? (
            <div className="trace-jt">
              {Object.entries(errors).map(([k, v]) => (
                <JsonRow key={k} k={k} v={v} />
              ))}
            </div>
          ) : (
            <div className="trace-jt">
              <div className="trace-jt-row trace-jt-row-scalar">
                <span className="trace-jt-key">status</span>
                <span className="trace-jt-colon">: </span>
                <span className="trace-jt-string">"{span!.status}"</span>
              </div>
            </div>
          )}
        </section>
      )}

      {/* 兜底：如果一个 attr 都不在 input/output 分类里（异常 kind / 未知 attr），
          把剩下的塞 OUTPUT，让用户至少能看见 */}
      {Object.keys(input).length === 0 &&
        Object.keys(output).length === 0 &&
        Object.keys(errors).length === 0 &&
        Object.keys(a).length > 0 && <JsonSection title="ATTRIBUTES" value={a} />}
    </div>
  );
}

// ---- Tree node 渲染 ----

function kindBadgeClass(k: SpanKind): string {
  return "trace-kind-pill trace-kind-pill-" + k;
}

// turn 节点：默认折叠；header 展示 turn_idx + 第一个 reasoning span 的 model / latency / cache。
// open / onToggle 由 TraceDrawer 受控（"expand all turns" 按钮要能同时 toggle 所有 turn），
// 不再用内部 useState，否则全局按钮按了下面不动。
function TurnNode({
  turn,
  index,
  selectedSpanId,
  onSelect,
  open,
  onToggle,
}: {
  turn: TraceTurn;
  index: number;
  selectedSpanId: string | null;
  onSelect: (n: DetailNode) => void;
  open: boolean;
  onToggle: () => void;
}) {
  // TURN 容器 span 是 turn.spans[0]；work spans 从索引 1 开始。
  // 关键不变量：tool 必须只在 ACT 的 body 里渲染，不能跟 ACT 同级重复出现。
  // 把所有 parent_id 指向 ACT 的 tool 都从 workSpans 里剔掉，避免双渲染。
  const actSpanIds = new Set(
    turn.spans.filter((s) => s.kind === "act").map((s) => s.span_id)
  );
  const workSpans = turn.spans.filter(
    (s) => s.kind !== "turn" && !actSpanIds.has(s.parent_id ?? "")
  );
  const reasoning = workSpans.find((s) => s.kind === "reasoning");
  const dur = reasoning ? spanDuration(reasoning) : null;

  return (
    <div className={"trace-tree-turn" + (open ? " open" : "")}>
      <div
        className="trace-tree-turn-head"
        onClick={(e) => {
          if ((e.target as HTMLElement).closest(".trace-chev")) return;
          onSelect({ kind: "turn", turn, turnIdx: index });
        }}
      >
        <Toggle open={open} onClick={onToggle} />
        <span className="trace-tree-turn-label">turn #{index}</span>
        <span className="mono trace-tree-turn-id">{turn.turn_id}</span>
        <span className="trace-tree-turn-count">{workSpans.length} spans</span>
        {dur != null && <span className="trace-tree-turn-dur">{fmtMs(dur)}</span>}
      </div>
      {open && (
        <div className="trace-tree-turn-body">
          {workSpans.map((s) => {
            // ACT 节点 body = tool 子 span（嵌套 SpanTreeNode）；tool 在 ACT 外不再渲染。
            if (s.kind === "act") {
              const toolChildren = turn.spans.filter((x) => x.parent_id === s.span_id);
              return (
                <SpanTreeNode
                  key={s.span_id}
                  span={s}
                  defaultOpen={false}
                  selectedSpanId={selectedSpanId}
                  onSelect={onSelect}
                  body={
                    toolChildren.length > 0 ? (
                      <div className="trace-tree-act-tools">
                        {toolChildren.map((tool) => (
                          <SpanTreeNode
                            key={tool.span_id}
                            span={tool}
                            selectedSpanId={selectedSpanId}
                            onSelect={onSelect}
                          />
                        ))}
                      </div>
                    ) : (
                      <div className="trace-empty">no tools</div>
                    )
                  }
                />
              );
            }
            return (
              <SpanTreeNode
                key={s.span_id}
                span={s}
                selectedSpanId={selectedSpanId}
                onSelect={onSelect}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

// 通用 span 节点（reasoning / act / tool / compress / bootstrap / loop / finalize）。
// `body` 允许 caller 注入自定义内容（LOOP 节点用它渲染 turns 列表）。
// span 本身默认 body 为空 —— 属性不是 span，不应该出现在 tree 上当子节点
// （之前 bug：展开 span 时把 `gen_ai.request.model` 等 attr 当 foldable tree
// node 渲染了，违反「gen_ai 不是 node 不应该挂在 tree 上」）。属性展示全部交给
// 右栏 DetailPanel。
function SpanTreeNode({
  span,
  selectedSpanId,
  onSelect,
  defaultOpen = false,
  body,
}: {
  span: TraceSpan;
  selectedSpanId: string | null;
  onSelect: (n: DetailNode) => void;
  defaultOpen?: boolean;
  body?: React.ReactNode;
}) {
  const [open, setOpen] = useOpen(defaultOpen);
  const dur = spanDuration(span);
  const toolName = span.kind === "tool" ? span.attributes?.[ATTR.TOOL_NAME] : undefined;

  return (
    <div
      className={
        "trace-tree-span" +
        (open ? " open" : "") +
        (selectedSpanId === span.span_id ? " selected" : "")
      }
    >
      <div
        className="trace-tree-span-head"
        onClick={(e) => {
          if ((e.target as HTMLElement).closest(".trace-chev")) return;
          onSelect({ kind: "span", span });
        }}
      >
        <Toggle open={open} onClick={() => setOpen((o) => !o)} />
        <span className={kindBadgeClass(span.kind)}>{span.kind}</span>
        <span className="trace-tree-span-name">
          {span.name}
          {toolName && <span className="trace-tree-span-subname">· {toolName}</span>}
        </span>
        <span className="mono trace-tree-span-id">{span.span_id}</span>
        {dur != null && <span className="trace-tree-span-dur">{fmtMs(dur)}</span>}
        {span.status !== "ok" && (
          <span className={"trace-tree-span-status trace-tree-span-status-" + span.status}>
            {span.status}
          </span>
        )}
      </div>
      {open && body != null && (
        <div className="trace-tree-span-body">{body}</div>
      )}
    </div>
  );
}

// ---- Run header（顶部展开的 Run 节点）----

function RunHeader({
  run,
  allTurnsOpen,
  toggleAllTurns,
}: {
  run: TraceRun;
  allTurnsOpen: boolean;
  toggleAllTurns: () => void;
}) {
  const dur = run.end_ts ? run.end_ts - run.start_ts : null;
  return (
    <div className="trace-run-head">
      <div className="trace-run-title">
        <span className="trace-run-label">RUN</span>
        <span className="mono trace-run-id">{run.run_id}</span>
        <span className={"trace-run-status trace-run-status-" + run.status}>{run.status}</span>
      </div>
      <div className="trace-run-meta">
        <span>{run.turns.length} turn(s)</span>
        {dur != null && <span>{fmtMs(Math.round(dur * 1000))}</span>}
        <span>{fmtTime(run.start_ts)}</span>
        <span className="trace-run-schema">schema v{run.schema_version}</span>
      </div>
      <div className="trace-run-user">"{run.user_text}"</div>
      <div className="trace-run-actions">
        <button className="trace-action" onClick={toggleAllTurns}>
          {allTurnsOpen ? "collapse all turns" : "expand all turns"}
        </button>
      </div>
    </div>
  );
}

// ---- Drawer root ----

type FlatSpan = TraceSpan & { __parent: DetailNode };

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
  // 当前选中节点；初始默认选中 Run 节点
  const [selected, setSelected] = useState<DetailNode>({ kind: "run" });
  // 受控的 turn 展开集合（lifted state，让 "expand all turns" 按钮能联动）。
  // 不用 Set<string> 直接 update 是为了 React reference 稳定触发 re-render。
  const [openTurnIds, setOpenTurnIds] = useState<Set<string>>(() => new Set());
  const allTurnsOpen =
    !!run && run.turns.length > 0 && run.turns.every((t) => openTurnIds.has(t.turn_id));
  const toggleTurn = (turnId: string) => {
    setOpenTurnIds((prev) => {
      const next = new Set(prev);
      if (next.has(turnId)) next.delete(turnId);
      else next.add(turnId);
      return next;
    });
  };
  const toggleAllTurns = () => {
    if (!run) return;
    if (allTurnsOpen) {
      setOpenTurnIds(new Set());
    } else {
      setOpenTurnIds(new Set(run.turns.map((t) => t.turn_id)));
    }
  };

  useEffect(() => {
    if (!runId) {
      setRun(null);
      setError(null);
      setSelected({ kind: "run" });
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setRun(null);
    setSelected({ kind: "run" });
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

  // 所有 span 按 parent_id 走到的 span_id map（用于 jump-to-span 找 span 对象）。
  const spanById = useMemo(() => {
    const m = new Map<string, TraceSpan>();
    if (!run) return m;
    for (const s of run.spans) m.set(s.span_id, s);
    for (const t of run.turns) for (const s of t.spans) m.set(s.span_id, s);
    return m;
  }, [run]);

  const jumpToSpan = (spanId: string) => {
    const s = spanById.get(spanId);
    if (!s) return;
    setSelected({ kind: "span", span: s });
  };

  return (
    <>
      <div
        className={"trace-scrim" + (open ? " open" : "")}
        onClick={onClose}
        aria-hidden={!open}
      />
      <aside className={"trace-drawer" + (open ? " open" : "")} aria-hidden={!open}>
        <header className="trace-drawer-head">
          <span className="trace-drawer-title">TRACE</span>
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
            <div className="trace-split">
              {/* LEFT: tree */}
              <div className="trace-tree-pane">
                <RunHeader
                  run={run}
                  allTurnsOpen={allTurnsOpen}
                  toggleAllTurns={toggleAllTurns}
                />
                {/* run-level phase spans (bootstrap / loop / finalize)：
                    LOOP 节点 defaultOpen=true，body 渲染 turns 列表（嵌套结构）。
                    bootstrap / finalize 没 body，正常 defaultOpen=false。 */}
                {run.spans.length > 0 && (
                  <div className="trace-tree-section">
                    <div className="trace-tree-section-title">PHASE</div>
                    {run.spans.map((s) => {
                      if (s.kind === "loop") {
                        return (
                          <SpanTreeNode
                            key={s.span_id}
                            span={s}
                            defaultOpen={true}
                            selectedSpanId={
                              selected.kind === "span" ? selected.span.span_id : null
                            }
                            onSelect={setSelected}
                            body={
                              run.turns.length > 0 ? (
                                <div className="trace-tree-loop-turns">
                                  {run.turns.map((t, i) => (
                                    <TurnNode
                                      key={t.turn_id}
                                      turn={t}
                                      index={i + 1}
                                      open={openTurnIds.has(t.turn_id)}
                                      onToggle={() => toggleTurn(t.turn_id)}
                                      selectedSpanId={
                                        selected.kind === "span" ? selected.span.span_id : null
                                      }
                                      onSelect={setSelected}
                                    />
                                  ))}
                                </div>
                              ) : (
                                <div className="trace-empty">no turns</div>
                              )
                            }
                          />
                        );
                      }
                      return (
                        <SpanTreeNode
                          key={s.span_id}
                          span={s}
                          selectedSpanId={selected.kind === "span" ? selected.span.span_id : null}
                          onSelect={setSelected}
                        />
                      );
                    })}
                  </div>
                )}
                {/* 没 phase spans 但有 turns（罕见）：退化布局，直接把 turns 放 PHASE 区 */}
                {run.spans.length === 0 && run.turns.length > 0 && (
                  <div className="trace-tree-section">
                    <div className="trace-tree-section-title">PHASE</div>
                    {run.turns.map((t, i) => (
                      <TurnNode
                        key={t.turn_id}
                        turn={t}
                        index={i + 1}
                        open={openTurnIds.has(t.turn_id)}
                        onToggle={() => toggleTurn(t.turn_id)}
                        selectedSpanId={selected.kind === "span" ? selected.span.span_id : null}
                        onSelect={setSelected}
                      />
                    ))}
                  </div>
                )}
                {run.turns.length === 0 && run.spans.length === 0 && (
                  <div className="trace-empty">no spans</div>
                )}
              </div>
              {/* RIGHT: detail */}
              <div className="trace-detail-pane">
                <DetailPanel
                  node={selected}
                  run={run}
                  onJumpToSpan={(id) => {
                    jumpToSpan(id);
                  }}
                />
              </div>
            </div>
          )}
        </div>
      </aside>
    </>
  );
}