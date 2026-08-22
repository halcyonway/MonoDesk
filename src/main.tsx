import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

// 不启用 StrictMode：避免 dev 下 WS 双连接。
createRoot(document.getElementById("root")!).render(<App />);
