import type { Msg } from "../stream/engine";

// 会话列表 + 对话历史的本地持久化（localStorage）。
//
// 两层存储：
// - session 元数据（key + 标题）：用于左侧列表
// - 对话历史（每会话一份 Msg[]）：用于切会话时恢复显示，避免历史丢失
//
// MonoX 侧仍按 session_key 管理权威 checkpoint（FsMemoryStore + JsonlCheckpointStore）；
// 这里只存一份「本地展示用」的历史副本，断网 / 重启后能立即回显。
//
// session_key 统一命名：
// - 主会话共享 = "default"（terminal / monodesk / feishu 的主会话共用同一个）
// - 其他会话 = `channel_name:channel_session_id`（monodesk 新会话 = "monodesk:<随机 id>"）

export interface SessionItem {
  key: string;
  title: string;
}

export const CHANNEL_NAME = "monodesk";
export const DEFAULT_SESSION_KEY = "default";
// 会话数上限：monodesk 自己的规则，从 UI 侧卡（core 不感知）。
export const MAX_SESSIONS = 20;

const KEY_SESSIONS = "monodesk.sessions";
const KEY_ACTIVE = "monodesk.activeSession";
const KEY_COUNTER = "monodesk.chatCounter";
const KEY_HISTORIES = "monodesk.histories";
const KEY_TOMBSTONES = "monodesk.tombstones";

// Tombstone：删除的 session 在本地存一个 tombstone，避免：
// 1) Late WS event（agent 还在回流旧 session_key 的 token / final）
//    再次写入 sessionStates，"复活" 已删除 session
// 2) 下次 loadHistories 时再次被读回（即便 monodesk.histories 已清，
//    WS 复活后 useEffect 又写回 localStorage）
//
// Tombstone 格式：[{ key: string, ts: number }, ...]
// 保留 24 小时后自动清，避免长期累积（同一 key 重新使用几乎不可能在 24h 内发生）。
interface Tombstone {
  key: string;
  ts: number;
}

const TOMBSTONE_TTL_MS = 24 * 60 * 60 * 1000;

export function isTombstoned(key: string): boolean {
  const stones = loadTombstones();
  return stones.some((s) => s.key === key);
}

export function addTombstone(key: string): void {
  const stones = loadTombstones();
  // 去重：同一 key 多次删除只留最新 ts
  const filtered = stones.filter((s) => s.key !== key);
  filtered.push({ key, ts: Date.now() });
  saveTombstones(filtered);
}

function loadTombstones(): Tombstone[] {
  try {
    const raw = localStorage.getItem(KEY_TOMBSTONES);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // 顺手清过期（24h TTL）
    const now = Date.now();
    const fresh = parsed.filter(
      (s: Tombstone) => now - s.ts < TOMBSTONE_TTL_MS && typeof s.key === "string"
    );
    return fresh;
  } catch {
    return [];
  }
}

function saveTombstones(stones: Tombstone[]): void {
  try {
    localStorage.setItem(KEY_TOMBSTONES, JSON.stringify(stones));
  } catch {
    // 静默
  }
}

// 启动时清理：过期 tombstone 写回 localStorage；
// caller 可以同时拿到当前生效的 tombstone key 集合，用于 dispatch drop。
export function loadActiveTombstones(): Set<string> {
  const stones = loadTombstones();
  // loadTombstones 已经过滤过 TTL；如果有被淘汰的会重新写一遍更小的版本
  saveTombstones(stones);
  return new Set(stones.map((s) => s.key));
}

const DEFAULT_SESSION: SessionItem = { key: DEFAULT_SESSION_KEY, title: "Default" };

// 随机 session id：时间戳 36 进制 + 4 位随机，本地足够唯一，无特殊字符。
function newSessionId(): string {
  const rand = Math.random().toString(36).slice(2, 6);
  return Date.now().toString(36) + rand;
}

function nextChatCounter(): number {
  const n = parseInt(localStorage.getItem(KEY_COUNTER) || "0", 10) || 0;
  localStorage.setItem(KEY_COUNTER, String(n + 1));
  return n + 1;
}

// 新建会话：直接生成 key + 自动标题，不重命名。
export function newSession(): SessionItem {
  return { key: `${CHANNEL_NAME}:${newSessionId()}`, title: `Chat ${nextChatCounter()}` };
}

// 新建 fork 会话（spec/requirements/floating-agent-from-selection.md）：
// - key 前缀 monodesk:fork-<ts>-<rand> 跟普通 Chat session 区分
// - 标题从 snippet 前 30 字截取，自动加 …
// - 不占用 chatCounter（fork 不是"第 N 个 Chat"）
export function newForkSession(parentKey: string, snippet: string): SessionItem {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  const trimmed = snippet.trim().replace(/\s+/g, " ").slice(0, 30);
  const title = trimmed ? `Fork: ${trimmed}${snippet.length > 30 ? "…" : ""}` : `Fork from ${parentKey}`;
  return { key: `${CHANNEL_NAME}:fork-${ts}-${rand}`, title };
}

// 旧版曾把主会话 key 写成 "monodesk:default"，迁回共享主会话 "default"。
function migrateKey(key: string): string {
  return key === "monodesk:default" ? "default" : key;
}

export function loadSessions(): SessionItem[] {
  try {
    const raw = localStorage.getItem(KEY_SESSIONS);
    if (!raw) return [DEFAULT_SESSION];
    const parsed = JSON.parse(raw) as SessionItem[];
    if (!Array.isArray(parsed) || parsed.length === 0) return [DEFAULT_SESSION];
    const migrated = parsed.map((s) => ({ key: migrateKey(s.key), title: s.title }));
    if (!migrated.some((s) => s.key === DEFAULT_SESSION_KEY)) {
      migrated.unshift(DEFAULT_SESSION);
    }
    return migrated;
  } catch {
    return [DEFAULT_SESSION];
  }
}

export function saveSessions(sessions: SessionItem[]): void {
  try {
    localStorage.setItem(KEY_SESSIONS, JSON.stringify(sessions));
  } catch {
    // 存储不可用（隐私模式等）静默失败
  }
}

export function loadActiveSession(): string {
  try {
    return migrateKey(localStorage.getItem(KEY_ACTIVE) || DEFAULT_SESSION_KEY);
  } catch {
    return DEFAULT_SESSION_KEY;
  }
}

export function saveActiveSession(key: string): void {
  try {
    localStorage.setItem(KEY_ACTIVE, key);
  } catch {
    // ignore
  }
}

// ---- 对话历史（每会话一份） ----

export function loadHistories(): Record<string, Msg[]> {
  try {
    const raw = localStorage.getItem(KEY_HISTORIES);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, Msg[]>;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const out: Record<string, Msg[]> = {};
    for (const [k, v] of Object.entries(parsed)) {
      out[k === "monodesk:default" ? "default" : k] = v as Msg[];
    }
    return out;
  } catch {
    return {};
  }
}

export function saveHistories(histories: Record<string, Msg[]>): void {
  try {
    localStorage.setItem(KEY_HISTORIES, JSON.stringify(histories));
  } catch {
    // 存储不可用 / 超限时静默失败
  }
}
