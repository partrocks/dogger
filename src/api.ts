// Typed wrappers around the Rust Tauri commands defined in
// `src-tauri/src/lib.rs`. All persistence happens on the Rust side under
// `~/.dogger`; the UI only ever talks to disk through these functions.

import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
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

// ---- Phase 3: AI task generation -------------------------------------------

/**
 * One turn of prior conversation, sent back to the agent as context. Tool
 * rounds stay internal to a single generation, so history is just plain
 * `user`/`assistant` text turns (a deliberate v1 simplification).
 */
export interface AiMessage {
  role: "user" | "assistant";
  text: string;
}

/**
 * A user-selectable model. Mirrors the hardcoded list in `src-tauri/src/ai.rs`
 * (`ai::models`); `id` is sent verbatim to {@link generateTask}. The first
 * entry is treated as the default selection.
 */
export interface AiModel {
  id: string;
  label: string;
  provider: "openAi";
}

/** Models offered in the Generate tab, in display order. */
export const AI_MODELS: AiModel[] = [
  { id: "gpt-5.5", label: "GPT-5.5", provider: "openAi" },
  { id: "gpt-4o", label: "GPT-4o", provider: "openAi" },
  { id: "gpt-4o-mini", label: "GPT-4o mini", provider: "openAi" },
  { id: "gpt-4.1", label: "GPT-4.1", provider: "openAi" },
  { id: "gpt-4.1-mini", label: "GPT-4.1 mini", provider: "openAi" },
];

/**
 * Kick off an AI task generation. Resolves once the request has been validated
 * and the background agent loop has started; all further progress arrives via
 * the `ai-*` events ({@link onAiOutput} / {@link onAiTool} / {@link onAiFinished}).
 */
export function generateTask(input: {
  projectId: string;
  taskId: string;
  genId: string;
  model: string;
  prompt: string;
  history: AiMessage[];
}): Promise<void> {
  return invoke("generate_task", {
    projectId: input.projectId,
    taskId: input.taskId,
    genId: input.genId,
    model: input.model,
    prompt: input.prompt,
    history: input.history,
  });
}

/** Request cancellation of an in-flight generation by its `genId`. */
export function cancelGeneration(genId: string): Promise<void> {
  return invoke("cancel_generation", { genId });
}

/** Streamed assistant text delta for an in-flight generation. */
export interface AiOutputEvent {
  genId: string;
  delta: string;
}

/** Tool activity, so the UI can show "Read src/index.ts" etc. */
export interface AiToolEvent {
  genId: string;
  tool: string;
  summary: string;
  phase: "running" | "done" | "error";
}

/** Emitted exactly once when a generation ends (or fails to start). */
export interface AiFinishedEvent {
  genId: string;
  status: "success" | "error" | "cancelled";
  message?: string;
}

/** Subscribe to streamed assistant text deltas for AI task generation. */
export function onAiOutput(
  handler: (event: AiOutputEvent) => void,
): Promise<UnlistenFn> {
  return listen<AiOutputEvent>("dogger://ai-output", (e) =>
    handler(e.payload),
  );
}

/** Subscribe to the agent's tool-activity updates. */
export function onAiTool(
  handler: (event: AiToolEvent) => void,
): Promise<UnlistenFn> {
  return listen<AiToolEvent>("dogger://ai-tool", (e) => handler(e.payload));
}

/** Subscribe to generation-finished notifications (final status + message). */
export function onAiFinished(
  handler: (event: AiFinishedEvent) => void,
): Promise<UnlistenFn> {
  return listen<AiFinishedEvent>("dogger://ai-finished", (e) =>
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

/**
 * Ask the app to navigate to the Settings screen. Emits the same event the tray
 * uses, which the root `App` already listens for — so any component (e.g. the
 * Generate tab's token error) can route the user to Settings without prop
 * drilling a callback down the tree.
 */
export function requestOpenSettings(): Promise<void> {
  return emit("dogger://open-settings");
}

/**
 * Subscribe to the tray's "About Dogger" action, which asks the app to navigate
 * to the About screen after bringing the main window forward.
 */
export function onOpenAbout(handler: () => void): Promise<UnlistenFn> {
  return listen("dogger://open-about", () => handler());
}
