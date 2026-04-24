import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App.tsx";
import "./index.css";

// Register a minimal service worker so Chrome / Brave on Android treat the
// site as an installable PWA (they require a live SW with a fetch handler).
// The SW itself doesn't cache anything — see public/sw.js.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      /* ignore registration failures; falls back to browser-shortcut behavior */
    });
  });
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
