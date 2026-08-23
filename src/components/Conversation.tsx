import { memo, useEffect, useRef, useState } from "react";
import type { StreamEngine, Msg, Child } from "../stream/engine";
import { fmtMs, renderMarkdown } from "../stream/markdown";

// ---- 流式文本块 ----
// 有 text（冻结 / 历史恢复）→ 静态渲染；无 text（正在流式）→ 引擎直接写 innerHTML。

const TextStream = memo(function TextStream({
  engine,
  text,
}: {
  engine: StreamEngine;
  text?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (text === undefined) {
      engine.bindAssistant(ref.current);
      return () => engine.bindAssistant(null);
    }
  }, [engine, text]);
  if (text !== undefined) {
    return <div className="stream" dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />;
  }
  return <div className="stream streaming" ref={ref} />;
});

// ---- 推理块：head（label+meta）+ body ----
// 有 text → 静态（默认折叠）；无 text → live（引擎写 body，结束后自动折叠）。

const ReasonBlock = memo(function ReasonBlock({
  engine,
  id,
  text,
}: {
  engine: StreamEngine;
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
      engine.bindReasoning({ id, container, head, body });
    }
    return () => engine.unbindReasoning();
  }, [engine, id, text]);

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

function ToolBlock({ child }: { child: Extract<Child, { kind: "tool" }> }) {
  const [elapsed, setElapsed] = useState(0);
  const running = child.state === "running";
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
  const badge =
    child.state === "running"
      ? "running"
      : r?.status === "ok"
      ? "ok"
      : r?.status ?? "done";

  return (
    <div className={"block tool " + (running ? "running" : "done") + (open ? " open" : "")}>
      <div className="block-head" onClick={() => setOpen((v) => !v)}>
        <span className="label"><span className="t-dot" />{child.name}</span>
        {child.args && <span className="t-args">{child.args}</span>}
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

function ChildView({ child, engine }: { child: Child; engine: StreamEngine }) {
  switch (child.kind) {
    case "reasoning":
      return <ReasonBlock engine={engine} id={child.id} text={child.text} />;
    case "text":
      return <TextStream engine={engine} text={child.text} />;
    case "tool":
      return <ToolBlock child={child} />;
    case "note":
      return <NoteBlock text={child.text} />;
    case "error":
      return <ErrorBlock text={child.text} />;
  }
}

function MsgView({ msg, engine }: { msg: Msg; engine: StreamEngine }) {
  if (msg.role === "user") {
    return (
      <div className="msg user">
        <div className="label">You</div>
        <div className="bubble">{msg.text}</div>
      </div>
    );
  }
  return (
    <div className="msg assistant">
      <div className="label">Agent</div>
      <div className="stream">
        {msg.children.map((c) => (
          <ChildView key={c.id} child={c} engine={engine} />
        ))}
      </div>
    </div>
  );
}

const SUGGESTIONS = [
  "看看这个仓库的结构，帮我规划一个重构方案",
  "解释一下 core/loop 里的状态机是怎么流转的",
  "写一个 bash 脚本，统计每个文件的代码行数",
];

export function Conversation({
  msgs,
  engine,
  onSend,
}: {
  msgs: Msg[];
  engine: StreamEngine;
  onSend: (text: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    engine.bindScroll(scrollRef.current);
    return () => engine.bindScroll(null);
  }, [engine]);

  // 自动锚定底部并预留 composer 高度的呼吸空间（豆包式：回复和输入框之间留大片空白）。
  // 1) 内容不足一屏（scrollHeight <= clientHeight）→ 内容被钉在视口顶部，最后一条
  //    消息下方留 ~半屏空白，让回复不被 composer 压住。
  // 2) 内容溢出 → 滚到真正底部再多留 ~140px（composer 高度 + 一行呼吸）。
  useEffect(() => {
    if (!engine.consumeScrollRequest()) return;
    const el = scrollRef.current;
    if (!el) return;
    const overflow = el.scrollHeight - el.clientHeight;
    if (overflow <= 0) {
      // 内容太短不够一屏：不滚，让内容留在顶部，最下方自然留出整片空白
      el.scrollTop = 0;
      return;
    }
    // 内容溢出：滚到底 + 额外 140px 留白
    el.scrollTop = overflow + 140;
  });

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
          msgs.map((m) => <MsgView key={m.id} msg={m} engine={engine} />)
        )}
      </div>
    </div>
  );
}
