import type { StatusState } from "../ws/protocol";
import type { Metrics } from "../stream/engine";
import { fmtMs } from "../stream/markdown";

const RAIL_ICONS = [
  { name: "home", d: "M3 11l9-8 9 8v9a1 1 0 01-1 1h-5v-6h-6v6H4a1 1 0 01-1-1v-9z" },
  { name: "chat", d: "M4 4h16a2 2 0 012 2v9a2 2 0 01-2 2H9l-5 4V6a2 2 0 012-2z" },
  { name: "code", d: "M8 6l-6 6 6 6M16 6l6 6-6 6" },
  { name: "box", d: "M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z" },
];

export function Rail({ active }: { active: string }) {
  return (
    <nav id="rail">
      <div className="rail-logo">
        <svg viewBox="0 0 24 24" width="20" height="20">
          <path d="M12 2l8 4.5v9L12 22l-8-4.5v-9L12 2z" fill="currentColor" />
        </svg>
      </div>
      <div className="rail-icons">
        {RAIL_ICONS.map((ic) => (
          <button
            key={ic.name}
            className={"rail-btn" + (active === ic.name ? " active" : "")}
            title={ic.name}
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d={ic.d} />
            </svg>
          </button>
        ))}
      </div>
      <div className="rail-bottom">
        <button className="rail-btn" title="settings">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M12 15a3 3 0 100-6 3 3 0 000 6z" />
            <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09a1.65 1.65 0 00-1-1.51 1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09a1.65 1.65 0 001.51-1 1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z" />
          </svg>
        </button>
      </div>
    </nav>
  );
}

export function TopBar({
  connected,
  theme,
  onToggleTheme,
}: {
  connected: boolean;
  theme: "light" | "dark";
  onToggleTheme: () => void;
}) {
  return (
    <header id="topbar">
      <div className="wordmark">
        <span className="wm-dot" />
        <span>MonoDesk</span>
      </div>
      <div className="topbar-right">
        <span className="pill">
          <span className={"conn-dot" + (connected ? " on" : "")} />
          {connected ? "connected" : "offline"}
        </span>
        <button className="icon-btn" onClick={onToggleTheme} title="Toggle theme">
          {theme === "light" ? (
            <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8">
              <circle cx="12" cy="12" r="4" />
              <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
            </svg>
          )}
        </button>
      </div>
    </header>
  );
}

export function StatusBar({
  status,
  connected,
  model,
  metrics,
}: {
  status: StatusState;
  connected: boolean;
  model: string;
  metrics: Metrics;
}) {
  return (
    <footer id="statusbar">
      <div className="sb-left">
        <span className={"sb-dot" + (connected ? " on" : "")} />
        <span>{connected ? status : "offline"}</span>
      </div>
      <div className="sb-right">
        {model && <span>{model}</span>}
        {metrics.tps != null && <span>{metrics.tps} tok/s</span>}
        {metrics.total != null && <span>{fmtMs(metrics.total)}</span>}
      </div>
    </footer>
  );
}
