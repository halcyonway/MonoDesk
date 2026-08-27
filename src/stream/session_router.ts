// SessionRouter：把「运行时回调」按 sessionKey 路由到对应的 SessionState entry。
//
// 设计动机：之前的实现里 status / metrics / steps / model 都是全局 React state，
// 切会话时只能手动 reset 状态 —— 容易漏（比如切完新会话还在 "compressing..."）。
//
// 这里的做法：一张 Map<sessionKey, SessionState>；视图从 active key derive；
// 引擎回调只写「当前流式 key」（streamKey）对应的 entry，不直接碰全局状态。
//
// 切会话时不写任何「重置」代码 —— 因为视图 derive 是无副作用的，
// active key 一变，视图自然就是新 entry（或 EMPTY default），结构上不可能残留旧数据。

export interface SessionState {
  msgs: any[];
  status: string;
  metrics: any;
  steps: any[];
  model: string;
  availableProviders: string[];
  // 也保留 connected? —— 不。connected 是 WS 物理状态，与 session 无关，不进 Map。
}

export interface RouterSetters {
  msgs: SessionState["msgs"];
  status: SessionState["status"];
  metrics: SessionState["metrics"];
  steps: SessionState["steps"];
  model: SessionState["model"];
  availableProviders: SessionState["availableProviders"];
}

export type Setter<K extends keyof RouterSetters> = (
  v: RouterSetters[K] | ((prev: RouterSetters[K]) => RouterSetters[K])
) => void;

export type RouterCallbacks = {
  [K in keyof RouterSetters]: Setter<K>;
};

export type StateMap = Record<string, SessionState>;

/**
 * 构造一组路由过的 setter。引擎拿到这组 setter 后，调用它们的效果是：
 * `s[streamKey][field] = v`，streamKey 之外的 entry 完全不动。
 *
 * `setState` 是 React 的 `setSessionStates`，由 App 注入；`getStreamKey` 是
 * 「当前流式属于哪个 session」，每次调用取最新值（通常用 ref）。
 */
export function buildSessionRoutedSetters(
  setState: (updater: (s: StateMap) => StateMap) => void,
  getStreamKey: () => string,
  empty: SessionState
): RouterCallbacks {
  const setFor = <K extends keyof RouterSetters>(field: K): Setter<K> =>
    (v) => {
      const k = getStreamKey();
      setState((s) => {
        const cur = s[k] ?? empty;
        const next =
          typeof v === "function"
            ? (v as (p: RouterSetters[K]) => RouterSetters[K])(cur[field] as RouterSetters[K])
            : v;
        return { ...s, [k]: { ...cur, [field]: next } };
      });
    };
  return {
    msgs: setFor("msgs"),
    status: setFor("status"),
    metrics: setFor("metrics"),
    steps: setFor("steps"),
    model: setFor("model"),
    availableProviders: setFor("availableProviders"),
  };
}

/**
 * 从 Map 里 derive 视图：active key 没 entry 时返回 empty default。
 * 关键不变量：返回的对象**与 Map 里的引用不同**（spread 一次），
 * 避免 React 把 derived view 当成「同一个引用」而跳过重渲染。
 */
export function viewForState(
  states: StateMap,
  activeKey: string,
  empty: SessionState
): SessionState {
  return states[activeKey] ?? empty;
}