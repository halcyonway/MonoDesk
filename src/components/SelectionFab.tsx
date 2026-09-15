// SelectionFab — 监听 #conversation 内的文本选中，浮出 "✦ Branch" 按钮。
//
// 实现要点：
// - selectionchange 事件在 document 上听，过滤 selection 是否在 #conversation 内
//   （用 anchorNode/focusNode 的 closest() 沿 DOM 树向上找）
// - 按钮位置 = selection.getRangeAt(0).getBoundingClientRect() 上方居中
// - 空选 / 全空白 / Esc / 滚动 → 隐藏
// - selection 文本经 trim() 后非空才显示
// - 不开 React state per selectionchange（节流到 rAF 一次）—— 不需要 Re-render
//
// 这是纯 DOM 组件，没有 React state 用作渲染输出；唯一 React state 是 visible。
// 位置计算在 effect 里直接读 selection + setStyle，避免触发 re-render。

import { useEffect, useRef, useState } from "react";

interface SelectionFabProps {
  onBranch: (text: string) => void;
  /** 选择锚点 ancestor 必须匹配的 selector；默认 `#conversation` */
  scopeSelector?: string;
}

const SCOPE_DEFAULT = "#conversation";
const HIDE_AFTER_MS = 0; // 0 = 不自动消失，仅 scroll / esc / 空选 触发隐藏
const FAB_WIDTH = 32;
const FAB_HEIGHT = 32;
const FAB_OFFSET_Y = 8; // 距 selection 上方

export function SelectionFab({ onBranch, scopeSelector = SCOPE_DEFAULT }: SelectionFabProps) {
  const fabRef = useRef<HTMLButtonElement>(null);
  const [visible, setVisible] = useState(false);
  // 缓存当前 text + rect —— click handler 直接读，避免 stale closure
  const pendingRef = useRef<{ text: string; rect: DOMRect } | null>(null);

  useEffect(() => {
    let raf = 0;

    function isInsideScope(node: Node | null): boolean {
      if (!node) return false;
      const el = (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement) as Element | null;
      if (!el) return false;
      // closest 会沿 parentElement 链向上查
      return !!el.closest(scopeSelector);
    }

    function compute() {
      raf = 0;
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) {
        setVisible(false);
        return;
      }
      // 过滤：必须 selection 在 #conversation 内
      if (!isInsideScope(sel.anchorNode) || !isInsideScope(sel.focusNode)) {
        setVisible(false);
        return;
      }
      const text = sel.toString().trim();
      if (!text) {
        setVisible(false);
        return;
      }
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) {
        setVisible(false);
        return;
      }
      pendingRef.current = { text, rect };
      // 直接写位置（不走 React state —— 每帧触发 re-render 不必要）
      const btn = fabRef.current;
      if (btn) {
        const left = rect.left + rect.width / 2 - FAB_WIDTH / 2;
        const top = rect.top - FAB_HEIGHT - FAB_OFFSET_Y;
        btn.style.transform = `translate(${left}px, ${top}px)`;
      }
      setVisible(true);
    }

    function schedule() {
      if (raf) return;
      raf = requestAnimationFrame(compute);
    }

    function onScroll() {
      // 用户滚动时收起按钮（selection 已经跟元素错位）
      setVisible(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setVisible(false);
    }
    function onMouseDown(e: MouseEvent) {
      // 点 fab 本身不算 outside；但点别的元素会清 selection —— 让原生行为处理
      if (fabRef.current && fabRef.current.contains(e.target as Node)) return;
      // 延迟到 mouseup（不要在 mousedown 立刻藏，用户可能正在新位置开始 selection）
    }

    document.addEventListener("selectionchange", schedule);
    document.addEventListener("scroll", onScroll, true); // capture: 任何内部 scroll 都触发
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onMouseDown);
    return () => {
      document.removeEventListener("selectionchange", schedule);
      document.removeEventListener("scroll", onScroll, true);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onMouseDown);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [scopeSelector]);

  function handleClick() {
    const p = pendingRef.current;
    if (!p) return;
    onBranch(p.text);
    // 清掉 selection 让按钮消失
    window.getSelection()?.removeAllRanges();
    setVisible(false);
  }

  return (
    <button
      ref={fabRef}
      type="button"
      className={"selection-fab" + (visible ? " visible" : "")}
      onMouseDown={(e) => e.preventDefault()} // 防止 click 抢走 selection
      onClick={handleClick}
      title="Branch into floating agent session"
      aria-label="branch into floating agent session"
      // 初始位置：屏幕外左上，避免未 compute 时闪烁在 (0,0)
      style={{ transform: "translate(-9999px, -9999px)" }}
    >
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
        {/* sparkle / branch icon —— 四角 + 中心小点 */}
        <path d="M3 1l1 3M3 1l-1 3M3 1l3 1M3 1l-3 1" strokeLinecap="round" />
        <path d="M13 8l1 3M13 8l-1 3M13 8l3 1M13 8l-3 1" strokeLinecap="round" />
        <circle cx="8" cy="8" r="1.2" fill="currentColor" />
      </svg>
    </button>
  );
}