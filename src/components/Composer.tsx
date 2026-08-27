import { useCallback, useEffect, useRef, useState } from "react";
import type { StatusState, Attachment } from "../ws/protocol";
import { fmtMs } from "../stream/markdown";

const UPLOAD_URL =
  (import.meta.env.VITE_DEBUG_URL ?? "http://127.0.0.1:8768") +
  "/debug/attachments/upload";

// Local-only preview item: blob URL stays in memory, never uploaded until send
interface LocalPreview {
  /** client-generated unique id */
  id: string;
  /** blob URL for <img src> */
  objectUrl: string;
  /** original filename */
  name: string;
  /** MIME type */
  mime: string;
  /** the actual File object, kept for upload */
  file: File;
}

export function Composer({
  running,
  status,
  model,
  providers,
  selectedProvider,
  onSelectProvider,
  turnStartAt,
  onSend,
  onStop,
}: {
  running: boolean;
  status: StatusState;
  model: string;
  /** Runtime hello 帧下发的可用 provider 名列表；空数组 → 不渲染选择器 */
  providers: string[];
  /** 当前选中的 provider；空串 = 跟随服务端默认 */
  selectedProvider: string;
  onSelectProvider: (p: string) => void;
  turnStartAt: number;
  onSend: (text: string, attachments?: Attachment[]) => void;
  onStop: () => void;
}) {
  const [value, setValue] = useState("");
  const [previews, setPreviews] = useState<LocalPreview[]>([]);
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const [now, setNow] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dropRef = useRef<HTMLDivElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);

  // 点击 picker 外部时关闭菜单
  useEffect(() => {
    if (!pickerOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (!pickerRef.current?.contains(e.target as Node)) setPickerOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [pickerOpen]);

  // Running timer
  useEffect(() => {
    if (!running) return;
    setNow(performance.now());
    const t = setInterval(() => setNow(performance.now()), 200);
    return () => clearInterval(t);
  }, [running]);

  const resize = () => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 180) + "px";
  };

  // Add files: create blob object URLs for preview; don't upload yet.
  const addFiles = useCallback((files: FileList | File[]) => {
    const imageFiles = Array.from(files).filter((f) => f.type.startsWith("image/"));
    if (!imageFiles.length) return;
    const newPreviews: LocalPreview[] = imageFiles.map((file) => ({
      id: Math.random().toString(36).slice(2),
      objectUrl: URL.createObjectURL(file),
      name: file.name,
      mime: file.type || "image/png",
      file,
    }));
    setPreviews((prev) => [...prev, ...newPreviews]);
  }, []);

  // Upload a single file and return the server Attachment, or null on failure
  const uploadOne = useCallback(async (file: File): Promise<Attachment | null> => {
    try {
      const resp = await fetch(UPLOAD_URL, {
        method: "POST",
        body: file,
        headers: { "Content-Type": file.type || "image/png" },
      });
      if (!resp.ok) {
        // 别再静默吞：server 返回 4xx/5xx 时至少打到 console，让用户/调试者看见。
        const text = await resp.text().catch(() => "");
        console.error("attachment upload failed", resp.status, text);
        return null;
      }
      const json = (await resp.json()) as { url: string; name: string; mime: string };
      return { url: json.url, name: json.name, mime: json.mime };
    } catch (err) {
      // 网络层错误（CORS preflight 失败 / connection refused / abort）也打日志。
      // 之前这里 return null 让用户根本看不到上传失败，现在调试能看见。
      console.error("attachment upload error", err);
      return null;
    }
  }, []);

  // Drag & drop
  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };
  const onDragLeave = (e: React.DragEvent) => {
    if (!dropRef.current?.contains(e.relatedTarget as Node)) setIsDragging(false);
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
  };

  // Paste from clipboard
  const onPaste = useCallback(
    (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const imageItems = Array.from(items).filter((item) => item.type.startsWith("image/"));
      if (!imageItems.length) return;
      e.preventDefault();
      const files = imageItems
        .map((item) => item.getAsFile())
        .filter(Boolean) as File[];
      addFiles(files);
    },
    [addFiles]
  );

  useEffect(() => {
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [onPaste]);

  // Remove a preview: revoke blob URL so memory is freed
  const removePreview = (id: string) => {
    setPreviews((prev) => {
      const removed = prev.find((p) => p.id === id);
      if (removed) URL.revokeObjectURL(removed.objectUrl);
      return prev.filter((p) => p.id !== id);
    });
  };

  const submit = async () => {
    const text = value.trim();
    if (!text && !previews.length) return;

    // Upload all files in parallel, then send
    const uploaded = await Promise.all(previews.map((p) => uploadOne(p.file)));
    const attachments = uploaded.filter((a): a is Attachment => a !== null);

    // Clean up blob URLs right after upload (success or not, they're no longer needed)
    previews.forEach((p) => URL.revokeObjectURL(p.objectUrl));

    onSend(text, attachments);
    setValue("");
    setPreviews([]);
    requestAnimationFrame(resize);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      composingRef.current ||
      e.key === "Process" ||
      e.nativeEvent.isComposing ||
      e.nativeEvent.keyCode === 229
    ) {
      return;
    }
    if (e.key === "Enter") {
      const isMetaSend = e.metaKey || e.ctrlKey;
      if (e.shiftKey && !isMetaSend) return;
      e.preventDefault();
      if (running) onStop();
      else void submit(); // submit is async but we don't await to avoid blocking
    }
  };

  const elapsed = running && turnStartAt > 0 ? fmtMs(now - turnStartAt) : "";

  return (
    <>
      {lightboxUrl && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 1000,
            background: "rgba(0,0,0,0.85)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: "zoom-out",
          }}
          onClick={() => setLightboxUrl(null)}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={lightboxUrl}
            alt=""
            style={{
              maxWidth: "90vw",
              maxHeight: "90vh",
              objectFit: "contain",
              borderRadius: 8,
            }}
          />
        </div>
      )}

      <div id="composer-wrap" ref={dropRef}>
        <div id="composer">
          {previews.length > 0 && (
            <div className="attachment-preview">
              {previews.map((p) => (
                <div key={p.id} className="attachment-thumb">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={p.objectUrl}
                    alt={p.name}
                    onClick={() => setLightboxUrl(p.objectUrl)}
                  />
                  <button
                    className="attachment-remove"
                    onClick={() => removePreview(p.id)}
                    title="Remove"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}

          {isDragging && (
            <div className="drop-overlay">
              <span>Drop image to attach</span>
            </div>
          )}

          <div className="composer-main">
            <textarea
              id="input"
              ref={taRef}
              rows={1}
              value={value}
              placeholder="Message MonoX… (paste or drop images)"
              onChange={(e) => {
                setValue(e.target.value);
                resize();
              }}
              onCompositionStart={() => {
                composingRef.current = true;
              }}
              onCompositionEnd={() => {
                composingRef.current = false;
              }}
              onKeyDown={onKeyDown}
              onDragOver={onDragOver}
              onDragLeave={onDragLeave}
              onDrop={onDrop}
            />
          </div>
          <div className="composer-foot">
            <button
              className="attach-btn"
              onClick={() => fileInputRef.current?.click()}
              title="Attach image"
            >
              <svg
                viewBox="0 0 24 24"
                width="16"
                height="16"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <rect x="3" y="3" width="18" height="18" rx="3" />
                <circle cx="8.5" cy="8.5" r="1.5" />
                <path d="M21 15l-5-5L5 21" />
              </svg>
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              style={{ display: "none" }}
              onChange={(e) => {
                if (e.target.files?.length) addFiles(e.target.files);
                e.target.value = "";
              }}
            />

            {providers.length > 0 ? (
              <div className={"model-picker" + (pickerOpen ? " open" : "")} ref={pickerRef}>
                <button
                  className="model-picker-btn"
                  onClick={() => setPickerOpen((o) => !o)}
                  title={`当前: ${selectedProvider || model || "—"}（切换后下一个请求生效）`}
                >
                  <span>{selectedProvider || model || "—"}</span>
                  <svg viewBox="0 0 10 6" width="9" height="6" fill="currentColor">
                    <path d="M0 0l5 6 5-6z" />
                  </svg>
                </button>
                {pickerOpen && (
                  <div className="model-picker-menu">
                    <div
                      className={"model-picker-item" + (selectedProvider === "" ? " selected" : "")}
                      onClick={() => {
                        onSelectProvider("");
                        setPickerOpen(false);
                      }}
                    >
                      <span>default{model ? <small>{model}</small> : null}</span>
                      {selectedProvider === "" && <span className="mp-check">✓</span>}
                    </div>
                    <div className="model-picker-sep" />
                    {providers.map((p) => (
                      <div
                        key={p}
                        className={"model-picker-item" + (selectedProvider === p ? " selected" : "")}
                        onClick={() => {
                          onSelectProvider(p);
                          setPickerOpen(false);
                        }}
                      >
                        <span>{p}</span>
                        {selectedProvider === p && <span className="mp-check">✓</span>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div className="model-chip" title="模型由服务端配置">
                <span>{model || "—"}</span>
              </div>
            )}
            <div id="composer-status">
              {running ? (
                <>
                  <span className="dot" />
                  <span>
                    {status === "tooling" ? "calling tools" : status}
                  </span>
                  {elapsed && (
                    <span className="dim">· {elapsed}</span>
                  )}
                </>
              ) : (
                <span className="dim">ready</span>
              )}
            </div>
            <button
              id="send"
              className={running ? "stop" : ""}
              disabled={
                !running && !value.trim() && !previews.length
              }
              onClick={() => (running ? onStop() : void submit())}
              title={running ? "Interrupt" : "Send"}
            >
              {running ? (
                <svg viewBox="0 0 24 24" width="15" height="15">
                  <rect
                    x="6"
                    y="6"
                    width="12"
                    height="12"
                    rx="2"
                    fill="currentColor"
                  />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" width="16" height="16">
                  <path
                    d="M3 12l18-8-8 18-2-7-8-3z"
                    fill="currentColor"
                  />
                </svg>
              )}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
