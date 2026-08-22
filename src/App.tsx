import { useEffect, useRef, useState } from "react";
import { MonoDeskWS } from "./ws/client";
import {
  EMPTY_METRICS,
  StreamEngine,
  type Metrics,
  type Msg,
  type Step,
} from "./stream/engine";
import type { StatusState } from "./ws/protocol";
import { Conversation } from "./components/Conversation";
import { Composer } from "./components/Composer";
import { TopBar } from "./components/Chrome";

const WS_URL = (import.meta.env.VITE_WS_URL as string) ?? "ws://127.0.0.1:8766";

export default function App() {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [status, setStatus] = useState<StatusState>("idle");
  const [metrics, setMetrics] = useState<Metrics>(EMPTY_METRICS);
  const [steps, setSteps] = useState<Step[]>([]);
  const [connected, setConnected] = useState(false);
  const [model, setModel] = useState("");
  const [session, setSession] = useState("default");
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [turnStartAt, setTurnStartAt] = useState(0);

  const engineRef = useRef<StreamEngine>();
  if (!engineRef.current) {
    engineRef.current = new StreamEngine({
      setMsgs,
      setStatus,
      setMetrics,
      setSteps,
      setConnected,
      setModel,
      setSession,
    });
  }
  const engine = engineRef.current;

  const wsRef = useRef<MonoDeskWS>();
  useEffect(() => {
    const ws = new MonoDeskWS(WS_URL, {
      onEvent: (ev) => engine.dispatch(ev),
      onConnectionChange: (open) => setConnected(open),
    });
    ws.connect();
    wsRef.current = ws;
    return () => ws.close();
  }, [engine]);

  // 主题
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  // 代码块 copy 按钮（事件委托，innerHTML 里的按钮也能命中）
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      const copy = t.closest?.(".codeblock .copy") as HTMLElement | null;
      if (!copy) return;
      const code = copy.closest(".codeblock")?.querySelector("code")?.innerText || "";
      navigator.clipboard?.writeText(code);
      const o = copy.textContent;
      copy.textContent = "copied";
      setTimeout(() => {
        copy.textContent = o;
      }, 900);
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);

  const running = status === "thinking" || status === "tooling" || status === "compressing";

  const onSend = (text: string) => {
    setTurnStartAt(performance.now());
    engine.startTurn(text);
    wsRef.current?.send({ type: "user_input", data: { text, session_key: session } });
  };

  const onStop = () => {
    wsRef.current?.send({ type: "interrupt", data: {} });
  };

  return (
    <div id="app">
      <TopBar
        connected={connected}
        theme={theme}
        onToggleTheme={() => setTheme((t) => (t === "light" ? "dark" : "light"))}
      />
      <div id="body">
        <Conversation msgs={msgs} engine={engine} onSend={onSend} />
      </div>
      <Composer
        running={running}
        status={status}
        model={model}
        turnStartAt={turnStartAt}
        onSend={onSend}
        onStop={onStop}
      />
    </div>
  );
}
