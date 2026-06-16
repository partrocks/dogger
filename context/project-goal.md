# Dogger — Project Goal

Dogger is a developer **desktop app** (Tauri 2, macOS-first) for managing and
running **reusable shell-script tasks inside Docker containers**, organised by
project.

## Why

Developers accumulate one-off scripts (migrations, seeders, builds, codegen)
that need to run *inside* a specific container, from a specific working
directory. Dogger gives these scripts a home: a structured, per-project library
of tasks that can be run with one click.

## Core concepts

A **Project** has:

- a name
- a local project directory managed by Dogger
- configured Docker containers
- a container working directory where tasks execute
- a collection of reusable tasks

A **Task** is a **directory** that:

- **must** contain a `main.sh` entrypoint
- may include supporting resources (PHP, Node, JSON, etc.)

Dogger executes `main.sh` inside the selected Docker container from the
configured working directory, while letting the script reference sibling files
in its own task resource directory.

## Phases

- **Phase 1 (current):** Project/task structure + a local UI shell. No real
  Docker execution. No AI.
- **Phase 2 (later):** Real Docker execution of `main.sh`.
- **Phase 3 (idea):** AI assistance — e.g. generating/editing tasks from natural
  language, summarising output, suggesting fixes. Not started.
