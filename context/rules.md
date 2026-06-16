# Dogger — Core Rules

These are non-negotiable principles. They constrain every feature, command, and
phase of Dogger. If a proposed change conflicts with a rule here, the change is
wrong.

## 1. Project codebases are read-only

**Dogger must never alter the files of a project's own codebase.**

A "project codebase" is the source repository/directory that a project points
at. Dogger may **read** from it (to inspect files, list paths, mount it into a
container, etc.) and may **run tasks against it** inside a container, but it
must never create, edit, move, rename, or delete files within it.

All state that Dogger itself owns — project metadata, task definitions,
`main.sh` scripts, supporting task resources, run history — lives **outside**
the codebase, under `~/.dogger` (see Rule 2). This separation is what makes the
read-only guarantee easy to keep.

## 2. Dogger-managed state lives in `~/.dogger`

Dogger stores everything it manages in a home directory it creates under the
host user's home directory (`~/.dogger`), organised by project, with tasks under
a per-project `tasks/` subdirectory. Data is plain JSON. Dogger never writes its
own state into a project's codebase.

## 3. Dogger does not manage containers

Dogger does **not** create, build, start, stop, or orchestrate Docker
containers. It only interacts with containers that are **already running** on
the host. Container lifecycle is the user's responsibility (Docker Desktop,
`docker compose`, etc.).

- The Docker CLI is assumed to be installed. Dogger checks for it at startup and
  shows a clear warning if it is missing or the daemon is unreachable.
- When selecting a container for a project, only **running** containers are
  listable/selectable (`docker ps`).
- Before running a task, Dogger verifies the project's configured containers are
  running and warns if they are not.
