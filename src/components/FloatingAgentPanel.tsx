// FloatingAgentPanel — 选中片段后弹出的浮窗 agent 会话（spec §2.4）。
//
// 结构：header（drag） + context (snippet + parent) + Conversation（复用） + composer
// - 复用 StreamEngine：新 session 走同一份 engine，session_key 路由（#74 / #78 不变量）
// - Conversation 内部 bindScroll + msgs-driven 自动滚到底：跟主对话一致
// - 空态（msgs=0）由上方的 snippet section 兜底，不会看到主对话的 welcome
// - Esc 关闭，× 关闭，⤢ Expand 切到主视图
// - 拖拽 header 改变面板位置（屏幕内 clamp）

import { useEffect, useRef, useState } from "react";
import { Conversation } from "./Conversation";
import type { StreamEngine } from "../stream/engine";
import type { Msg } from "../stream/engine";
import type { Attachment } from "../ws/protocol";

interface FloatingAgentPanelProps {
  parentTitle: string;
  parentKey: string;
  parentLastMsg: string | null;
  snippet: string;
  forkKey: string;
  forkTitle: string;
  engine: StreamEngine;
  msgs: Msg[];
  onSend: (text: string, attachments?: Attachment[]) => void;
  onClose: () => void;
  onExpand: () => void;
}

const PANEL_DEFAULT_OFFSET = { x: 0, y: 0 };
const DRAG_THRESHOLD = 4; // px：低于此距离视为 click 不触发 drag

export function FloatingAgentPanel({
  parentTitle,
  parentKey,
  parentLastMsg,
  snippet,
  forkKey,
  forkTitle,
  engine,
  msgs,
  onSend,
  onClose,
  onExpand,
}: FloatingAgentPanelProps) {
  const [offset, setOffset] = useState(PANEL_DEFAULT_OFFSET);
  const dragRef = useRef<{
    startX: number;
    startY: number;
    baseX: number;
    baseY: number;
    moved: boolean;
  } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // 拖拽 header
  function onHeaderMouseDown(e: React.MouseEvent) {
    if (e.button !== 0) return;
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      baseX: offset.x,
      baseY: offset.y,
      moved: false,
    };
    e.preventDefault();
  }
  useEffect(() => {
    function onMove(e: MouseEvent) {
      const d = dragRef.current;
      if (!d) return;
      const dx = e.clientX - d.startX;
      const dy = e.clientY - d.startY;
      if (!d.moved && Math.abs(dx) + Math.abs(dy) < DRAG_THRESHOLD) return;
      d.moved = true;
      const panel = panelRef.current;
      if (!panel) return;
      // 屏幕内 clamp：左上右下都留 8px
      const w = panel.offsetWidth;
      const h = panel.offsetHeight;
      const maxX = window.innerWidth - w - 8;
      const maxY = window.innerHeight - h - 8;
      const nextX = Math.max(8 - w * 0.3, Math.min(maxX, d.baseX + dx));
      const nextY = Math.max(8 - 60, Math.min(maxY, d.baseY + dy));
      setOffset({ x: nextX, y: nextY });
    }
    function onUp() {
      const d = dragRef.current;
      if (!d) return;
      dragRef.current = null;
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
  }, []);

  // Esc 关闭
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      ref={panelRef}
      className="floating-panel"
      style={{ transform: `translate(${offset.x}px, ${offset.y}px)` }}
    >
      {/* header —— 可拖拽区域 */}
      <div
        className="floating-panel-header"
        onMouseDown={onHeaderMouseDown}
        title={dragRef.current?.moved ? "" : "Drag to move"}
      >
        <div className="floating-panel-title-wrap">
          <span className="floating-panel-kicker">FORK</span>
          <span className="floating-panel-title" title={forkTitle}>{forkTitle}</span>
        </div>
        <div className="floating-panel-actions">
          <button
            className="icon-btn-round-mini"
            title="expand to full view"
            aria-label="expand to full view"
            onClick={onExpand}
            type="button"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
              <path d="M3 9v3a1 1 0 001 1h3M13 9V7a1 1 0 00-1-1H9M3 7V4M13 7v0" />
              <path d="M3 3l3 3M13 13l-3-3" />
            </svg>
          </button>
          <button
            className="icon-btn-round-mini"
            title="close (Esc)"
            aria-label="close floating panel"
            onClick={onClose}
            type="button"
          >
            <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6">
              <path d="M3 3l6 6M9 3l-6 6" />
            </svg>
          </button>
        </div>
      </div>

      {/* context —— snippet + 可折叠 parent */}
      <div className="floating-panel-context">
        <div className="snippet-quote">
          <div className="snippet-label">SELECTED</div>
          <div className="snippet-text">{snippet}</div>
        </div>
        {parentLastMsg && (
          <details className="parent-context">
            <summary>From {parentTitle}</summary>
            <div className="parent-msg">{parentLastMsg}</div>
            <div className="parent-key">session: {parentKey}</div>
          </details>
        )}
      </div>

      {/* stream —— 复用 Conversation（同一份 engine + session_key 路由） */}
      <div className="floating-panel-stream">
        {msgs.length === 0 ? (
          <div className="panel-stream-hint">
            <div className="hint-kicker">FORKED SESSION</div>
            <div className="hint-text">在下方输入你的追问，agent 会基于上面的片段回答</div>
          </div>
        ) : (
          <Conversation
            sessionKey={forkKey}
            msgs={msgs}
            engine={engine}
            onSend={onSend}
          />
        )}
      </div>

      {/* composer —— 简化版，textarea + send */}
      <PanelComposer onSend={onSend} />
    </div>
  );
}

function PanelComposer({ onSend }: { onSend: (text: string, attachments?: Attachment[]) => void }) {
  const [text, setText] = useState("");
  const taRef = useRef<HTMLTextAreaElement>(null);

  function submit() {
    const t = text.trim();
    if (!t) return;
    onSend(t);
    setText("");
    taRef.current?.focus();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  return (
    <div className="panel-composer">
      <textarea
        ref={taRef}
        className="panel-composer-input"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="追问这个片段..."
        rows={1}
      />
      <button
        className="panel-composer-send"
        onClick={submit}
        disabled={!text.trim()}
        title="send (Enter)"
        aria-label="send"
        type="button"
      >
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M2 8h11M9 4l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
    </div>
  );
}