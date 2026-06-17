// Typed wrappers around the Rust Tauri commands defined in
// `src-tauri/src/lib.rs`. All persistence happens on the Rust side under
// `~/.dogger`; the UI only ever talks to disk through these functions.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";
import type {
  DockerStatus,
  Project,
  RunningContainer,
  RunRecord,
  ShellInfo,
  Task,
} from "./types";

export function listProjects(): Promise<Project[]> {
  return invoke("list_projects");
}

export function createProject(input: {
  name: string;
  codebasePath?: string;
  containerWorkingDir?: string;
  container?: string;
}): Promise<Project> {
  return invoke("create_project", {
    name: input.name,
    codebasePath: input.codebasePath ?? "",
    containerWorkingDir: input.containerWorkingDir ?? "",
    container: input.container ?? "",
  });
}

export function updateProject(input: {
  id: string;
  name: string;
  codebasePath: string;
  containerWorkingDir: string;
  container: string;
}): Promise<Project> {
  return invoke("update_project", {
    id: input.id,
    name: input.name,
    codebasePath: input.codebasePath,
    containerWorkingDir: input.containerWorkingDir,
    container: input.container,
  });
}

export function deleteProject(id: string): Promise<void> {
  return invoke("delete_project", { id });
}

export function createTask(input: {
  projectId: string;
  name: string;
  description?: string;
}): Promise<Task> {
  return invoke("create_task", {
    projectId: input.projectId,
    name: input.name,
    description: input.description ?? null,
  });
}

export function updateTask(input: {
  projectId: string;
  taskId: string;
  name: string;
  description?: string;
}): Promise<Task> {
  return invoke("update_task", {
    projectId: input.projectId,
    taskId: input.taskId,
    name: input.name,
    description: input.description ?? null,
  });
}

export function deleteTask(projectId: string, taskId: string): Promise<void> {
  return invoke("delete_task", { projectId, taskId });
}

export function listTaskFiles(
  projectId: string,
  taskId: string,
): Promise<string[]> {
  return invoke("list_task_files", { projectId, taskId });
}

export function readTaskFile(
  projectId: string,
  taskId: string,
  file: string,
): Promise<string> {
  return invoke("read_task_file", { projectId, taskId, file });
}

export function writeTaskFile(
  projectId: string,
  taskId: string,
  file: string,
  contents: string,
): Promise<void> {
  return invoke("write_task_file", { projectId, taskId, file, contents });
}

// ---- Phase 2: Docker execution ---------------------------------------------

export function dockerStatus(): Promise<DockerStatus> {
  return invoke("docker_status");
}

export function listRunningContainers(): Promise<RunningContainer[]> {
  return invoke("list_running_containers");
}

/**
 * Check whether `path` exists as a directory inside `container`. Rejects when
 * the container isn't running, so callers can distinguish "not running" from
 * "path missing".
 */
export function checkContainerPath(
  container: string,
  path: string,
): Promise<boolean> {
  return invoke("check_container_path", { container, path });
}

/** Probe a container for the shell that will run a task's `main.sh`. */
export function detectContainerShell(
  projectId: string,
  taskId: string,
  container: string,
): Promise<ShellInfo> {
  return invoke("detect_container_shell", { projectId, taskId, container });
}

export function listRuns(
  projectId: string,
  taskId: string,
): Promise<RunRecord[]> {
  return invoke("list_runs", { projectId, taskId });
}

export function runTask(input: {
  projectId: string;
  taskId: string;
  container: string;
  runId: string;
}): Promise<RunRecord> {
  return invoke("run_task", {
    projectId: input.projectId,
    taskId: input.taskId,
    container: input.container,
    runId: input.runId,
  });
}

export interface RunOutputEvent {
  runId: string;
  stream: "stdout" | "stderr";
  line: string;
}

export interface RunFinishedEvent {
  runId: string;
  exitCode: number | null;
  status: RunRecord["status"];
}

/** Subscribe to streamed output lines for in-flight task runs. */
export function onRunOutput(
  handler: (event: RunOutputEvent) => void,
): Promise<UnlistenFn> {
  return listen<RunOutputEvent>("dogger://run-output", (e) =>
    handler(e.payload),
  );
}

/** Subscribe to run-finished notifications (exit code + final status). */
export function onRunFinished(
  handler: (event: RunFinishedEvent) => void,
): Promise<UnlistenFn> {
  return listen<RunFinishedEvent>("dogger://run-finished", (e) =>
    handler(e.payload),
  );
}

// ---- Tray menu -------------------------------------------------------------

/** A task as surfaced in the tray menu (subset of {@link Task}). */
export interface TrayTask {
  id: string;
  name: string;
}

/** An online project (its container is running) plus its tasks, for the tray. */
export interface TrayProject {
  id: string;
  name: string;
  tasks: TrayTask[];
}

/**
 * Push the current set of online projects (and their tasks) to the macOS tray
 * menu. The frontend owns the single Docker poll, so it drives the menu rather
 * than the backend polling `docker ps` a second time.
 */
export function setTrayMenu(projects: TrayProject[]): Promise<void> {
  return invoke("set_tray_menu", { projects });
}

// ---- Settings --------------------------------------------------------------

/** User-editable settings, persisted in `~/.dogger/config.json`. */
export interface Settings {
  /**
   * Show the main window on launch. When `false`, Dogger starts hidden in the
   * tray. Takes effect on the next launch.
   */
  openOnStartup: boolean;
  /** OpenAI API token. */
  openaiToken: string;
}

/** Read the persisted settings. */
export function getSettings(): Promise<Settings> {
  return invoke("get_settings");
}

/** Persist settings to `~/.dogger/config.json`. */
export function saveSettings(settings: Settings): Promise<void> {
  return invoke("save_settings", { settings });
}

/**
 * Subscribe to the tray's "Settings…" action, which asks the app to navigate to
 * the Settings screen after bringing the main window forward.
 */
export function onOpenSettings(handler: () => void): Promise<UnlistenFn> {
  return listen("dogger://open-settings", () => handler());
}
