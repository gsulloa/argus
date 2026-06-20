import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ManagerApp } from "@/app/ManagerApp";
import { WorkspaceApp } from "@/app/WorkspaceApp";
import { APP_DISPLAY_NAME } from "@/platform/app-identity";
import "@/styles/global.css";

// Single source of truth for the live window/document title. The static
// `<title>` in index.html is only the pre-hydration fallback (see RENAMING.md).
document.title = APP_DISPLAY_NAME;

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("#root not found");

// Route to a role-specific root component based on the Tauri window label.
// The `manager` window is created at startup (declared in tauri.conf.json);
// the `workspace` window is created on demand via `ensure_workspace_window`.
// Both windows load the same bundle; the label is the authoritative routing key.
const windowLabel = getCurrentWindow().label;
const RootComponent = windowLabel === "workspace" ? WorkspaceApp : ManagerApp;

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <RootComponent />
  </React.StrictMode>,
);
