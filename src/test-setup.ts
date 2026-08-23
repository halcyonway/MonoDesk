// Vitest 全局 setup。
//
// jsdom 不实现 matchMedia / ResizeObserver / requestAnimationFrame，
// React + 组件代码可能引用到，加 polyfill / stub 让 import 不炸。
import { afterEach } from "vitest";

// 自动清理挂载的 DOM，避免测试间状态泄漏。
afterEach(() => {
  document.body.innerHTML = "";
});

// jsdom 没有 matchMedia；Conversation / Empty 等不会直接用，但保险起见补一个。
if (!window.matchMedia) {
  window.matchMedia = ((q: string) => ({
    matches: false,
    media: q,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}