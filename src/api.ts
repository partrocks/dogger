// Typed wrappers around the Rust Tauri commands defined in
// `src-tauri/src/lib.rs`. All persistence happens on the Rust side under
// `~/.dogger`; the UI only ever talks to disk through these functions.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";
import type {
  DockerContainer,
  DockerStatus,
  Project,
  RunningContainer,
  RunRecord,
  Task,
} from "./types";

export function listProjects(): Promise<Project[]> {
  return invoke("list_projects");
}

export function createProject(input: {
  name: string;
  codebasePath?: string;
  containerWorkingDir?: string;
}): Promise<Project> {
  return invoke("create_project", {
    name: input.name,
    codebasePath: input.codebasePath ?? "",
    containerWorkingDir: input.containerWorkingDir ?? "",
  });
}

export function updateProject(input: {
  id: string;
  name: string;
  codebasePath: string;
  containerWorkingDir: string;
  containers: DockerContainer[];
}): Promise<Project> {
  return invoke("update_project", {
    id: input.id,
    name: input.name,
    codebasePath: input.codebasePath,
    containerWorkingDir: input.containerWorkingDir,
    containers: input.containers,
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
