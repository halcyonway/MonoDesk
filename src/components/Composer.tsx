import { useCallback, useEffect, useRef, useState } from "react";
import type { StatusState, Attachment } from "../ws/protocol";
import { fmtMs } from "../stream/markdown";

const UPLOAD_URL =
  (import.meta.env.VITE_DEBUG_URL ?? "http://127.0.0.1:8768") +
  "/debug/attachments/upload";

// MonoDesk 上传白名单 —— 必须跟 MonoX read_doc tool 支持的格式 1:1 同步。
// 详见 spec/requirements/doc-tool-universal.md §2.8。
// v1: image（multimodalunderstand 走）+ pdf/txt/md/csv/json（read_doc 走）。
// 改这里时同步改 MonoX/core/loop/tools/read_doc.py 的 _HANDLERS 表。
const ALLOWED_UPLOAD_MIME = new Set<string>([
  "application/pdf",
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

// accept 字符串：根据上面的白名单拼出来。
// 顺序不影响 browser 过滤，但 readability 更好按 image 先 / doc 后。
const ACCEPT_ATTR = [
  "image/png,image/jpeg,image/gif,image/webp",
  "application/pdf",
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
].join(",");

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

  // Add files: 按白名单过滤 + create blob object URLs for preview; don't upload yet.
  // 不在白名单的 file → console.warn 后 silently drop（不弹 modal，避免 paste 干扰输入）。
  // 为什么不直接拦 <input accept>：浏览器在某些 file manager 里仍能塞其它类型过来
  // （比如 macOS Finder 拖入 / 剪贴板），所以 defense-in-depth 在 JS 层也卡一次。
  const addFiles = useCallback((files: FileList | File[]) => {
    const allowed: File[] = [];
    for (const f of Array.from(files)) {
      if (ALLOWED_UPLOAD_MIME.has(f.type)) {
        allowed.push(f);
      } else {
        // 不告诉用户——paste 场景下他们可能根本不知道剪贴板里有什么；
        // 留个 console.warn 方便调试。
        console.warn(`attachment dropped: unsupported mime "${f.type || "(empty)"}" for ${f.name}`);
      }
    }
    if (!allowed.length) return;
    const newPreviews: LocalPreview[] = allowed.map((file) => ({
      id: Math.random().toString(36).slice(2),
      objectUrl: URL.createObjectURL(file),
      name: file.name,
      mime: file.type || "application/octet-stream",
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
        headers: { "Content-Type": file.type || "application/octet-stream" },
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

  // Paste from clipboard —— 只拦「文件类」item（kind === 'file'，来自 Finder 复制 /
  // 浏览器复制图片等）；纯文本（kind === 'string'，text/plain / text/html / text/uri-list）
  // 一律放行，让 textarea 走默认 paste 行为。
  //
  // 之前 bug：把 text/plain 也当 .txt 文件收下来（getAsFile() 对 string-kind item
  // 也会返回 File 包文本），导致用户 paste 文字时变成「附件预览」而不是输入到 textarea。
  const onPaste = useCallback(
    (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const fileItems = Array.from(items).filter(
        (item) => item.kind === "file" && ALLOWED_UPLOAD_MIME.has(item.type)
      );
      if (!fileItems.length) return;
      e.preventDefault();
      const files = fileItems
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
                  {/* 按 mime 分流，跟 Conversation 里的 msg-attachments 保持一致：
                      - image/* → <img> + 点开 lightbox
                      - application/pdf → <object> 调原生 PDF viewer（无 lightbox，点不开）
                      - 其它 → doc thumb（icon + 文件名），点不开 lightbox */}
                  {p.mime.startsWith("image/") ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={p.objectUrl}
                      alt={p.name}
                      onClick={() => setLightboxUrl(p.objectUrl)}
                    />
                  ) : p.mime === "application/pdf" ? (
                    <object
                      data={p.objectUrl}
                      type="application/pdf"
                      aria-label={p.name}
                      title={p.name}
                    />
                  ) : (
                    <div className="doc-thumb" title={`${p.name} (${p.mime})`}>
                      <span className="doc-thumb-icon" aria-hidden>📄</span>
                      <span className="doc-thumb-name">{p.name}</span>
                    </div>
                  )}
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
              <span>Drop file to attach (image, PDF, txt, md, csv, json)</span>
            </div>
          )}

          <div className="composer-main">
            <textarea
              id="input"
              ref={taRef}
              rows={1}
              value={value}
              placeholder="Message MonoX… (paste or drop images, PDFs, txt, md, csv, json)"
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
              title="Attach file (image, PDF, txt, md, csv, json)"
            >
              {/* paperclip — 通用「附件」语义，覆盖 image + doc 全 9 种支持格式。
                  之前的 image icon（frame + circle + mountain）跟 PDF/csv 含义对不上。 */}
              <svg
                viewBox="0 0 24 24"
                width="16"
                height="16"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
              </svg>
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept={ACCEPT_ATTR}
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
