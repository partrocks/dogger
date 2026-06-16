// Core data model for Dogger.
//
// These types describe the shape of a project and its tasks as loaded from
// disk (`~/.dogger`) via the Tauri commands in `src/api.ts`. They mirror the
// Rust structs in `src-tauri/src/storage.rs`. Real Docker execution comes in a
// later iteration — see context/todo.md.

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
  /**
   * Reference (name/id/image) of the single container this project runs tasks
   * in. Empty when no container has been configured yet.
   */
  container: string;
  tasks: Task[];
}

/**
 * A project's status is derived from its container, not stored:
 * - `online`  — it has a container and that container is currently running.
 * - `offline` — no container configured, or it isn't running (or Docker is
 *   unavailable so we can't confirm it).
 */
export type ProjectStatus = "online" | "offline";

export function getProjectStatus(
  project: Project,
  running: RunningContainer[] | null,
): ProjectStatus {
  if (!project.container || !running) return "offline";
  return matchesRunning(project.container, running) ? "online" : "offline";
}

/** Result of probing the local Docker CLI/daemon (Phase 2). */
export interface DockerStatus {
  cliInstalled: boolean;
  daemonRunning: boolean;
  serverVersion: string | null;
  message: string | null;
}

/** A container currently running on the host (`docker ps`). */
export interface RunningContainer {
  id: string;
  name: string;
  image: string;
  status: string;
}

/**
 * What Dogger detected about how a task's `main.sh` will run inside a
 * container: which shells exist there, the script's shebang, and the
 * interpreter actually chosen. Mirrors `ShellInfo` in `src-tauri/src/docker.rs`.
 */
export interface ShellInfo {
  /** Shells found on `PATH` inside the container. */
  available: string[];
  /** The interpreter Dogger will invoke (`bash`, `zsh`, `sh`, …). */
  interpreter: string;
  /** The raw shebang line parsed from `main.sh`, if present. */
  shebang: string | null;
  /** Coarse family of the chosen interpreter. */
  family: "bash" | "zsh" | "posix";
}

export type RunStatus = "running" | "success" | "failed" | "error";

export interface OutputLine {
  stream: "stdout" | "stderr";
  text: string;
}

/** A persisted record of a single task run. Timestamps are epoch millis. */
export interface RunRecord {
  id: string;
  container: string;
  command: string;
  startedAt: number;
  finishedAt: number | null;
  exitCode: number | null;
  status: RunStatus;
  output: OutputLine[];
}

/**
 * Decide whether a configured container `reference` is among the running
 * containers reported by `docker ps`. Matches by exact name, full/short id, or
 * image — mirroring the Rust-side `is_container_running`.
 */
export function matchesRunning(
  reference: string,
  running: RunningContainer[],
): boolean {
  const ref = reference.trim();
  if (!ref) return false;
  return running.some(
    (c) =>
      c.name === ref ||
      c.id === ref ||
      c.id.startsWith(ref) ||
      c.image === ref,
  );
}
