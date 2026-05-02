import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App.tsx";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root not found");

// `basename` is mount-aware: production builds use `/hub/`, dev uses `/`.
// Stripping the trailing slash matches react-router's expectation. Without
// this the SPA's <Link to="/vaults"> would resolve to /vaults at the origin
// root, blowing past the hub's reverse proxy and 404ing on tailnet.
createRoot(root).render(
  <StrictMode>
    <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, "")}>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
