import { useEffect, useRef, useState } from "react";
import type { StatusState } from "../ws/protocol";
import { fmtMs } from "../stream/markdown";

export function Composer({
  running,
  status,
  model,
  turnStartAt,
  onSend,
  onStop,
}: {
  running: boolean;
  status: StatusState;
  model: string;
  turnStartAt: number;
  onSend: (text: string) => void;
  onStop: () => void;
}) {
  const [value, setValue] = useState("");
  const [now, setNow] = useState(0);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);

  // 运行中的计时（供 footer 展示 elapsed）
  useEffect(() => {
    if (!running) return;
    setNow(performance.now());
    const t = setInterval(() => setNow(performance.now()), 200);
    return () => clearInterval(t);
  }, [running]);

  // 输入框自适应高度
  const resize = () => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 180) + "px";
  };

  const submit = () => {
    const text = value.trim();
    if (!text) return;
    onSend(text);
    setValue("");
    requestAnimationFrame(resize);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // 输入法组词中按回车是「确认候选字母」，不是发送/停止。
    // isComposing 在部分 IME（尤其 mac 中文输入法）下会报 false，keyCode 229 才是可靠信号；
    // 另外组词中的回车 key 可能被报成 "Process" 而非 "Enter"。
    if (
      composingRef.current ||
      e.key === "Process" ||
      e.nativeEvent.isComposing ||
      e.nativeEvent.keyCode === 229
    ) {
      return;
    }
    if (e.key === "Enter") {
      // 修饰键决定 send vs newline：
      //   Enter           → send（或 running 时 stop）
      //   Shift+Enter     → newline（让浏览器走默认换行行为）
      //   Cmd+Enter / Ctrl+Enter → send（与 macOS 系统快捷键直觉一致）
      const isMetaSend = e.metaKey || e.ctrlKey;
      if (e.shiftKey && !isMetaSend) return; // Shift+Enter：放行默认行为 → \n
      e.preventDefault();
      if (running) onStop();
      else submit();
    }
  };

  const elapsed = running && turnStartAt > 0 ? fmtMs(now - turnStartAt) : "";

  return (
    <div id="composer-wrap">
      <div id="composer">
        <div className="composer-main">
          <textarea
            id="input"
            ref={taRef}
            rows={1}
            value={value}
            placeholder="Message MonoX…"
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
          />
        </div>
        <div className="composer-foot">
          <div className="model-chip" title="模型由服务端配置，暂不支持切换">
            <span>{model || "—"}</span>
          </div>
          <div id="composer-status">
            {running ? (
              <>
                <span className="dot" />
                <span>{status === "tooling" ? "calling tools" : status}</span>
                {elapsed && <span className="dim">· {elapsed}</span>}
              </>
            ) : (
              <span className="dim">ready</span>
            )}
          </div>
          <button
            id="send"
            className={running ? "stop" : ""}
            disabled={!running && !value.trim()}
            onClick={() => (running ? onStop() : submit())}
            title={running ? "Interrupt" : "Send"}
          >
            {running ? (
              <svg viewBox="0 0 24 24" width="15" height="15">
                <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" />
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
  );
}
