import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { RunnerWindow } from "./components/RunnerWindow";
import "./App.css";

// The runner windows opened from the tray load this same bundle with
// `?view=runner&project=<id>&task=<id>`, so we branch on the query params and
// render the dedicated single-task runner instead of the full app.
const params = new URLSearchParams(window.location.search);
const isRunner = params.get("view") === "runner";
const projectId = params.get("project") ?? "";
const taskId = params.get("task") ?? "";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {isRunner ? (
      <RunnerWindow projectId={projectId} taskId={taskId} />
    ) : (
      <App />
    )}
  </React.StrictMode>,
);
