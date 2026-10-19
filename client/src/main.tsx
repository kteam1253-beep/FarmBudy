import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

window.onerror = (msg, src, line, col, err) => {
  console.error('[GLOBAL ERROR]', msg, src, line, col, err);
  const el = document.getElementById('global-error');
  if (el) el.textContent = `Error: ${msg} at ${src}:${line}:${col}`;
};
window.onunhandledrejection = (e) => {
  console.error('[UNHANDLED REJECTION]', e.reason);
};

createRoot(document.getElementById("root")!).render(<App />);
