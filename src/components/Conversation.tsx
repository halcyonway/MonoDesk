import { memo, useEffect, useRef, useState } from "react";
import type { StreamEngine, Msg, Child } from "../stream/engine";
import { fmtMs, renderMarkdown } from "../stream/markdown";
import type { Attachment } from "../ws/protocol";
import { TaskBlock } from "./TaskBlock";

// fork/cancel/poll 走 TaskBlock（live 状态 + cross-link）；其余工具走通用 ToolBlock
const TASK_TOOL_NAMES = new Set(["fork_task", "cancel_task", "poll_task"]);

// ---- 流式文本块 ----
// 有 text（冻结 / 历史恢复）→ 静态渲染；无 text（正在流式）→ 引擎直接写 innerHTML。

// ---- 流式文本块 ----
// 有 text（冻结 / 历史恢复）→ 静态渲染；无 text（正在流式）→ 引擎直接写 innerHTML。

const TextStream = memo(function TextStream({
  engine,
  sessionKey,
  text,
}: {
  engine: StreamEngine;
  sessionKey: string;
  text?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (text === undefined) {
      engine.bindAssistant(sessionKey, ref.current);
      return () => engine.bindAssistant(sessionKey, null);
    }
  }, [engine, sessionKey, text]);
  if (text !== undefined) {
    return <div className="stream" dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />;
  }
  return <div className="stream streaming" ref={ref} />;
});

// ---- 推理块：head（label+meta）+ body ----
// 有 text → 静态（默认折叠）；无 text → live（引擎写 body，结束后自动折叠）。

