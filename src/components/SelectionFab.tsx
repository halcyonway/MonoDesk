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

  // 初始 transform：放到屏幕外。**不要写在 JSX inline style**——
  // React 每次 re-render 都会把 inline style 写回 DOM，把我们 effect 里通过
  // setStyle 写的真实位置冲掉，导致按钮被 React 反复重置。
  // 直接用 ref 在 mount 后写 DOM，之后只通过 effect 更新 DOM transform。
  useEffect(() => {
    const btn = fabRef.current;
    if (btn) btn.style.transform = "translate(-9999px, -9999px)";
  }, []);

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
      // 点 fab 本身：阻止 selection 收缩（mousedown 会清掉 selection，
      // 触发 selectionchange → compute → 按钮重定位，导致 mouseup 落在别处）。
      // preventDefault 阻止默认 selection-clear，让 click 顺利触发。
      if (fabRef.current && fabRef.current.contains(e.target as Node)) {
        e.preventDefault();
        return;
      }
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
      onClick={handleClick}
      title="Branch into floating agent session"
      aria-label="branch into floating agent session"
    >
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        {/* 左节点 + 主干 + 上下分叉 + 末端实心点 —— 像 git fork graph */}
        <circle cx="4.5" cy="10" r="1.4" fill="currentColor" stroke="none" />
        <path d="M6 10h7" />
        <path d="M9.5 10c0-2 1.5-3.2 3.5-3.2" />
        <path d="M9.5 10c0 2 1.5 3.2 3.5 3.2" />
        <circle cx="13" cy="6.8" r="1.2" fill="currentColor" stroke="none" />
        <circle cx="13" cy="13.2" r="1.2" fill="currentColor" stroke="none" />
      </svg>
    </button>
  );
}