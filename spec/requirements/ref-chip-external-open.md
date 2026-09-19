# ref-chip-external-open：Tauri 壳下点击 ref chip 跳转

> **Bug**。Image 反馈点击 chip 后台不跳转。Root cause：MonoDesk 跑在 Tauri webview 里，
> `window.open(url, "_blank")` 和 `<a target="_blank">` 都被 webkit2gtk 拦截——webview
> 没有 opener capability。本 spec 引入 tauri-plugin-shell 调系统默认浏览器打开 URL。

## 1. 现状

- `Conversation.tsx onClick`: chip 是 `<a>` 时 `preventDefault` + `window.open(href, "_blank")`
- Tauri webview 无 opener permission → `window.open` 静默失败
- `<a target="_blank">` 在 webview 里被吞
- 用户感受：点 chip 文字无反应（既不开新窗口，也不弹本卡，更不离开 MonoDesk）

## 2. 方案

引入 `tauri-plugin-shell`：

1. **`src-tauri/Cargo.toml`**：加 `tauri-plugin-shell = "2"`
2. **`src-tauri/capabilities/default.json`**：加 `"shell:allow-open"` permission（限定 URL scheme https/http/mailto）
3. **`src-tauri/src/lib.rs`**：`tauri::Builder::default().plugin(tauri_plugin_shell::init())`
4. **`package.json`**：加 `@tauri-apps/plugin-shell`
5. **`Conversation.tsx`**：检测是否在 Tauri 环境下 → 用 `open(url)` 替代 `window.open`

### 2.1 环境检测

```ts
const isTauri = "__TAURI_INTERNALS__" in window;
```

Tauri webview 全局注入 `__TAURI_INTERNALS__`，浏览器 dev mode (`npm run dev`) 不存在 → fallback 到 `window.open`。

### 2.2 调用方式

```ts
import { open as openExternal } from "@tauri-apps/plugin-shell";

if (isTauri) {
  await openExternal(href);  // 调系统默认浏览器
} else {
  window.open(href, "_blank", "noopener,noreferrer");
}
```

### 2.3 URL 安全性

`tauri-plugin-shell` 默认允许任何 URL scheme。为防止恶意 token emit `file:///etc/passwd` 这种本地路径，要求：

- `href` 必须是 `http://` / `https://` / `mailto:` 起头
- 其他 scheme 在 JS 端过滤掉（不上 open）
- 同时 `tauri-plugin-shell` 在 capability 层也可以限定 scheme（`shell:allow-open` 默认允许 https + http + mailto + tel）

## 3. UX 影响

- Tauri 模式：点 chip → 系统默认浏览器打开新窗口（Chrome / Safari / 系统默认）
- 浏览器模式：点 chip → `window.open` 开新标签（行为不变）
- 选中态闪烁问题（Image 61 反馈）：Tauri 模式下 `await openExternal` 是同步开始，不会触发 `<a>` 默认行为的「选中闪烁」，问题自然消失

## 4. 验收

1. Tauri dev (`npm run tauri dev`)：点 chip → 系统浏览器开新窗口
2. 浏览器 dev (`npm run dev`)：点 chip → 新标签打开
3. `mailto:` chip 链接 → 系统邮件客户端打开
4. 非 `http/https/mailto` URL → 不打开、不报错，UI 显示「unsafe link」提示
5. capability 限定：Rust 端 `tauri-plugin-shell` 在 desktop 只允许 http/https/mailto scheme

## 5. 不在本 spec 范围

- 把所有 `<a target="_blank">` 都改走 plugin（只针对 ref chip，其他外链维持默认 `<a>` 行为）
- 桌面端自定义浏览器选择器（macOS 走默认浏览器，不弹选择）