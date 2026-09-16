// SelectionFab 单测 —— 选中检测 + 浮出按钮的可见性。
// jsdom 不完整实现 Selection API，所以用 mock getSelection + 直接 dispatch event
// 触发组件的 selectionchange handler。

import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render } from "@testing-library/react";
import { SelectionFab } from "./SelectionFab";

function makeFakeSelection(opts: {
  text: string;
  insideConversation: boolean;
  rect?: DOMRect;
}): Selection {
  const range = {
    getBoundingClientRect: () => opts.rect ?? ({ left: 100, top: 50, width: 200, height: 20, right: 300, bottom: 70, x: 100, y: 50, toJSON: () => "" } as DOMRect),
  } as unknown as Range;
  // anchorNode / focusNode 必须 .closest('#conversation') 返回 truthy 才算 inside
  const targetNode = opts.insideConversation
    ? document.getElementById("conversation")!.firstChild!
    : document.body.firstChild ?? document.body;
  return {
    rangeCount: 1,
    toString: () => opts.text,
    getRangeAt: () => range,
    anchorNode: targetNode,
    focusNode: targetNode,
    removeAllRanges: vi.fn(),
    addRange: () => {},
    removeRange: () => {},
    collapse: () => {},
    extend: () => {},
    selectAllChildren: () => {},
    toString2: () => opts.text,
    isCollapsed: false,
    type: "Range",
  } as unknown as Selection;
}

function dispatchSelectionChange() {
  document.dispatchEvent(new Event("selectionchange"));
}

describe("SelectionFab", () => {
  it("初始不显示（无 selection）", () => {
    document.body.innerHTML = '<div id="conversation">hello</div>';
    const { container } = render(<SelectionFab onBranch={() => {}} />);
    const btn = container.querySelector(".selection-fab")!;
    expect(btn.classList.contains("visible")).toBe(false);
  });

  it("空选 → 按钮保持 hidden", async () => {
    document.body.innerHTML = '<div id="conversation">hello</div>';
    const sel = makeFakeSelection({ text: "", insideConversation: true });
    vi.spyOn(window, "getSelection").mockReturnValue(sel);
    const { container } = render(<SelectionFab onBranch={() => {}} />);
    await act(async () => {
      dispatchSelectionChange();
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    });
    const btn = container.querySelector(".selection-fab")!;
    expect(btn.classList.contains("visible")).toBe(false);
  });

  it("选中 #conversation 内文字 → 按钮变 visible", async () => {
    document.body.innerHTML = '<div id="conversation">一段 agent 解释</div>';
    const sel = makeFakeSelection({
      text: "一段 agent 解释",
      insideConversation: true,
    });
    vi.spyOn(window, "getSelection").mockReturnValue(sel);
    const onBranch = vi.fn();
    const { container } = render(<SelectionFab onBranch={onBranch} />);
    await act(async () => {
      dispatchSelectionChange();
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    });
    const btn = container.querySelector(".selection-fab")!;
    expect(btn.classList.contains("visible")).toBe(true);
    expect(btn.style.transform).not.toBe("translate(-9999px, -9999px)");
  });

  it("选中 #conversation 之外 → 按钮保持 hidden", async () => {
    document.body.innerHTML =
      '<div id="conversation">inside</div><div id="sidebar">outside</div>';
    const sel = makeFakeSelection({
      text: "outside text",
      insideConversation: false,
    });
    // ensure the fake outside node is actually outside #conversation
    sel.anchorNode = document.getElementById("sidebar")!.firstChild!;
    sel.focusNode = sel.anchorNode;
    vi.spyOn(window, "getSelection").mockReturnValue(sel);
    const { container } = render(<SelectionFab onBranch={() => {}} />);
    await act(async () => {
      dispatchSelectionChange();
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    });
    const btn = container.querySelector(".selection-fab")!;
    expect(btn.classList.contains("visible")).toBe(false);
  });

  it("点击 visible 按钮 → onBranch(text) + 清掉 selection", async () => {
    document.body.innerHTML = '<div id="conversation">fork me</div>';
    const sel = makeFakeSelection({ text: "fork me", insideConversation: true });
    const removeAllRanges = vi.fn();
    vi.spyOn(window, "getSelection").mockReturnValue({
      ...sel,
      removeAllRanges,
    } as unknown as Selection);
    const onBranch = vi.fn();
    const { container } = render(<SelectionFab onBranch={onBranch} />);
    await act(async () => {
      dispatchSelectionChange();
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    });
    const btn = container.querySelector(".selection-fab")! as HTMLButtonElement;
    fireEvent.click(btn);
    expect(onBranch).toHaveBeenCalledWith("fork me");
    expect(removeAllRanges).toHaveBeenCalled();
  });

  it("Esc → 按钮隐藏", async () => {
    document.body.innerHTML = '<div id="conversation">text</div>';
    const sel = makeFakeSelection({ text: "text", insideConversation: true });
    vi.spyOn(window, "getSelection").mockReturnValue(sel);
    const { container } = render(<SelectionFab onBranch={() => {}} />);
    await act(async () => {
      dispatchSelectionChange();
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    });
    const btn = container.querySelector(".selection-fab")!;
    expect(btn.classList.contains("visible")).toBe(true);
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(btn.classList.contains("visible")).toBe(false);
  });
});