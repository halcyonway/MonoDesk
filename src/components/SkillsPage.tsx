// SkillsPage — skill 管理 UI：list + 编辑 + upload zip + 新建 / 删除。
//
// 三段式布局：顶 bar + 左 280px list + 右 textarea detail panel。
// 模态确认（删除 / 新建）复用 trace-scrim 的样式。

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
} from "react";
import type { SkillMeta } from "../skills/types";
import type { SkillsClient } from "../skills/client";

const VALID_NAME = /^[A-Za-z0-9._-]+$/;

export function SkillsPage({ client }: { client: SkillsClient }) {
  // null = 还在 initial load
  const [skills, setSkills] = useState<SkillMeta[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  // detail 编辑状态
  const [body, setBody] = useState("");
  const [originalBody, setOriginalBody] = useState("");
  const [loadingSkill, setLoadingSkill] = useState(false);
  const [saving, setSaving] = useState(false);

  // 通用
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // 模态
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [showNew, setShowNew] = useState(false);

  const dirty = body !== originalBody;

  // ---- 加载列表 ----

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const list = await client.list();
      setSkills(list);
    } catch (e) {
      setError(_errMsg(e));
    }
  }, [client]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // toast 自动消失
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(t);
  }, [toast]);

  // 切换页面时清选择（防止 stale 编辑）
  // （实际上 App.tsx 用条件渲染切整个 SkillsPage → mount/unmount → 不需要）

  // ---- 操作 ----

  const onSelect = useCallback(
    async (name: string) => {
      if (name === selected) return;
      if (dirty && !window.confirm("Discard unsaved changes?")) return;
      setSelected(name);
      setLoadingSkill(true);
      setError(null);
      try {
        const full = await client.get(name);
        setBody(full.body);
        setOriginalBody(full.body);
      } catch (e) {
        setError(_errMsg(e));
      } finally {
        setLoadingSkill(false);
      }
    },
    [client, selected, dirty],
  );

  const onSave = useCallback(async () => {
    if (!selected) return;
    setSaving(true);
    setError(null);
    try {
      await client.save(selected, body);
      setOriginalBody(body);
      setToast(`Saved ${selected}`);
      await refresh();
    } catch (e) {
      setError(_errMsg(e));
    } finally {
      setSaving(false);
    }
  }, [client, selected, body, refresh]);

  const onDiscard = useCallback(() => {
    setBody(originalBody);
  }, [originalBody]);

  const onConfirmDelete = useCallback(async () => {
    if (!confirmDelete) return;
    setDeleting(true);
    setError(null);
    try {
      await client.remove(confirmDelete);
      if (selected === confirmDelete) {
        setSelected(null);
        setBody("");
        setOriginalBody("");
      }
      setConfirmDelete(null);
      setToast(`Deleted ${confirmDelete}`);
      await refresh();
    } catch (e) {
      setError(_errMsg(e));
    } finally {
      setDeleting(false);
    }
  }, [client, confirmDelete, selected, refresh]);

  const onUpload = useCallback(
    async (file: File) => {
      setError(null);
      try {
        const result = await client.upload(file);
        setToast(`Added ${result.added.length} skill(s): ${result.added.join(", ")}`);
        await refresh();
      } catch (e) {
        setError(_errMsg(e));
      }
    },
    [client, refresh],
  );

  const onCreate = useCallback(
    async (name: string) => {
      setError(null);
      const tmpl = `---\nname: ${name}\ndescription: ${name} skill\ntier: 1\n---\n\n# ${name}\n\n`;
      try {
        await client.save(name, tmpl);
        setShowNew(false);
        setToast(`Created ${name}`);
        await refresh();
        setSelected(name);
        setBody(tmpl);
        setOriginalBody(tmpl);
      } catch (e) {
        setError(_errMsg(e));
      }
    },
    [client, refresh],
  );

  // ---- render ----

  return (
    <div id="skills-page">
      <div className="sp-topbar">
        <div className="sp-title">
          <h2>Skills</h2>
          <span className="sp-count">
            {skills === null ? "…" : `${skills.length} total`}
          </span>
        </div>
        <div className="sp-actions">
          <button
            className="icon-btn"
            onClick={refresh}
            title="Reload"
            aria-label="Reload"
          >
            <RefreshIcon />
          </button>
          <label className="sp-btn">
            Upload .zip
            <input
              type="file"
              accept=".zip,application/zip"
              hidden
              onChange={(e: ChangeEvent<HTMLInputElement>) => {
                const f = e.target.files?.[0];
                if (f) onUpload(f);
                e.target.value = "";
              }}
            />
          </label>
          <button className="sp-btn primary" onClick={() => setShowNew(true)}>
            + New skill
          </button>
        </div>
      </div>

      {error && (
        <div className="sp-error">
          <span>{error}</span>
          <button className="sp-error-close" onClick={() => setError(null)} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}

      <div id="sp-body">
        <div className="sp-list">
          {skills === null && <div className="sp-loading">Loading…</div>}
          {skills !== null && skills.length === 0 && (
            <div className="sp-empty">
              No skills yet. Click <strong>+ New skill</strong> or upload a
              <strong> .zip</strong> pack.
            </div>
          )}
          {skills !== null &&
            skills.map((s) => (
              <div
                key={s.name}
                className={"sp-item" + (s.name === selected ? " active" : "")}
                onClick={() => onSelect(s.name)}
                title={s.description}
              >
                <span className={"sp-tier tier-" + s.tier}>L{s.tier}</span>
                <div className="sp-meta">
                  <div className="sp-name">{s.name}</div>
                  <div className="sp-desc">{s.description}</div>
                </div>
              </div>
            ))}
        </div>

        <div className="sp-detail">
          {!selected && (
            <div className="sp-detail-empty">
              Select a skill from the list to edit
            </div>
          )}
          {selected && (
            <>
              <div className="sp-detail-head">
                <div className="sp-detail-title">
                  <h3>{selected}</h3>
                  {dirty && <span className="sp-dirty">● unsaved</span>}
                </div>
                <div className="sp-detail-actions">
                  {dirty && (
                    <button onClick={onDiscard} disabled={saving}>
                      Discard
                    </button>
                  )}
                  <button
                    className="sp-btn primary"
                    onClick={onSave}
                    disabled={!dirty || saving}
                    title={dirty ? "Save changes" : "No changes"}
                  >
                    {saving ? "Saving…" : "Save"}
                  </button>
                  <button
                    className="sp-btn danger"
                    onClick={() => setConfirmDelete(selected)}
                  >
                    Delete
                  </button>
                </div>
              </div>
              {loadingSkill ? (
                <div className="sp-loading">Loading…</div>
              ) : (
                <textarea
                  className="sp-editor"
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  spellCheck={false}
                  placeholder="SKILL.md content (markdown with optional YAML frontmatter)"
                />
              )}
            </>
          )}
        </div>
      </div>

      {toast && <div className="sp-toast">{toast}</div>}

      {confirmDelete && (
        <ConfirmModal
          title={`Delete "${confirmDelete}"?`}
          body="This permanently removes the skill directory. Cannot be undone."
          confirmLabel={deleting ? "Deleting…" : "Delete"}
          danger
          disabled={deleting}
          onCancel={() => setConfirmDelete(null)}
          onConfirm={onConfirmDelete}
        />
      )}

      {showNew && (
        <NewSkillModal
          existing={skills?.map((s) => s.name) ?? []}
          onCancel={() => setShowNew(false)}
          onConfirm={onCreate}
        />
      )}
    </div>
  );
}

