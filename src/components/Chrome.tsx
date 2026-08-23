import type { SessionItem } from "../store/sessions";
import { DEFAULT_SESSION_KEY } from "../store/sessions";

export function SessionList({
  sessions,
  activeKey,
  onSelect,
  onCreate,
  onDelete,
  canCreate,
}: {
  sessions: SessionItem[];
  activeKey: string;
  onSelect: (key: string) => void;
  onCreate: () => void;
  onDelete: (key: string) => void;
  canCreate: boolean;
}) {
  return (
    <aside id="session-list">
      <div className="sl-head">
        <span className="sl-title">Sessions</span>
        <button
          className="sl-new"
          onClick={onCreate}
          disabled={!canCreate}
          title={canCreate ? "New session" : "Session limit reached"}
        >
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
      </div>
      <div className="sl-items">
        {sessions.map((s) => {
          const isMain = s.key === DEFAULT_SESSION_KEY;
          return (
            <div
              key={s.key}
              className={"sl-item" + (s.key === activeKey ? " active" : "")}
              onClick={() => onSelect(s.key)}
              title={s.key}
            >
              <span className="sl-dot" />
              <span className="sl-name">{s.title}</span>
              {!isMain && (
                <button
                  className="sl-del"
                  title="Delete session"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(s.key);
                  }}
                >
                  <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M6 6l12 12M18 6L6 18" />
                  </svg>
                </button>
              )}
            </div>
          );
        })}
      </div>
    </aside>
  );
}

export function TopBar({
  theme,
  onToggleTheme,
}: {
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
