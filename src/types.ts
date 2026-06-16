// Core data model for Dogger (Phase 1).
//
// These types describe the in-memory shape of a project and its tasks.
// They are intentionally simple: Phase 1 only renders this structure in the
// UI. Persistence (disk/SQLite) and real Docker execution come in later
// iterations — see context/todo.md.

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
  /** Local directory managed by Dogger that holds this project's tasks. */
  projectDir: string;
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