// ---- 通用 confirm modal ----

function ConfirmModal({
  title,
  body,
  confirmLabel,
  danger,
  disabled,
  onCancel,
  onConfirm,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  danger?: boolean;
  disabled?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="trace-scrim open" onClick={onCancel}>
      <div className="sp-modal" onClick={(e) => e.stopPropagation()}>
        <h4>{title}</h4>
        <p>{body}</p>
        <div className="sp-modal-actions">
          <button onClick={onCancel} disabled={disabled}>
            Cancel
          </button>
          <button
            className={danger ? "sp-btn danger" : "sp-btn primary"}
            onClick={onConfirm}
            disabled={disabled}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function NewSkillModal({
  existing,
  onCancel,
  onConfirm,
}: {
  existing: string[];
  onCancel: () => void;
  onConfirm: (name: string) => void;
}) {
  const [name, setName] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const trimmed = name.trim();
  const valid =
    trimmed.length > 0 &&
    VALID_NAME.test(trimmed) &&
    !existing.includes(trimmed);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && valid) {
      onConfirm(trimmed);
    } else if (e.key === "Escape") {
      onCancel();
    }
  };

  const helpText = !trimmed
    ? "Enter a name"
    : !VALID_NAME.test(trimmed)
      ? "Allowed: letters, digits, dash, underscore, dot"
      : existing.includes(trimmed)
        ? "Skill already exists"
        : "✓ available";

  return (
    <div className="trace-scrim open" onClick={onCancel}>
      <div className="sp-modal" onClick={(e) => e.stopPropagation()}>
        <h4>New skill</h4>
        <input
          ref={inputRef}
          className="sp-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="skill-name"
        />
        <p className="sp-help">{helpText}</p>
        <div className="sp-modal-actions">
          <button onClick={onCancel}>Cancel</button>
          <button
            className="sp-btn primary"
            onClick={() => onConfirm(trimmed)}
            disabled={!valid}
          >
            Create
          </button>
        </div>
      </div>
    </div>
  );
}

// ---- helpers ----

function _errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

function RefreshIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12a9 9 0 11-3-6.7L21 8" />
      <path d="M21 3v5h-5" />
    </svg>
  );
}
