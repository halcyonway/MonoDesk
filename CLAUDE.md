# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## ⛔ Open-source project — branching / commit / PR discipline

> **本仓库是公开开源项目**（`halcyonway/MonoDesk`），所有改动都会变成公开记录。
> 不能随便 commit，要走标准流程。

1. **每个 feature / fix 必须在独立分支**：
   - 分支名规范：`feat/<short-name>`、`fix/<short-name>`、`chore/<short-name>`、`spec/<short-name>`。
   - 例：`feat/conversation-ui-polish`、`fix/markdown-image-render`、`chore/upgrade-tauri-cli`。
   - 永远不要在 `main` 上直接 commit；永远不要把多个不相关 feature 堆到一个分支上。
   - **开工前先 `git status` + `git branch --show-current` 确认自己在哪**；如果当前分支不对，
     用 `git checkout -b feat/<name>` 或 `git switch -c feat/<name>` 新开。

2. **commit 前自检**：
   - 改动范围对吗？有没有顺手改了不相关的文件？
   - 有没有把不该上传的内容混进来？**必须人工过一遍**：
     - API key / token / password / `.env` / `*.pem` / `id_rsa` / 私钥 / OSS / 数据库连接串
     - 真实用户数据、截图里的 PII、内部 URL
     - `node_modules`、构建产物、`dist/`、`*.log`、`.DS_Store`
   - 提交前跑 `git status` 看 Untracked / Modified 列表；
     跑 `git diff --stat HEAD` 看本次改动总览；任何可疑文件都不要 `git add .`，逐个 `git add <file>`。
   - commit message 用 conventional commits 风格（`feat(...):` / `fix(...):` / `chore(...):`），
     引用对应的 `spec/requirements/<feature>.md` 路径。

3. **PR 流程**：
   - 推新分支：`git push -u origin feat/<name>`（首次推送用 `-u` 设 upstream）。
   - 走 GitHub PR：`gh pr create --base main --head feat/<name>` 或网页端。
   - PR description 要写：背景（为什么）/ 改动（做了什么）/ 验证（怎么测）/ Spec 链接。
   - 等 CI + 人工 review 之后才合并；**不直接 squash-merge 到 main**。

