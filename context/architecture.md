# Dogger — Architecture

## Stack

- **Shell:** Tauri 2 (Rust backend + system webview) — small binaries, native
  shell/Docker access via Rust.
- **Frontend:** React 19 + TypeScript, bundled with Vite.
- **Target:** macOS desktop (local dev first).
- **Build/dev orchestration:** `Makefile` wrapping the Tauri CLI.

## Repository layout

```
dogger/
  context/            # Project memory (this folder)
    rules.md          # Non-negotiable core principles (read-only codebases, etc.)
  index.html          # Vite entry
  src/                # React frontend
    App.tsx           # Phase 1 UI shell (sidebar + main area)
    App.css
    types.ts          # Core data model (Project, Task, DockerContainer)
    mockData.ts       # Placeholder projects for the shell
  src-tauri/          # Rust backend
    src/lib.rs        # Tauri commands live here
    src/main.rs
    tauri.conf.json   # Window title, identifier, bundle config
    Cargo.toml
  Makefile            # dev / build / check / clean
```

## Data model (Phase 1)

See `src/types.ts`. Held in memory only for now.

- `Project { id, name, projectDir, containerWorkingDir, containers[], tasks[] }`
- `Task { id, name, dir, description? }` — `dir` resolves to a folder containing
  `main.sh`.
- `DockerContainer { id, name, reference, running }` — `reference` is the docker
  container/image used by `docker exec` later; `running` reflects host state.
- **Project status is derived, not stored:** `getProjectStatus(project)` returns
  `online` only when the project has containers and all are running, else
  `offline`. (Runtime: from `docker ps`; mocked in Phase 1.)

## Storage layout (decided)

Persistence is **plain JSON** (no SQLite). All Dogger-managed state lives in a
home directory Dogger creates under the host user's home: `~/.dogger`. It is
created on first run if missing. Nothing is written into a project's own
codebase (see `rules.md`).

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

## Docker model (decided)

- Dogger **does not manage** containers — no create/build/start/stop/compose.
  It only interacts with containers already running on the host.
- The Docker CLI is **assumed installed**. Dogger probes for it at startup
  (e.g. `docker version`) and shows a warning screen if it is missing or the
  daemon is unreachable.
- Container selection lists only **running** containers (`docker ps`).
- Before running a task, Dogger verifies the project's configured containers are
  running and warns otherwise.

## Execution model (planned, Phase 2)

Run a task by executing its `main.sh` inside the chosen container:

```
docker exec -w <containerWorkingDir> <container> sh -c 'exec <interp> <task-dir>/main.sh'
```

`<interp>` is resolved per run by `docker::detect_shell` (probe the container's
available shells + honour the script's shebang), not hard-coded to bash.

The task directory lives in `~/.dogger/.../tasks/<task>` (outside the codebase).
How it becomes visible to the container — bind mount vs `docker cp` — is the one
remaining open question (tracked in `decisions.md` / `todo.md`); since the
codebase is read-only, we cannot rely on writing the task into a project volume.

## Frontend ↔ backend boundary

- The frontend stays presentational; all filesystem and Docker work happens in
  Rust via `#[tauri::command]` functions invoked through `@tauri-apps/api`.
- Phase 1 has no commands wired into the UI yet (scaffold `greet` command
  remains as a reference example).
