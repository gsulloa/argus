import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "@/app/App";
import { APP_DISPLAY_NAME } from "@/platform/app-identity";
import "@/styles/global.css";

// Single source of truth for the live window/document title. The static
// `<title>` in index.html is only the pre-hydration fallback (see RENAMING.md).
document.title = APP_DISPLAY_NAME;

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("#root not found");

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
