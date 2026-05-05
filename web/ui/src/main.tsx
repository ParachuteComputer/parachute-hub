import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App.tsx";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root not found");

// Dual-mount basename detection. The SPA serves at /vault (primary, since
// hub#168-realignment) and /hub (back-compat for /hub/permissions). The
// bundle is identical at both — `import.meta.env.BASE_URL` points at the
// build base (/vault/) regardless of which mount served us — but react-
// router needs the *runtime* mount so <Link to="/"> resolves under the
// right one. Without this, a user landing at /hub/permissions would have
// the router try to strip /vault from a /hub URL and refuse to render.
function detectBasename(): string {
  const path = window.location.pathname;
  if (path === "/hub" || path.startsWith("/hub/")) return "/hub";
  if (path === "/vault" || path.startsWith("/vault/")) return "/vault";
  // Stand-alone dev served at origin root (VITE_BASE_PATH=/).
  return "";
}

createRoot(root).render(
  <StrictMode>
    <BrowserRouter basename={detectBasename()}>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
