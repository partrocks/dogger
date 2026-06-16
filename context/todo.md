# Dogger — TODO / Progress

Update this after each meaningful step.

## Done
- [x] Scaffold Tauri 2 + React + TypeScript project (Vite).
- [x] Rename product/window/page title to **Dogger**.
- [x] Create `context/` project memory files.
- [x] Add `Makefile` (`dev`, `build`, `check`, `clean`).
- [x] Phase 1 UI shell: app title, project sidebar, project detail main area,
      task list with placeholder (disabled) Run buttons.
- [x] Define core data model in `src/types.ts` + mock data in `src/mockData.ts`.
- [x] Verify `make dev` compiles the Rust backend and launches the desktop window.

## Phase 1 continued (done)
- [x] Persist projects to disk as plain JSON under `~/.dogger`. `~/.dogger` is
      created on first run and seeded with example projects (Rust:
      `src-tauri/src/storage.rs`).
- [x] "New project" flow: creates a managed `~/.dogger/<project-id>/` directory
      with `project.json` (never writes into the project's own codebase).
- [x] "New task" flow: scaffolds `<task>/main.sh` (chmod +x) from a starter
      template, plus `task.json`.
- [x] Read projects/tasks from disk via Tauri commands instead of
      `mockData.ts` (removed); frontend wrappers in `src/api.ts`.
- [x] Configure containers per project (add/remove, set working dir, codebase
      path) in the UI — `ProjectConfigEditor`.
- [x] Task detail view: list and edit files in the task directory; save writes
      back to disk (`main.sh` stays executable).

## Phase 1 polish (done)
- [x] Native folder picker for codebase path (Tauri dialog plugin) alongside
      the editable text input — `CodebasePathField` in `src/App.tsx`, used by
      both the new-project and configure-project flows.
- [x] Inline confirm/prompt dialogs instead of `window.confirm` /
      `window.prompt` — `ConfirmDialog` (delete project/task) and `PromptDialog`
      (add task file) in `src/App.tsx`.

## Phase 2 (Docker execution) — done
- [x] Startup check: probe for the Docker CLI/daemon; show a warning screen if
      missing or unreachable (`docker_status`; `DockerWarning` in `App.tsx`).
- [x] Container selection lists only running containers via `docker ps`
      (`list_running_containers`; running-container picker in the config
      editor). Status is derived live, no longer a stored mock.
- [x] Before running a task, verify configured containers are running; warn
      otherwise (Run buttons disabled when no running container; `run_task`
      re-checks server-side via `is_container_running`).
- [x] Rust command to run `main.sh` inside a container via `docker exec`
      (`src-tauri/src/docker.rs::run_task`).
- [x] Task dir exposed to the container via `docker cp` (bind mount rejected —
      can't add mounts to a running container; see decisions.md).
- [x] Stream stdout/stderr live into the UI; show exit code (Tauri events
      `dogger://run-output` / `dogger://run-finished`; `RunConsole`).
- [x] Per-task run history (persisted under `tasks/<task>/.runs/`; `list_runs`;
      `RunHistory`).

## Phase 2 polish — done
- [x] Detect the container's shell instead of guessing bash/sh: probe the
      container for available shells (`bash`/`zsh`/`sh`/`ash`/`dash`/`ksh`) and
      honour `main.sh`'s shebang, falling back to the best shell present
      (`docker::detect_shell`; `detect_container_shell` command). The resolved
      interpreter is shown in the task header before running.
- [x] Syntax highlighting in the task file editor (Prism via
      `react-simple-code-editor`): shell, JSON, JS/TS, PHP, YAML, Markdown,
      picked by file extension (`src/highlight.ts`).

## Container model simplification — done
- [x] Collapse multi-container projects to a single `container` reference
      (storage.rs / lib.rs / types.ts / api.ts), with legacy migration from the
      old `containers[]` array on read.
- [x] Choose the container in the New Project form (shared `ContainerField`,
      also used by Configure): select from live `docker ps`, manual fallback.
- [x] Validate the container working directory exists in the chosen container
      before creating/saving (`check_container_path`; live indicator + submit
      guard).

## App-level config — done
- [x] Top-level app memory in `~/.dogger/config.json` (`AppConfig`/`WindowState`
      in `storage.rs`). Restores the main window's position + size on startup and
      persists them on move/resize/close (`restore_window_state` /
      `persist_window_state` in `lib.rs`).

## Phase 3 (AI — not started)
- [ ] Generate/edit tasks from natural language.
- [ ] Summarise run output and suggest fixes.

## Open questions
See `context/decisions.md` → "Open questions".
