# Dogger

**Your Development Docker Dog**

Dogger is a macOS desktop app for organising and running reusable shell-script tasks inside Docker containers. It gives one-off scripts — migrations, seeders, builds, codegen, and the like — a structured home: a per-project library you can run with one click from the menu bar or the main dashboard.

## Why Dogger?

Developers accumulate scripts that need to run *inside* a specific container, from a specific working directory, against a specific codebase. Dogger keeps those scripts organised without touching your project files. All task definitions and run history live in `~/.dogger`; your repository stays read-only.

## Features

- **Projects and tasks** — Group tasks by project, each tied to a Docker container and a container working directory.
- **Docker execution** — Run a task's `main.sh` inside a running container via `docker cp` + `docker exec`, with live stdout/stderr streaming and run history.
- **Shell detection** — Probes the container for available shells and honours the script's shebang before running.
- **Task editor** — Edit `main.sh` and supporting files (PHP, Node, JSON, YAML, etc.) with syntax highlighting.
- **AI task generation** — Describe a task in natural language and let Dogger scaffold files by reading your codebase (requires an OpenAI API key in Settings).
- **Menu bar app** — Tray icon with quick access to online projects and tasks; optional launch-at-login and background startup.
- **Runner windows** — Launch a compact runner for any task directly from the tray.

## Install

Dogger is a macOS app for **Apple Silicon** (M1 or newer).

> **Note:** Dogger is not yet signed with an Apple Developer ID. The Homebrew cask
> clears quarantine on install; manual installs need the `xattr` step below.

### Homebrew (recommended)

```bash
brew install --cask partrocks/tap/dogger
```

Upgrade later with:

```bash
brew upgrade --cask dogger
```

### Install script

```bash
curl -fsSL https://doggerapp.com/install.sh | bash
```

This downloads the latest release, installs **Dogger.app** into `/Applications`, and
clears the quarantine flag so it opens normally.

### Manual download

Grab the `.dmg` from the [latest GitHub release](https://github.com/partrocks/dogger/releases/latest),
drag **Dogger** to `/Applications`, then clear the quarantine flag once:

```bash
xattr -dr com.apple.quarantine /Applications/Dogger.app
```

## Requirements

- **macOS** (primary target; Tauri also bundles for other platforms)
- **Docker** — CLI installed and daemon running. Dogger does not start or manage containers; it only runs tasks in containers that are already up.
- **Node.js** (v18+) and **npm**
- **Rust** toolchain (for the Tauri backend)

## Getting started

```bash
# Install dependencies
make install

# Run the app locally (starts Vite + the desktop window)
make dev
```

To build a distributable macOS app bundle:

```bash
make build
```

Run type checks before committing:

```bash
make check
```

## How it works

### Projects

A **project** represents one codebase + one Docker container:

| Field | Purpose |
| --- | --- |
| **Name** | Display name in the sidebar |
| **Codebase path** | Absolute path to your repository (read-only; Dogger never writes here) |
| **Container** | A running container from `docker ps` |
| **Container working dir** | Directory inside the container where tasks execute |

Project status is derived live: a project is **online** when its configured container is currently running.

### Tasks

A **task** is a directory under `~/.dogger/<project-id>/tasks/<task-id>/` containing:

- `main.sh` — required entrypoint (must be executable)
- `task.json` — name and optional description
- Supporting files as needed (scripts, config, etc.)

Dogger copies the task directory into the container, then runs `main.sh` with the best available shell.

### Storage

All Dogger-managed state lives in `~/.dogger`:

```
~/.dogger/
  config.json                     # app settings, window geometry, OpenAI token
  <project-id>/
    project.json                  # project metadata
    tasks/
      <task-id>/
        task.json
        main.sh
        .runs/                    # persisted run history
```

## Design principles

1. **Project codebases are read-only** — Dogger never creates, edits, or deletes files inside your repository.
2. **State lives in `~/.dogger`** — Metadata, scripts, and run history are kept separate from your code.
3. **Dogger does not manage containers** — Start containers yourself (Docker Desktop, `docker compose`, etc.); Dogger only interacts with what's already running.

## Tech stack

| Layer | Technology |
| --- | --- |
| Desktop shell | [Tauri 2](https://tauri.app/) (Rust) |
| Frontend | React 19, TypeScript, Vite |
| Persistence | Plain JSON on disk |
| Execution | Docker CLI (`docker ps`, `docker cp`, `docker exec`) |
| AI (optional) | OpenAI API via Rust (`src-tauri/src/ai.rs`) |

## Development

| Command | Description |
| --- | --- |
| `make dev` | Start the app in development mode |
| `make build` | Build the macOS app bundle |
| `make check` | TypeScript typecheck + Rust fmt/clippy/compile |
| `make clean` | Remove `dist/` and Cargo build artefacts |
| `make install` | `npm install` |

Recommended editor setup: [VS Code](https://code.visualstudio.com/) with the [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) and [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer) extensions.

Project context and architecture notes live in [`context/`](context/) for contributors and AI assistants working in this repo.

## License

[MIT](LICENSE) — Copyright © 2026 PartRocks, Happy Coder.

Made by [Paul Rooney](mailto:dogger@happycoder.co.uk).
