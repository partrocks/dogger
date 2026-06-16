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

## Open questions
- **Persistence:** flat JSON files per project vs SQLite? (Leaning JSON for
  transparency/versionability.)
- **Where do task directories live on disk** relative to the project directory?
  (e.g. `<projectDir>/tasks/<task>/main.sh`.)
- **How does the task dir reach the container** at run time: bind mount the task
  dir, `docker cp`, or assume the project is already mounted as a volume?
- **Container config:** does Dogger manage `docker-compose`, or just reference
  existing running containers by name?
- **Output streaming:** how to stream `main.sh` stdout/stderr live into the UI.
