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

## 2026-06-16 — Task dir reaches the container via bind mount (SUPERSEDED)
Originally we planned to bind-mount the task directory into the running
container. Superseded by the `docker cp` decision below: a bind mount can only
be added when a container is *created*, which would require Dogger to manage
container lifecycle — forbidden by Rule 3. See the next entry.

## 2026-06-16 — Phase 2: task dir reaches the container via `docker cp`
Because Dogger only attaches to already-running containers (Rule 3) and a bind
mount cannot be added to a running container, the task directory is **copied**
into the target container at run time:

1. `docker exec <c> mkdir -p /tmp/dogger/<run-id>`
2. `docker cp <task-dir>/. <c>:/tmp/dogger/<run-id>`
3. `docker exec -w <container-working-dir> <c> sh -c '… exec bash main.sh
   else exec sh main.sh …'`

The runner prefers `bash` (the task template ships a bash shebang) but falls
back to `sh` for minimal images such as Alpine that don't include `bash` — they
would otherwise fail with `exec: "bash": executable file not found in $PATH`.

`main.sh` is invoked with the project's configured container working directory
(its codebase root) as the working directory, so scripts can assume they run
from the root of the codebase. Nothing is ever written into the project's own
codebase (Rule 1); only an ephemeral copy under `/tmp/dogger` inside the
container is created. Implemented in `src-tauri/src/docker.rs`.

## 2026-06-16 — Phase 2: live output via Tauri events, run history on disk
`run_task` spawns the `docker exec` on a background thread and streams
stdout/stderr line-by-line to the frontend as Tauri events
(`dogger://run-output`, `dogger://run-finished`), keyed by a client-generated
`runId`. The UI attaches its listeners *before* invoking `run_task` (guarded
against React StrictMode double-invocation) so no early output is dropped. Each
run is persisted as JSON under a hidden `~/.dogger/<project>/tasks/<task>/.runs/`
directory (written once at start with `status: "running"`, overwritten on
completion with the exit code and captured output). `.runs/` is hidden from the
task file editor because `list_task_files` only returns regular files.

## 2026-06-16 — Phase 2: container status derived from `docker ps`
Container `running` state is now computed live: the frontend polls
`list_running_containers` (every 5s while Docker is reachable) and matches each
configured container `reference` against running containers by name, full/short
id, or image (`matchesRunning` in `src/types.ts`, mirrored by
`is_container_running` in Rust). The persisted `running` flag is kept only as a
fallback for when Docker is unavailable. The config editor offers a picker of
running containers so selection lists only running ones (Rule 3), while still
allowing manual entry. A startup probe (`docker_status`) shows a full-screen
warning (with Retry / Continue) when the CLI is missing or the daemon is
unreachable.

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

## 2026-06-16 — Phase 1 polish: native folder picker + inline dialogs
Added the `tauri-plugin-dialog` plugin (JS `@tauri-apps/plugin-dialog`, Rust
`tauri-plugin-dialog`, `dialog:default` capability) so the codebase path can be
chosen with a native folder picker via a "Browse…" button; the field stays a
plain editable input so paths can still be typed/pasted. Replaced
`window.confirm`/`window.prompt` (unreliable/ugly inside the webview) with
in-app `ConfirmDialog` and `PromptDialog` components built on the existing
`Modal`, used for delete-project, delete-task, and add-task-file flows.

## 2026-06-16 — Shell is detected, not guessed
The runner previously hard-coded "bash, else sh". It now resolves the
interpreter per run: `detect_shell` probes the container (`command -v` over
`bash`/`zsh`/`sh`/`ash`/`dash`/`ksh`) and reads `main.sh`'s shebang. If the
shebang's shell is installed it wins (so `#!/bin/zsh` is honoured); otherwise
Dogger picks the best shell actually present, with `sh` as the last resort. The
exec stays `docker exec [-w wd] <c> sh -c 'exec <interp> <script>'`. A
`detect_container_shell` command lets the UI show the chosen interpreter (with
the shebang and available shells in its tooltip) on the task screen before
running. `set -euo pipefail` still lives in the `main.sh` template — strict mode
is the script's concern, and shell options don't survive into a child
interpreter anyway, so we did not move it into the exec line.

## 2026-06-16 — Syntax highlighting in the file editor
The task file editor uses `react-simple-code-editor` + Prism instead of a plain
`<textarea>`. Language is chosen by file extension in `src/highlight.ts` (shell,
JSON, JS/TS, PHP, YAML, Markdown; unknown types fall back to escaped plain
text). Token colours are defined in `App.css` scoped to `.code-editor` (tuned
for the light surface) rather than importing a Prism theme, because our `<pre>`
carries no `language-*` class for a stock theme to target.

## 2026-06-16 — One container per project (multi-container removed)
The multi-container-per-project model was dropped: it was confusing and rarely
useful. A project now attaches to a single container, stored as a `container`
reference string on `project.json` (replacing the `containers[]` array).
`ProjectFile` keeps a `#[serde(skip_serializing)]` legacy `containers` field so
existing project files still load — `load_project` migrates by taking the first
non-empty `reference` — but Dogger never writes `containers` back. Frontend:
`Project.container: string`, `getProjectStatus(project, running)` is online only
when that container matches a running one. The per-task container `<select>`
dropdowns in `TaskRow`/`TaskDetail` are gone; runs always target the project's
container. The `DockerContainer` type was removed from `src/types.ts`.

## 2026-06-16 — Container chosen in the New Project form, with path validation
The New Project form now picks a container up front (and Configure shares the
same `ContainerField` component): a `<select>` of live `docker ps` containers
(Rule 3) with a manual-entry fallback when Docker is down / none are running.
After choosing a container, the container working directory is validated against
it via a new `check_container_path` command (`docker exec <c> test -d <path>`,
run directly so the path needs no shell quoting). The form shows a live
exists/not-found indicator and blocks create/save when the path is missing
(only when a container is selected and Docker is reachable).

## Open questions
- (resolved) **Output streaming:** stream `main.sh` stdout/stderr live into the
  UI — done via Tauri events in Phase 2 (see above).
