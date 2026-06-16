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
- `DockerContainer { id, name, reference }` — `reference` is the docker
  container/image used by `docker exec` later.

## Execution model (planned, Phase 2)

Run a task by executing its `main.sh` inside the chosen container:

```
docker exec -w <containerWorkingDir> <container> bash <mounted-task-dir>/main.sh
```

Open questions about exactly how the task directory becomes visible to the
container (bind mount vs `docker cp` vs already-mounted project volume) are
tracked in `decisions.md` / `todo.md`.

## Frontend ↔ backend boundary

- The frontend stays presentational; all filesystem and Docker work happens in
  Rust via `#[tauri::command]` functions invoked through `@tauri-apps/api`.
- Phase 1 has no commands wired into the UI yet (scaffold `greet` command
  remains as a reference example).