const ReasonBlock = memo(function ReasonBlock({
  engine,
  sessionKey,
  id,
  text,
}: {
  engine: StreamEngine;
  sessionKey: string;
  id: string;
  text?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(text === undefined);

  useEffect(() => {
    if (text !== undefined) {
      setOpen(false); // 冻结后自动折叠
      return;
    }
    const container = containerRef.current;
    const head = headRef.current;
    const body = bodyRef.current;
    if (container && head && body) {
      engine.bindReasoning(sessionKey, { id, container, head, body });
    }
    return () => engine.unbindReasoning(sessionKey);
  }, [engine, sessionKey, id, text]);

  return (
    <div className={"block reasoning" + (open ? " open" : "")} ref={containerRef}>
      <div
        className="block-head"
        ref={headRef}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="label"><span className="r-dot" />thinking</span>
        <span className="meta">{text !== undefined ? text.length + " chars" : ""}</span>
        <span className="spacer" />
        <svg className="chev" viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 5l3 3 3-3" /></svg>
      </div>
      <div className="block-body" ref={bodyRef}>
        {text !== undefined ? text : ""}
      </div>
    </div>
  );
});

// ---- 工具块：running 时本地计时，done 时自动折叠展示结果 ----

// doc-thumb 视觉跟 composer 预览保持一致：72×72 方形 box，居中放 mime 专门
// icon + 大写 mime label（PDF / CSV / JSON / TXT / MD）。不用 emoji —— emoji
// 在 macOS / Tauri WebView / 不同字体下渲染不一致（用户截图里 📄 显示成
// broken 方块）；不用文件名 —— server 命名是 uuid hex（`6ee51565534346c1a675f8d3683075ce.pdf`）
// 一长串是 noise，不如直接告诉用户这是 PDF。
//
// icon 是 inline SVG：通用 document 轮廓 + 不同 mime 的细节（PDF：折叠角 +
// 红色条；CSV/JSON/TXT/MD：横线代表内容行）。颜色走 var(--text-faint) /
// var(--accent) 让 light/dark theme 自动跟随。

function docLabelFor(mime: string): string {
  if (mime === "application/pdf") return "PDF";
  if (mime === "application/json") return "JSON";
  if (mime === "text/csv") return "CSV";
  if (mime === "text/markdown") return "MD";
  if (mime === "text/plain") return "TXT";
  // 兜底：取 mime 子类型首段大写
  const sub = mime.split("/")[1] || "FILE";
  return sub.toUpperCase().slice(0, 4);
}

function docIconFor(mime: string) {
  const common = {
    viewBox: "0 0 48 48",
    width: 36,
    height: 36,
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    className: "doc-thumb-svg",
  };
  if (mime === "application/pdf") {
    // document + folded corner + 红色 PDF 横幅
    return (
      <svg {...common}>
        <path d="M14 6h14l8 8v28a2 2 0 0 1-2 2H14a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z" />
        <path d="M28 6v8h8" />
        <rect x="14" y="26" width="20" height="14" rx="1.5" fill="var(--accent-soft)" stroke="var(--accent)" />
        <text x="24" y="36" textAnchor="middle" fontSize="8" fontWeight="700" fill="var(--accent)" stroke="none">
          PDF
        </text>
      </svg>
    );
  }
  // 其它：document + 折角 + 横线代表文本内容
  return (
    <svg {...common}>
      <path d="M14 6h14l8 8v28a2 2 0 0 1-2 2H14a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z" />
      <path d="M28 6v8h8" />
      <line x1="17" y1="22" x2="33" y2="22" />
      <line x1="17" y1="28" x2="33" y2="28" />
      <line x1="17" y1="34" x2="27" y2="34" />
    </svg>
  );
}

// bash tool 专用：args 是 JSON 字符串，从中提取 LLM 填的 `target` 字段。
// 优先级：target（设计意图）> cmd（fallback，截断后的 bash 命令）。
// 长度上限 30 字符（用户原话「10 字以内」≈ 30 ASCII），超出加 …
// 返回 null → UI 不渲染。
function bashSummary(args: string | undefined): string | null {
  if (!args) return null;
  let obj: { target?: unknown; cmd?: unknown } | null = null;
  try {
    obj = JSON.parse(args);
  } catch {
    return null;
  }
  const t = typeof obj?.target === "string" ? obj.target.trim() : "";
  const MAX = 30;
  if (t) return t.length > MAX ? t.slice(0, MAX) + "…" : t;
  // fallback：target 没填就用 cmd，空白合并
  const c = typeof obj?.cmd === "string" ? obj.cmd.replace(/\s+/g, " ").trim() : "";
  if (!c) return null;
  return c.length > MAX ? c.slice(0, MAX) + "…" : c;
}

function ToolBlock({ child }: { child: Extract<Child, { kind: "tool" }> }) {
  const [elapsed, setElapsed] = useState(0);
  const running = child.state === "running";
  // "pending" = ToolPending 刚到、args 还没齐；UI 用 ellipsis 占位 + 不同 badge，
  // 让用户立刻看到「开始调这个工具了」而不是「等」。
  const pending = running && !child.args;
  const [open, setOpen] = useState(running);

  useEffect(() => {
    if (!running) return;
    setElapsed(0);
    const t = setInterval(() => setElapsed((e) => e + 100), 100);
    return () => clearInterval(t);
  }, [running]);

  // running → done 时自动折叠
  useEffect(() => {
    if (!running) setOpen(false);
  }, [running]);

  const r = child.result;
  const badge = pending
    ? "starting"
    : child.state === "running"
    ? "running"
    : r?.status === "ok"
    ? "ok"
    : r?.status ?? "done";

  return (
    <div className={"block tool " + (running ? "running" : "done") + (open ? " open" : "") + (pending ? " pending" : "")}>
      <div className="block-head" onClick={() => setOpen((v) => !v)}>
        <span className="label"><span className="t-dot" />{child.name}</span>
        {/* bash tool 专属：在 label 旁展示 LLM 填的 target（人类可读的一句话总结），
            超过 30 字符前端截断（+ …），让长 tool 序列里一眼看到「这条 bash 在干啥」。
            其它 tool 不渲染。child.args 全量保留在折叠 body 里，head 只显示 target。 */}
        {child.name === "bash" && (() => {
          const summary = bashSummary(child.args);
          return summary ? <span className="t-summary" title={summary}>{summary}</span> : null;
        })()}
        {/* #polish: 删除 t-args 显示 —— args 在 mono 截断显示里看不出有用信息（fork_task
            description 长文本 / bash 命令截断后无意义）。child.args 字段保留，折叠展开 body 仍可见
            （与 fork_task 等 task tool 一致）；header 只剩 name + badge + latency。 */}
        <span className="spacer" />
        <span className={"t-badge " + badge}>{badge}</span>
        <span className="t-latency">
          {running ? fmtMs(elapsed) : child.latencyMs != null ? fmtMs(child.latencyMs) : ""}
        </span>
        <svg className="chev" viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 5l3 3 3-3" /></svg>
      </div>
      {!running && r && (
        <div className="block-body">
          <div className="tool-result">
            {(r.stdout || "").length > 0 && <pre>{r.stdout}</pre>}
            {r.status === "error" && (r.stderr || "").length > 0 && (
              <pre className="stderr">{r.stderr}</pre>
            )}
            {r.truncated && <div className="trunc">… truncated (budget: {r.budget_id || "-"})</div>}
          </div>
        </div>
      )}
    </div>
  );
}

// ---- 度量脚注 / 错误块 ----

function NoteBlock({ text }: { text: string }) {
  return <div className="metric-note">{text}</div>;
}

function ErrorBlock({ text }: { text: string }) {
  return (
    <div className="block error">
      <div className="error-msg">❌ {text}</div>
    </div>
  );
}

function ChildView({
  child,
  engine,
  sessionKey,
  onOpenTask,
}: {
  child: Child;
  engine: StreamEngine;
  sessionKey: string;
  onOpenTask?: (taskId: string) => void;
}) {
  switch (child.kind) {
    case "reasoning":
      return <ReasonBlock engine={engine} sessionKey={sessionKey} id={child.id} text={child.text} />;
    case "text":
      return <TextStream engine={engine} sessionKey={sessionKey} text={child.text} />;
    case "tool":
      return TASK_TOOL_NAMES.has(child.name) ? (
        <TaskBlock child={child} onOpenTask={onOpenTask} />
      ) : (
        <ToolBlock child={child} />
      );
    case "note":
      return <NoteBlock text={child.text} />;
    case "error":
      return <ErrorBlock text={child.text} />;
  }
}

function MsgView({
  msg,
  engine,
  sessionKey,
  onInspectRun,
  onOpenTask,
}: {
  msg: Msg;
  engine: StreamEngine;
  sessionKey: string;
  onInspectRun?: (runId: string) => void;
  onOpenTask?: (taskId: string) => void;
}) {
  if (msg.role === "user") {
    // Fork session 首条 user msg 把 snippet + parent context 拼到 text 里发给 agent，
    // UI 不显示那坨 prefix —— 只显示用户实际输入的纯净问题（msg.forkQuestion）。
    // 带 ⓘ 图标表示「这条消息带了 context（见面板顶部）」。
    const displayText = msg.forkQuestion ?? msg.text;
    return (
      <div className={"msg user" + (msg.forkQuestion ? " fork" : "")}>
        <div className="label">
          You
          {msg.forkQuestion && (
            <span className="msg-fork-tag" title="This message includes the selected snippet + parent context (shown above)">
              ⓘ context attached
            </span>
          )}
        </div>
        <div className="bubble">
          {displayText && <p>{displayText}</p>}
          {msg.attachments && msg.attachments.length > 0 && (
            <div className="msg-attachments">
              {msg.attachments.map((a) => {
                // Tauri desktop 用 convertFileSrc 把本地路径转成 asset:// URL，
                // 浏览器可以 <img src> 渲染；非 Tauri（dev browser）直接用 file:// 兜底。
                const src = (window as any).__TAURI__?.core?.convertFileSrc
                  ? (window as any).__TAURI__.core.convertFileSrc(a.path)
                  : `file://${a.path}`;
                return (
                <div key={a.path} className="msg-attachment-thumb">
                  {a.mime.startsWith("image/") ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={src} alt={a.name} title={a.name} />
                  ) : (
                    <a
                      className="doc-thumb"
                      href={src}
                      target="_blank"
                      rel="noreferrer"
                      title={`${a.name} (${a.mime})`}
                    >
                      {docIconFor(a.mime)}
                      <div className="doc-thumb-meta">
                        <span className="doc-thumb-name">{a.name}</span>
                        <span className="doc-thumb-label">{docLabelFor(a.mime)}</span>
                      </div>
                    </a>
                  )}
                </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    );
  }
  const showTrace = !!(msg.runId && onInspectRun);
  return (
    <div className="msg assistant">
      <div className="label">
        <span>Agent</span>
        {msg.tokens && msg.tokens.completion > 0 && (
          <span className="msg-meta-tokens">
            {msg.tokens.completion.toLocaleString()} tok
          </span>
        )}
        {typeof msg.latencyMs === "number" && msg.latencyMs > 0 && (
          <span className="msg-meta-lat">{fmtMs(msg.latencyMs)}</span>
        )}
        {msg.tokens && cacheHitRatio(msg.tokens) != null && (
          <span className="msg-meta-cache" title="prompt cache hit ratio">
            ⚡ {fmtPct(cacheHitRatio(msg.tokens)!)}
          </span>
        )}
        {showTrace && (
          <button
            className="trace-btn"
            title="查看 trace"
            onClick={() => msg.runId && onInspectRun?.(msg.runId)}
          >
            <svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.6">
              <circle cx="3.5" cy="3.5" r="1.2" />
              <circle cx="8.5" cy="3.5" r="1.2" />
              <circle cx="6" cy="8.5" r="1.2" />
              <path d="M4 4.5L5 7M8 4.5L7 7" />
            </svg>
            <span>trace</span>
          </button>
        )}
      </div>
      <div className="stream">
        {msg.pending && msg.children.length === 0 ? (
          <div className="msg-pending">
            <span className="pending-dot" />
            <span className="pending-dot" />
            <span className="pending-dot" />
          </div>
        ) : (
          msg.children.map((c) => (
            <ChildView
              key={c.id}
              child={c}
              engine={engine}
              sessionKey={sessionKey}
              onOpenTask={onOpenTask}
            />
          ))
        )}
      </div>
    </div>
  );
}

// 缓存命中率：cached_tokens / prompt_tokens。
//   cached 缺失（LLM 没返回这个字段）→ 返回 null → UI 隐藏 pill
//   cached = 0（LLM 返回了但命中 0）→ 也返回 null → UI 隐藏 pill（避免 0.0% 噪声）
//   cached > 0 → 返回命中率 → UI 显示 ⚡ X.X%
function cacheHitRatio(t: { prompt: number; completion: number; cached?: number }): number | null {
  if (t.prompt > 0 && typeof t.cached === "number" && t.cached > 0) {
    return t.cached / t.prompt;
  }
  return null;
}

function fmtPct(x: number): string {
  return (x * 100).toFixed(1) + "%";
}

const SUGGESTIONS = [
  "看看这个仓库的结构，帮我规划一个重构方案",
  "解释一下 core/loop 里的状态机是怎么流转的",
  "写一个 bash 脚本，统计每个文件的代码行数",
];

export function Conversation({
  sessionKey,
  msgs,
  engine,
  onSend,
  onInspectRun,
  onOpenTask,
}: {
  // #74: DOM 绑定（bindScroll / bindAssistant / bindReasoning）都按 sessionKey
  // 路由到对应 PerSessionStream。App 必须把当前 active session 传下来。
  sessionKey: string;
  msgs: Msg[];
  engine: StreamEngine;
  onSend: (text: string, attachments?: Attachment[]) => void;
  onInspectRun?: (runId: string) => void;
  onOpenTask?: (taskId: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    engine.bindScroll(sessionKey, scrollRef.current);
    return () => engine.bindScroll(sessionKey, null);
  }, [engine, sessionKey]);

  // 自动锚定底部并预留 composer 高度的呼吸空间（豆包式：回复和输入框之间留大片空白）。
  // 触发：每次 msgs 引用变化都跑 —— 这同时覆盖了三种场景：
  //   1) 启动加载历史（loadHistories 一次性把内容塞进 state）→ 自动滚到底
  //   2) 切会话（viewMsgs 引用变化）→ 自动滚到新会话底部
  //   3) 流式响应（每 flush 产生新 msgs 引用）→ 持续跟随 tail
  //   4) 用户在底部时 msgs 不变 → effect 不跑；不会干扰已锚定的滚动位置
  //
  // 算法：
  //   - 内容不足一屏（scrollHeight <= clientHeight）→ 不滚；保留顶部对齐。
  //   - 内容溢出 → 滚到底 + 额外 140px（composer 高度 + 一行呼吸）。
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || msgs.length === 0) return;
    // 等一帧让 DOM 完成 layout（启动时 msgs 刚 set，可能还没绘制）
    const raf = requestAnimationFrame(() => {
      const e = scrollRef.current;
      if (!e) return;
      const overflow = e.scrollHeight - e.clientHeight;
      if (overflow <= 0) {
        e.scrollTop = 0;
        return;
      }
      e.scrollTop = overflow + 140;
    });
    return () => cancelAnimationFrame(raf);
  }, [msgs]);

  const empty = msgs.length === 0;

  return (
    <div id="conversation-wrap">
      <div id="conversation" ref={scrollRef}>
        {empty ? (
          <div id="empty">
            <div className="empty-kicker">MONODESK</div>
            <div className="empty-title">连接你的 MonoX 运行时</div>
            <div className="empty-sub">流式思维、工具调用与 agent 遥测，都在一个极简分栏里。</div>
            <div id="chips">
              {SUGGESTIONS.map((s) => (
                <div className="chip" key={s} onClick={() => onSend(s)}>
                  {s}
                </div>
              ))}
            </div>
          </div>
        ) : (
          msgs.map((m) => (
              <MsgView
                key={m.id}
                msg={m}
                engine={engine}
                sessionKey={sessionKey}
                onInspectRun={onInspectRun}
                onOpenTask={onOpenTask}
              />
            ))
        )}
      </div>
    </div>
  );
}
