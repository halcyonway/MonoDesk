import { memo, useEffect, useRef, useState } from "react";
import type { StreamEngine, Msg, Child } from "../stream/engine";
import { fmtMs } from "../stream/markdown";

// ---- 流式文本块：引擎直接写 innerHTML，React 只负责挂载空容器 ----

const TextStream = memo(function TextStream({
  engine,
}: {
  engine: StreamEngine;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    engine.bindAssistant(ref.current);
    return () => engine.bindAssistant(null);
  }, [engine]);
  return <div className="stream" ref={ref} />;
});

// ---- 推理块：head（label+meta）+ body（引擎写 innerHTML）----

const ReasonBlock = memo(function ReasonBlock({
  engine,
}: {
  engine: StreamEngine;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    const head = headRef.current;
    const body = bodyRef.current;
    if (container && head && body) {
      engine.bindReasoning({ container, head, body });
    }
    return () => engine.unbindReasoning();
  }, [engine]);

  return (
    <div className="block reasoning open" ref={containerRef}>
      <div
        className="block-head"
        ref={headRef}
        onClick={() => containerRef.current?.classList.toggle("open")}
      >
        <span className="r-dot" />
        <span className="label">thinking</span>
        <span className="meta" />
        <span className="spacer" />
        <span className="chev">▾</span>
      </div>
      <div className="block-body" ref={bodyRef} />
    </div>
  );
});

// ---- 工具块：running 时本地计时，done 时展示结果 ----

function ToolBlock({ child }: { child: Extract<Child, { kind: "tool" }> }) {
  const [elapsed, setElapsed] = useState(0);
  const [open, setOpen] = useState(true);
  const running = child.state === "running";

  useEffect(() => {
    if (!running) return;
    setElapsed(0);
    const t = setInterval(() => setElapsed((e) => e + 100), 100);
    return () => clearInterval(t);
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
        <span className="t-dot" />
        <span className="label">{child.name}</span>
        {child.args && <span className="t-args">{child.args}</span>}
        <span className="spacer" />
        <span className={"t-badge " + badge}>{badge}</span>
        <span className="t-latency">
          {running ? fmtMs(elapsed) : child.latencyMs != null ? fmtMs(child.latencyMs) : ""}
        </span>
        <span className="chev">▾</span>
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
      return <ReasonBlock engine={engine} />;
    case "text":
      return <TextStream engine={engine} />;
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

  const empty = msgs.length === 0;

  return (
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
  );
}
