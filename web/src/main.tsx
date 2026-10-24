import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "./theme.css";

createRoot(document.getElementById("root")!).render(<App />);

// Only the production build has a service worker: in development it would hold on to old code.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // no installable app, but the page works as before
    });
  });
}
