// Core data model for Dogger.
//
// These types describe the shape of a project and its tasks as loaded from
// disk (`~/.dogger`) via the Tauri commands in `src/api.ts`. They mirror the
// Rust structs in `src-tauri/src/storage.rs`. Real Docker execution comes in a
// later iteration — see context/todo.md.

export interface DockerContainer {
  id: string;
  /** Human-friendly label shown in the UI. */
  name: string;
  /** Container name or image reference used by `docker exec` later. */
  reference: string;
  /**
   * Whether this container is currently running on the host. At runtime this is
   * derived from `docker ps`; in Phase 1 it is mocked.
   */
  running: boolean;
}

export interface Task {
  id: string;
  name: string;
  /**
   * Directory (relative to the project's tasks folder) that holds this task.
   * Every task directory must contain a `main.sh` entrypoint plus any
   * supporting resources (php/node/json/etc).
   */
  dir: string;
  description?: string;
}

export interface Project {
  id: string;
  name: string;
  /** Dogger-managed directory holding this project's tasks (`~/.dogger/<id>`). */
  projectDir: string;
  /** Absolute path to the project's own (read-only) codebase, if configured. */
  codebasePath: string;
  /** Working directory *inside* the container where tasks should execute. */
  containerWorkingDir: string;
  containers: DockerContainer[];
  tasks: Task[];
}

/**
 * A project's status is derived from its containers, not stored:
 * - `online`  — it has containers and every one of them is running.
 * - `offline` — one or more containers are not running (or it has none).
 */
export type ProjectStatus = "online" | "offline";

export function getProjectStatus(project: Project): ProjectStatus {
  if (project.containers.length === 0) return "offline";
  return project.containers.every((c) => c.running) ? "online" : "offline";
}
