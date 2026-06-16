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
