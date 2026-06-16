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

## Next iteration (Phase 1 continued)
- [ ] Persist projects to disk (decide JSON vs SQLite — see decisions.md).
- [ ] "New project" flow: create a managed project directory.
- [ ] "New task" flow: scaffold `<task>/main.sh` with a starter template.
- [ ] Read tasks from disk instead of `mockData.ts`.
- [ ] Configure containers per project (add/remove, set working dir) in the UI.
- [ ] Task detail view: list/edit files in the task directory.

## Phase 2 (Docker execution)
- [ ] Rust command to run `main.sh` inside a container via `docker exec`.
- [ ] Decide how the task dir is exposed to the container (mount/cp/volume).
- [ ] Stream stdout/stderr live into the UI; show exit code.
- [ ] Per-task run history.

## Phase 3 (AI — not started)
- [ ] Generate/edit tasks from natural language.
- [ ] Summarise run output and suggest fixes.

## Open questions
See `context/decisions.md` → "Open questions".
