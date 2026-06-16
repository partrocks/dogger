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

## Next iteration (Phase 1 polish — optional)
- [ ] Native file/folder pickers for codebase path (Tauri dialog plugin)
      instead of free-text input.
- [ ] Inline confirm dialogs instead of `window.confirm` / `window.prompt`.

## Phase 2 (Docker execution)
- [ ] Startup check: probe for the Docker CLI/daemon; show a warning screen if
      missing or unreachable.
- [ ] Container selection lists only running containers via `docker ps`
      (Dogger does not manage containers — see rules.md).
- [ ] Before running a task, verify configured containers are running; warn
      otherwise.
- [ ] Rust command to run `main.sh` inside a container via `docker exec`.
- [ ] Decide how the task dir is exposed to the container (bind mount vs
      `docker cp`) — still open in decisions.md.
- [ ] Stream stdout/stderr live into the UI; show exit code.
- [ ] Per-task run history.

## Phase 3 (AI — not started)
- [ ] Generate/edit tasks from natural language.
- [ ] Summarise run output and suggest fixes.

## Open questions
See `context/decisions.md` → "Open questions".