4. **错了不要 `git push --force` 别人的分支**。改自己的分支可以 force-push 但要清楚自己改了什么。
   公共分支（main / 已被他人拉走的 feat/*）force-push 是破坏性操作。

5. **worktree 隔离**（可选但推荐）：多个 feature 并行时用 `git worktree add ../MonoDesk-<name> feat/<name>`，
   互不污染。

**为什么**：开源仓库的 git history 是公开契约 —— 错命名 / 错归属 / 错分支会污染项目历史，
也会让 reviewer / 后续维护者困惑。spec-first + branch-per-feature + PR 流程让每个改动都可审计、可回滚。

## ⛔ Before any feature: check the relevant spec first

> **Rule**: 写任何 feature / UI 调整 / 协议扩展之前，**先看 `spec/` 下是否有对应文档**。
> 这是设计意图与契约的唯一来源（不是 `~/.claude/plans/`，那是 scratch）。

1. **看 spec 目录结构**：`spec/requirements/`（行为契约 / 设计意图）和 `spec/ui/`（HTML 视觉稿）。
2. **看有没有子目录 CLAUDE.md**：本仓库主仓通常没有 per-dir CLAUDE.md，但下游子模块
   （`MonoX/`、`MonoDesk/src/stream/`、`MonoDesk/src/components/` 等）若有自己的 CLAUDE.md，先读。
3. **新建 feature** 必须在 `spec/requirements/<feature>.md` 起稿（必要时 `spec/ui/<feature>.html`
   配独立视觉稿），然后才动代码。
4. **小改 / 修 bug** 至少先看相关 spec 确认不破契约；不需要新建 spec 文件，但 commit message
   要引用 spec 段落。

**为什么**：`spec/` 是设计文档的版本化来源；`~/.claude/plans/` 只是本次会话的 scratch，重启就没了。
spec-first 保证后续 Claude Code / 接手人都能从 git history 看到设计意图。

**Spec 落地流程**（写代码前完成）：

```
①  git status + git branch --show-current   →  确认分支
②  git checkout -b feat/<feature-name>      →  新开 feature 分支
③  ls spec/requirements/  →  看现有同类 spec 的格式与粒度
④  写 spec/requirements/<feature>.md  →  行为契约 + 设计意图 + 验证步骤
⑤  如有 UI 改动：写 spec/ui/<feature>.html  →  独立 HTML，无构建步骤，浏览器直接看
⑥  写代码：src/components/* + src/stream/* + src/styles.css
⑦  vitest 全过（120+） + 手工 e2e
⑧  commit 前 git status / git diff --stat  →  排查敏感内容
⑨  git commit → git push -u origin feat/<name> → gh pr create
```

## Project Overview

MonoDesk is the desktop channel implementation for [MonoX](https://github.com/halcyonway/MonoX). It connects to MonoX Runtime via WebSocket (ws://127.0.0.1:8765), streams token output with a jitter-buffered typewriter effect, and sends user input back. MonoDesk implements only the "view" and "speak" layers — no agent logic, tool execution, or memory.

**Stack:** Tauri v2 (Rust window shell) + TypeScript + React 18. Tauri dev server runs on port 5173, production builds are ~8MB.

## Commands

```bash
# Development (browser)
npm run dev

# Build (typecheck + vite build)
npm run build

# Typecheck only
npm run typecheck

# Run tests
npm test              # single run
npm run test:watch   # watch mode

# Tauri desktop壳
npm run tauri dev     # dev + window
npm run tauri build   # production .app/.msi

# Override WS URL (default: ws://127.0.0.1:8765)
VITE_WS_URL=ws://192.168.1.5:8765 npm run dev
```

**Prerequisites:** MonoX Runtime must be running first (`uv run python run.py` in the MonoX repo).

## Architecture

```
MonoX Runtime (Python) ──StreamEvent(NDJSON)──► MonoDesk (Tauri+TS)
        ▲                                            │
        └─────────── InboundEvent (user_input) ◄─────┘
```

### Event Routing — Per-Session Streams (#74, #78)

Every outbound event carries `data.session_key`. The `StreamEngine` holds a `Map<sessionKey, PerSessionStream>`. On `dispatch(ev)`, the engine reads `ev.data.session_key` and routes to the correct stream. This prevents cross-session pollution (e.g., late events from session A writing into session B's view).

Critical invariant: the `StreamEngine` instance has **no** shared mutable state across sessions. Each `PerSessionStream` is fully isolated (token buffers, jitter buffer, DOM refs, timers).

### Rendering Pipeline

1. `MonoDeskWS` parses NDJSON frames → `StreamEngine.dispatch(ev)`
2. Token events go into a **jitter buffer** (`jbQueue`) with per-character timestamps
3. A fixed 30fps `setTimeout` tick drains the queue at ~90cps (3 chars/tick)
4. Each new character is a `<span class="ch fresh">` with CSS fade-in animation
5. After animation (~220ms), spans consolidate into text nodes

**React does NOT re-render on each token.** It only handles structural blocks (turn start/end, tool cards, reasoning toggle). Components receive shallow stable props; DOM is written directly via `innerHTML`/`appendChild` in the engine.

### Multi-Page Structure

Sidebar navigation (`SidebarPage`): `chat` | `skills` | `tasks`

- **chat**: `Conversation` → `TextStream` / `ReasonBlock` / `ToolBlock` + `Composer`
- **skills**: `SkillsPage` — reads skills from debug server (http://127.0.0.1:8768)
- **tasks**: `TasksPage` / `TaskDetailPage` — async task list and detail views

### Async Tasks

Async tasks (`async_task_*` events) are a separate event family from chat `MonoDeskEvent`s. They do **not** flow through `StreamEngine`; instead they are ingested into `tasksStore` (a singleton reactive store) and displayed in the Tasks page. The WS client subscribes via `subscribe_async_tasks=true` in the hello frame.

### Session Persistence

- `sessionStates` in React state: per-session runtime (msgs, status, metrics, steps, model)
- `localStorage` (`monodesk.sessions`, `monodesk.histories`): session list metadata + message histories
- On reload: `loadHistories()` repopulates `sessionStates` entries, then `StreamEngine.requestScrollToBottom()` restores scroll position

### HMR Handling

In dev mode, the WS instance is stored on `window.__monodeskWs` to survive Vite HMR/fast refresh. On HMR remount, `ws.rebind()` swaps callbacks without closing the socket.

## Key Files

| File | Role |
|---|---|
| `src/ws/client.ts` | WebSocket client with exponential backoff reconnect |
| `src/ws/protocol.ts` | All event types, strictly aligned with MonoX `events.py` |
| `src/stream/engine.ts` | `StreamEngine` + `PerSessionStream` + jitter buffer + DOM writer |
| `src/stream/session_router.ts` | Builds per-session `EngineCallbacks` setters |
| `src/store/sessions.ts` | localStorage persistence for session list + histories |
| `src/store/tasks.ts` | Reactive singleton store for async tasks |
| `src/App.tsx` | Root: WS lifecycle, session routing, page assembly |
| `src/components/Conversation.tsx` | Chat view: TextStream, ReasonBlock, ToolBlock, MsgView |

## Protocol Compatibility

MonoDesk does **not** pin MonoX version. Protocol fields are the stable contract. Unknown `type` values are silently ignored (try/catch in `ws/client.ts`). When adding new event types, update `protocol.ts` first — that is the ground truth.

## UI Specs (Visual Mockups)

When implementing a new feature, create the visual spec **before** writing code:

1. **HTML mockup** → `spec/ui/<feature>.html` — standalone HTML that demonstrates the UI in isolation (no build step, open directly in browser)
2. **Requirements doc** → `spec/requirements/<feature>.md` — describes behavior, states, interactions in prose
3. Then implement in `src/components/` following the existing patterns

Existing specs:
- `spec/ui/async-task.html` — async task list and detail UI
- `spec/ui/model-switcher.html` — provider/model selector
- `spec/requirements/ui-design.md` — core UI design principles
- `spec/requirements/ws-channel-protocol.md` — protocol field definitions

## Code Conventions

- Comments in code are rare; write self-explaining code, add `// why` only for non-obvious decisions
- Code identifiers in English; spec/README in Chinese
- Session key naming: `default` (shared main session), `monodesk:<id>` (new MonoDesk sessions)
