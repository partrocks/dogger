import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { RunnerWindow } from "./components/RunnerWindow";
import { TrayPanel } from "./components/TrayPanel";
import "./App.css";

// Auxiliary windows load this same bundle with a `?view=` query param, so we
// branch here and render the dedicated UI instead of the full app:
//   ?view=runner&project=<id>&task=<id>  — single-task runner window
//   ?view=tray                           — menu bar popover panel
const params = new URLSearchParams(window.location.search);
const view = params.get("view");
const projectId = params.get("project") ?? "";
const taskId = params.get("task") ?? "";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {view === "tray" ? (
      <TrayPanel />
    ) : view === "runner" ? (
      <RunnerWindow projectId={projectId} taskId={taskId} />
    ) : (
      <App />
    )}
  </React.StrictMode>,
);
