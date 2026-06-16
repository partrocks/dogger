// Typed wrappers around the Rust Tauri commands defined in
// `src-tauri/src/lib.rs`. All persistence happens on the Rust side under
// `~/.dogger`; the UI only ever talks to disk through these functions.

import { invoke } from "@tauri-apps/api/core";
import type { DockerContainer, Project, Task } from "./types";

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
