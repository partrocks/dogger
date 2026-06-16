# Dogger — Architectural Decisions

A running log. Append a new entry whenever a meaningful decision is made.

## 2026-06-16 — Use Tauri 2 (not Electron)
Smaller binaries, native Rust backend for shell/Docker access, good macOS
support. Matches the brief.

## 2026-06-16 — Frontend: React + TypeScript via Vite
Chosen over vanilla TS because the project/task UI benefits from component
structure, and it is still the standard small Tauri template. TypeScript for
safety on the data model.

## 2026-06-16 — Tasks are directories with a required `main.sh`
A task is a folder, not a single file, so it can carry supporting resources
(PHP/Node/JSON/etc). `main.sh` is the universal entrypoint Dogger invokes. This
keeps execution language-agnostic.

## 2026-06-16 — Phase 1 ships a UI shell with mock data, no execution
Deliberately no Docker execution and no persistence yet. Validate the structure
and UX first (per the brief: "small working app over a large unfinished
structure"). Mock projects live in `src/mockData.ts`.

## 2026-06-16 — Makefile is the entrypoint for dev/build/check/clean
`make dev` is the canonical way to start the app locally. The Makefile wraps the
local Tauri CLI from `node_modules` so no global install is required.

## 2026-06-16 — Persistence: plain JSON (no SQLite)
Project and task metadata is stored as plain JSON. Chosen for transparency,
human-readability, and ease of inspection/versioning. No database dependency.

## 2026-06-16 — Dogger state lives in `~/.dogger`, external to any codebase
Dogger keeps all of its managed state in a home directory it creates under the
host user's home: `~/.dogger`. It is created on first run if absent. Nothing
Dogger manages is written inside a project's own codebase. Layout:

```
~/.dogger/
  projects.json                 # index of known projects (optional/derived)
  <project-id>/
    project.json                # name, container working dir, container refs
    tasks/
      <task-id>/
        task.json               # task metadata (name, description)
        main.sh                 # required entrypoint
        ...                     # supporting resources
```

This makes the "project codebase is read-only" rule (see `rules.md`) trivial to
uphold: task content and metadata never touch the project repo.

## 2026-06-16 — Project codebases are read-only (see rules.md)
A core, non-negotiable principle: Dogger must never modify the files of a
project's own codebase. It only reads from them and runs tasks against them
inside containers. Captured formally in `rules.md`.

## 2026-06-16 — Docker CLI assumed installed; checked at startup
Dogger assumes the Docker CLI is installed and available on `PATH`. On startup
it probes for it (e.g. `docker version`) and shows a clear warning screen if it
is missing or the daemon is unreachable. Before running a task it verifies the
project's configured containers are actually running, and warns otherwise.

## 2026-06-16 — Dogger does not manage containers; it attaches to running ones
Dogger does not create, build, start, stop, or orchestrate containers (no
`docker-compose` management). It only interacts with already-running containers
on the host. Consequently, when picking a container for a project the container
must already be running so Dogger can list it (`docker ps`) for selection.

## 2026-06-16 — Project online/offline status is derived from its containers
A project is **online** only when it has containers and **all** of them are
running; if any configured container is not running (or it has none) the project
is **offline**. This status is computed (from `docker ps` at runtime; mocked in
Phase 1), never stored. Offline projects can't run tasks. Implemented as
`getProjectStatus()` in `src/types.ts`, surfaced as a dot/badge in the UI.

## 2026-06-16 — Task dir reaches the container via bind mount
At run time the task directory (`~/.dogger/.../tasks/<task>`) is bind-mounted
into the running container, rather than copied in with `docker cp`. This keeps
task content outside the project's own mounted volume, upholding the read-only
rule (we never write into the project's codebase). `main.sh` is always invoked
with the project's codebase root as the working directory inside the container,
so scripts can assume they run from the root of the codebase.

## 2026-06-16 — Persistence implemented in a Rust `storage` module
All `~/.dogger` disk access lives in `src-tauri/src/storage.rs`, exposed to the
frontend as Tauri commands (`list_projects`, `create_project`, `update_project`,
`delete_project`, `create_task`, `delete_task`, `list_task_files`,
`read_task_file`, `write_task_file`). The frontend never touches the filesystem
directly — it goes through typed wrappers in `src/api.ts`. Project ids are
slugified directory names (uniqued with `-2`, `-3`…); a task's `id`/`dir` is its
folder name. All frontend-supplied ids/filenames are sanitised to a single safe
path component to prevent traversal outside `~/.dogger`. The `dirs` crate
resolves the home directory.

## 2026-06-16 — `~/.dogger` is seeded with example projects on first run
The first time `~/.dogger` is created it is seeded with the two former mock
projects (Acme API, Marketing Site) so the app is browsable out of the box.
`src/mockData.ts` was removed; data now comes only from disk.

## 2026-06-16 — Container `running` is a temporary persisted mock
Per the earlier decision, `running` should be derived from `docker ps` (Phase 2)
and not stored. Until Phase 2 lands, `running` is persisted in `project.json`
and exposed as a toggle in the container editor purely so the online/offline
status feature stays demonstrable. To revisit when real Docker probing exists.

## Open questions
- **Output streaming:** how to stream `main.sh` stdout/stderr live into the UI.
