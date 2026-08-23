// Sidebar — 左栏 **上下结构**：
//   - 顶部：每个 page nav item **单独一行**（垂直堆叠，跟下面 session item 风格一致）
//   - 下面：session list（chat 页时）或 page 副标题占位（skills 页时）
//
// 之前我误用「横向 row + flex:1 等分」的版本（Image #6），用户「上下一行一行」要的是
// vertical stack：每个 nav 项 100% 宽、左对齐、可带 icon，跟下面 sl-item 视觉统一。

import type { SessionItem } from "../store/sessions";
import { DEFAULT_SESSION_KEY } from "../store/sessions";
import { SessionList } from "./Chrome";

export type SidebarPage = "chat" | "skills";

export function Sidebar({
  currentPage,
  onPageChange,
  sessions,
  activeKey,
  onSelectSession,
  onCreateSession,
  onDeleteSession,
  canCreate,
}: {
  currentPage: SidebarPage;
  onPageChange: (page: SidebarPage) => void;
  sessions: SessionItem[];
  activeKey: string;
  onSelectSession: (key: string) => void;
  onCreateSession: () => void;
  onDeleteSession: (key: string) => void;
  canCreate: boolean;
}) {
  return (
    <aside id="sidebar">
      <nav className="sidebar-nav" aria-label="Pages">
        <NavRow
          icon={<ChatIcon />}
          active={currentPage === "chat"}
          onClick={() => onPageChange("chat")}
        >
          Chat
        </NavRow>
        <NavRow
          icon={<BookIcon />}
          active={currentPage === "skills"}
          onClick={() => onPageChange("skills")}
        >
          Skills
        </NavRow>
      </nav>

      {currentPage === "chat" ? (
        <SessionList
          sessions={sessions}
          activeKey={activeKey}
          onSelect={onSelectSession}
          onCreate={onCreateSession}
          onDelete={onDeleteSession}
          canCreate={canCreate}
        />
      ) : (
        <div className="sidebar-section-label">Skills</div>
      )}
    </aside>
  );
}

// ---- NavRow：跟 .sl-item 同款的 vertical nav item ----
//
// width:100%（填满 column flex 父容器）+ 左对齐 + hover/active 配色一致。
// 唯一区别：sl-item 有 .sl-dot（会话状态指示），nav-row 改用 inline SVG icon。

function NavRow({
  icon,
  active,
  onClick,
  children,
}: {
  icon: React.ReactNode;
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      className={"sidebar-nav-row" + (active ? " active" : "")}
      onClick={onClick}
      aria-pressed={active}
    >
      <span className="sidebar-nav-row-icon">{icon}</span>
      <span className="sidebar-nav-row-label">{children}</span>
    </button>
  );
}

// ---- Icons（inline SVG，跟 styles.css 里 .sidebar-nav-row-icon 16x16 配） ----

function ChatIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
         strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 5h16v11H8l-4 4V5z" />
    </svg>
  );
}

function BookIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
         strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 4h7a3 3 0 0 1 3 3v13a2 2 0 0 0-2-2H4V4z" />
      <path d="M20 4h-3a3 3 0 0 0-3 3v13a2 2 0 0 1 2-2h4V4z" />
    </svg>
  );
}

// re-export for App.tsx convenience
export { DEFAULT_SESSION_KEY };