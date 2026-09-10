# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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
