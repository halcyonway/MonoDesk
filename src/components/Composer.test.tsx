// Composer 单测：键盘快捷键行为。
//
// #71 用户原话：Composer 应该支持
//   Enter         → send
//   Shift+Enter   → newline
//   Cmd+Enter     → send（macOS 直觉）
//   Ctrl+Enter    → send（Windows/Linux 直觉）
// IME 组词中（keyCode 229 / Process / isComposing）一律放行，绝不能误触发 send/stop。

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { Composer } from "./Composer";
import type { StatusState } from "../ws/protocol";

afterEach(() => cleanup());

function renderComposer(overrides: Partial<{
  running: boolean;
  status: StatusState;
  model: string;
  providers: string[];
  selectedProvider: string;
  onSelectProvider: (p: string) => void;
  turnStartAt: number;
  onSend: (text: string) => void;
  onStop: () => void;
}> = {}) {
  const onSend = vi.fn();
  const onStop = vi.fn();
  const utils = render(
    <Composer
      running={overrides.running ?? false}
      status={overrides.status ?? "idle"}
      model={overrides.model ?? "test-model"}
      providers={overrides.providers ?? []}
      selectedProvider={overrides.selectedProvider ?? ""}
      onSelectProvider={overrides.onSelectProvider ?? (() => {})}
      turnStartAt={overrides.turnStartAt ?? 0}
      onSend={onSend}
      onStop={onStop}
    />
  );
  const ta = utils.container.querySelector("textarea#input") as HTMLTextAreaElement;
  expect(ta).toBeTruthy();
  return { ...utils, onSend, onStop, ta };
}

function setValue(ta: HTMLTextAreaElement, v: string) {
  fireEvent.change(ta, { target: { value: v } });
}

describe("Composer keyboard shortcuts", () => {
  it("Enter sends when not running", async () => {
    const { ta, onSend } = renderComposer();
    setValue(ta, "hello");
    fireEvent.keyDown(ta, { key: "Enter" });
    // submit() 是 async（attachments 上传管线），onSend 在微任务里触发
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("hello", []));
  });

  it("Enter triggers onStop when running", () => {
    const { ta, onStop, onSend } = renderComposer({ running: true, status: "thinking" });
    setValue(ta, "hello");
    fireEvent.keyDown(ta, { key: "Enter" });
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onSend).not.toHaveBeenCalled();
  });

  it("Shift+Enter does NOT send (lets textarea insert newline)", () => {
    const { ta, onSend, onStop } = renderComposer();
    setValue(ta, "line1");
    fireEvent.keyDown(ta, { key: "Enter", shiftKey: true });
    // 默认行为：preventDefault 没被调用（textarea 自己插入 \n）。我们的 handler
    // 不能在这里直接断言 onSend 没调用——只要 textarea 还能正常 handle Enter 即可。
    // 关键点：绝对不能调 send / stop。
    expect(onSend).not.toHaveBeenCalled();
    expect(onStop).not.toHaveBeenCalled();
  });

  it("Cmd+Enter sends when not running (macOS convention)", async () => {
    const { ta, onSend } = renderComposer();
    setValue(ta, "via-cmd");
    fireEvent.keyDown(ta, { key: "Enter", metaKey: true });
    // submit() 是 async（attachments 上传管线），onSend 在微任务里触发
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("via-cmd", []));
  });

  it("Ctrl+Enter sends when not running (Win/Linux convention)", async () => {
    const { ta, onSend } = renderComposer();
    setValue(ta, "via-ctrl");
    fireEvent.keyDown(ta, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("via-ctrl", []));
  });

  it("Cmd+Enter / Ctrl+Enter triggers onStop when running", () => {
    const { ta, onStop, onSend } = renderComposer({ running: true, status: "thinking" });
    setValue(ta, "stop me");
    fireEvent.keyDown(ta, { key: "Enter", metaKey: true });
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onSend).not.toHaveBeenCalled();

    fireEvent.keyDown(ta, { key: "Enter", ctrlKey: true });
    expect(onStop).toHaveBeenCalledTimes(2);
  });

  it("does not send when input is empty / whitespace only", () => {
    const { ta, onSend } = renderComposer();
    fireEvent.keyDown(ta, { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();

    setValue(ta, "   \n  ");
    fireEvent.keyDown(ta, { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("does not send while IME composing (isComposing)", () => {
    const { ta, onSend } = renderComposer();
    setValue(ta, "你好");
    // fireEvent 把顶层字段喂给原生 KeyboardEvent 构造器；React 的
    // SyntheticEvent.nativeEvent 再读出来。传 nativeEvent:{...} 不会生效。
    fireEvent.keyDown(ta, {
      key: "Enter",
      isComposing: true,
    });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("does not send while IME composing (keyCode 229 fallback)", () => {
    const { ta, onSend } = renderComposer();
    setValue(ta, "nihao");
    // keyCode 229 = IME composition legacy signal；某些浏览器 / IMEs
    // 不触发 isComposing 但会设 keyCode 229。
    fireEvent.keyDown(ta, {
      key: "Enter",
      keyCode: 229,
    });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("does not send when IME reports key='Process' (some IMEs)", () => {
    const { ta, onSend } = renderComposer();
    setValue(ta, "选词");
    fireEvent.keyDown(ta, { key: "Process" });
    expect(onSend).not.toHaveBeenCalled();
  });
});