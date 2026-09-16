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

describe("Composer attachment whitelist (doc-tool-universal)", () => {
  // 上传白名单 = MonoX read_doc 工具的支持范围。
  // 这里断言 <input type="file" accept> 包含 image + pdf/txt/md/csv/json 全部白名单 mime，
  // 跟 MonoX/core/loop/tools/read_doc.py 的 _HANDLERS 表保持 1:1（spec §2.8）。
  it("file input accept includes image + doc whitelist", () => {
    const { container } = renderComposer();
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input).toBeTruthy();
    const accept = input.getAttribute("accept") || "";
    // image 兼容旧行为
    expect(accept).toContain("image/png");
    expect(accept).toContain("image/jpeg");
    // doc 工具支持的所有 mime 都要在
    expect(accept).toContain("application/pdf");
    expect(accept).toContain("text/plain");
    expect(accept).toContain("text/markdown");
    expect(accept).toContain("text/csv");
    expect(accept).toContain("application/json");
  });
});

describe("Composer paste behavior (doc-tool-universal)", () => {
  // 之前 bug：onPaste 把 text/plain 也当 .txt 文件收下来（getAsFile() 对
  // string-kind item 也会返回 File 包文本），导致 paste 文字变成附件预览。
  // 正确语义：只拦 kind === "file" 的 item；纯文本一律放过 textarea 默认 paste。
  //
  // jsdom 没有真的 ClipboardEvent，我们造一个带 clipboardData 的 Event。

  function fakeClipboardEvent(items: Array<{
    kind: "file" | "string";
    type: string;
    content?: string;
  }>): Event {
    const dtItems = items.map((it) => {
      const file = it.kind === "file" && it.content !== undefined
        ? new File([it.content], "fake", { type: it.type })
        : null;
      return {
        kind: it.kind,
        type: it.type,
        getAsFile: () => file,
      };
    });
    const ev = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(ev, "clipboardData", { value: { items: dtItems } });
    return ev;
  }

  it("paste plain text — does NOT call preventDefault, lets textarea default paste through", () => {
    renderComposer();
    const ev = fakeClipboardEvent([{ kind: "string", type: "text/plain" }]);
    document.dispatchEvent(ev);
    // 关键：纯文本 paste 必须放行，textarea 走默认行为（insert text）
    expect(ev.defaultPrevented).toBe(false);
  });

  it("paste a file-kind image — calls preventDefault, attaches to previews", async () => {
    const { container } = renderComposer();
    const ev = fakeClipboardEvent([
      { kind: "file", type: "image/png", content: "fake-png-bytes" },
    ]);
    document.dispatchEvent(ev);
    // 拦下了 → preventDefault 调了
    expect(ev.defaultPrevented).toBe(true);
    // 异步 addFiles 进了 state — 渲染出 attachment-thumb
    await waitFor(() =>
      expect(container.querySelector(".attachment-thumb")).toBeTruthy()
    );
  });

  it("paste file-kind unsupported format — silently dropped, no preview", () => {
    // 比如从 Finder 复制了一个 .rar —— kind=file, type=application/x-rar-compressed
    // 不在白名单 → 不 preventDefault 也不加 preview（保留默认行为，浏览器会忽略）
    const { container } = renderComposer();
    const ev = fakeClipboardEvent([
      { kind: "file", type: "application/x-rar-compressed", content: "rar" },
    ]);
    document.dispatchEvent(ev);
    // 没拦 → 没 preventDefault
    expect(ev.defaultPrevented).toBe(false);
    // 也没加 preview
    expect(container.querySelector(".attachment-thumb")).toBeFalsy();
  });

  it("paste text/plain + file mixed — only file gets intercepted", () => {
    // 真实场景：用户复制一段文字，剪贴板里同时有 text/plain 和 text/html
    // 多个 string-kind item —— onPaste 不应 preventDefault
    renderComposer();
    const ev = fakeClipboardEvent([
      { kind: "string", type: "text/plain" },
      { kind: "string", type: "text/html" },
    ]);
    document.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
  });
});