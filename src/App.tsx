import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type {
  DockerContainer,
  DockerStatus,
  OutputLine,
  Project,
  RunningContainer,
  RunRecord,
  RunStatus,
  Task,
} from "./types";
import { getProjectStatus, matchesRunning } from "./types";
import * as api from "./api";
import "./App.css";

// Dogger UI, backed by on-disk state under `~/.dogger` (via the Rust commands
// in src/api.ts). Projects and tasks are read from and written to disk; a
// project's own codebase is never touched (see context/rules.md).
//
// Phase 2: container status is derived live from `docker ps`, and tasks run
// inside a running container via `docker cp` + `docker exec`, streaming output
// into the UI.

// Resolve a project's containers' `running` flags against the live `docker ps`
// result. When Docker is unavailable (`running === null`) we fall back to the
// persisted (mock) flag so the app stays browsable.
function resolveContainers(
  project: Project,
  running: RunningContainer[] | null,
): DockerContainer[] {
  if (!running) return project.containers;
  return project.containers.map((c) => ({
    ...c,
    running: matchesRunning(c.reference, running),
  }));
}

function projectStatusFor(
  project: Project,
  running: RunningContainer[] | null,
): ReturnType<typeof getProjectStatus> {
  return getProjectStatus({
    ...project,
    containers: resolveContainers(project, running),
  });
}

function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newProjectOpen, setNewProjectOpen] = useState(false);

  const [docker, setDocker] = useState<DockerStatus | null>(null);
  const [running, setRunning] = useState<RunningContainer[] | null>(null);
  const [dockerDismissed, setDockerDismissed] = useState(false);

  const refresh = useCallback(async (preferId?: string) => {
    try {
      const list = await api.listProjects();
      setProjects(list);
      setSelectedId((current) => {
        const wanted = preferId ?? current;
        if (wanted && list.some((p) => p.id === wanted)) return wanted;
        return list[0]?.id ?? null;
      });
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshDocker = useCallback(async () => {
    try {
      const status = await api.dockerStatus();
      setDocker(status);
      if (status.daemonRunning) {
        try {
          setRunning(await api.listRunningContainers());
        } catch {
          setRunning(null);
        }
      } else {
        setRunning(null);
      }
    } catch (e) {
      setDocker({
        cliInstalled: false,
        daemonRunning: false,
        serverVersion: null,
        message: String(e),
      });
      setRunning(null);
    }
  }, []);

  useEffect(() => {
    refresh();
    refreshDocker();
  }, [refresh, refreshDocker]);

  // Keep live container status reasonably fresh while Docker is reachable.
  useEffect(() => {
    if (!docker?.daemonRunning) return;
    const handle = setInterval(() => {
      api
        .listRunningContainers()
        .then(setRunning)
        .catch(() => {});
    }, 5000);
    return () => clearInterval(handle);
  }, [docker?.daemonRunning]);

  const selected = projects.find((p) => p.id === selectedId) ?? null;
  const dockerUnavailable = docker != null && !docker.daemonRunning;

  if (dockerUnavailable && !dockerDismissed) {
    return (
      <div className="window">
        <Titlebar />
        <DockerWarning
          status={docker}
          onRetry={refreshDocker}
          onContinue={() => setDockerDismissed(true)}
        />
      </div>
    );
  }

  async function handleCreateProject(input: {
    name: string;
    codebasePath: string;
    containerWorkingDir: string;
  }) {
    const created = await api.createProject(input);
    setNewProjectOpen(false);
    await refresh(created.id);
  }

  return (
    <div className="window">
      <Titlebar />
      <div className="app">
        <aside className="sidebar">
          <div className="brand">
            <span className="brand-mark">◆</span>
            <h1 className="brand-name">Dogger</h1>
          </div>

          <div className="sidebar-section-label">
            <span>Projects</span>
            <button
              className="icon-button"
              title="New project"
              onClick={() => setNewProjectOpen(true)}
            >
              +
            </button>
          </div>

          <nav className="project-list">
            {projects.map((project) => {
              const status = projectStatusFor(project, running);
              return (
                <button
                  key={project.id}
                  className={
                    "project-item" +
                    (project.id === selectedId ? " is-active" : "")
                  }
                  onClick={() => setSelectedId(project.id)}
                >
                  <span className="project-item-name">
                    <span
                      className={"status-dot status-dot--" + status}
                      title={status === "online" ? "Online" : "Offline"}
                    />
                    {project.name}
                  </span>
                  <span className="project-item-meta">
                    {project.tasks.length} task
                    {project.tasks.length === 1 ? "" : "s"}
                  </span>
                </button>
              );
            })}
            {!loading && projects.length === 0 && (
              <p className="sidebar-empty">No projects yet.</p>
            )}
          </nav>

          <div className="sidebar-footer">
            {docker?.daemonRunning ? (
              <span title={"Docker " + (docker.serverVersion ?? "")}>
                Docker connected · ~/.dogger
              </span>
            ) : (
              "stored in ~/.dogger"
            )}
          </div>
        </aside>

        <main className="main">
          {error && <div className="banner banner--error">{error}</div>}
          {dockerUnavailable && dockerDismissed && (
            <div className="banner banner--warn">
              Docker is unavailable — tasks can't run. {docker?.message}{" "}
              <button className="link-button" onClick={refreshDocker}>
                Retry
              </button>
            </div>
          )}
          {loading ? (
            <div className="empty-state">
              <p>Loading…</p>
            </div>
          ) : selected ? (
            <ProjectView
              key={selected.id}
              project={selected}
              running={running}
              dockerReady={!!docker?.daemonRunning}
              onChanged={(id) => refresh(id)}
              onDeleted={() => refresh()}
            />
          ) : (
            <EmptyState onNew={() => setNewProjectOpen(true)} />
          )}
        </main>
      </div>

      {newProjectOpen && (
        <NewProjectDialog
          onCancel={() => setNewProjectOpen(false)}
          onCreate={handleCreateProject}
        />
      )}
    </div>
  );
}

function Titlebar() {
  const appWindow = getCurrentWindow();

  return (
    <div className="titlebar" data-tauri-drag-region>
      <div className="window-controls">
        <button
          className="win-btn win-close"
          aria-label="Close"
          onClick={() => appWindow.close()}
        />
        <button
          className="win-btn win-min"
          aria-label="Minimize"
          onClick={() => appWindow.minimize()}
        />
        <button
          className="win-btn win-max"
          aria-label="Toggle maximize"
          onClick={() => appWindow.toggleMaximize()}
        />
      </div>
    </div>
  );
}

function ProjectView({
  project,
  running,
  dockerReady,
  onChanged,
  onDeleted,
}: {
  project: Project;
  running: RunningContainer[] | null;
  dockerReady: boolean;
  onChanged: (id: string) => void;
  onDeleted: () => void;
}) {
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [activeRun, setActiveRun] = useState<{
    task: Task;
    container: string;
    runId: string;
  } | null>(null);

  const resolvedContainers = resolveContainers(project, running);
  const status = projectStatusFor(project, running);
  const openTask = project.tasks.find((t) => t.id === openTaskId) ?? null;

  function startRun(task: Task, container: string) {
    setActiveRun({
      task,
      container,
      runId: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    });
  }

  async function run<T>(fn: () => Promise<T>): Promise<T | undefined> {
    setBusy(true);
    setErr(null);
    try {
      return await fn();
    } catch (e) {
      setErr(String(e));
      return undefined;
    } finally {
      setBusy(false);
    }
  }

  if (openTask) {
    return (
      <TaskDetail
        project={project}
        task={openTask}
        containers={resolvedContainers}
        dockerReady={dockerReady}
        onClose={() => setOpenTaskId(null)}
        onDeleted={() => {
          setOpenTaskId(null);
          onChanged(project.id);
        }}
      />
    );
  }

  if (editing) {
    return (
      <ProjectConfigEditor
        project={project}
        running={running}
        onCancel={() => setEditing(false)}
        onSaved={() => {
          setEditing(false);
          onChanged(project.id);
        }}
      />
    );
  }

  return (
    <div className="project-view">
      {err && <div className="banner banner--error">{err}</div>}
      <header className="project-header">
        <div className="project-title">
          <h2>{project.name}</h2>
          <span className={"status-badge status-badge--" + status}>
            <span className={"status-dot status-dot--" + status} />
            {status === "online" ? "Online" : "Offline"}
          </span>
          <div className="header-actions">
            <button className="ghost-button" onClick={() => setEditing(true)}>
              Configure
            </button>
            <button
              className="ghost-button ghost-button--danger"
              disabled={busy}
              onClick={() => setConfirmDeleteOpen(true)}
            >
              Delete
            </button>
          </div>
        </div>
        {status === "offline" && (
          <p className="status-hint muted">
            Some containers are not running. Start them on the host to bring this
            project online.
          </p>
        )}
        <dl className="project-config">
          <div>
            <dt>Managed directory</dt>
            <dd>
              <code>{project.projectDir}</code>
            </dd>
          </div>
          <div>
            <dt>Codebase path</dt>
            <dd>
              {project.codebasePath ? (
                <code>{project.codebasePath}</code>
              ) : (
                <span className="muted">Not set</span>
              )}
            </dd>
          </div>
          <div>
            <dt>Container working dir</dt>
            <dd>
              <code>{project.containerWorkingDir || "—"}</code>
            </dd>
          </div>
          <div>
            <dt>Containers</dt>
            <dd>
              {resolvedContainers.length === 0 ? (
                <span className="muted">None configured</span>
              ) : (
                resolvedContainers.map((c) => (
                  <span
                    key={c.id}
                    className={"chip" + (c.running ? "" : " chip--offline")}
                    title={
                      c.reference + (c.running ? " (running)" : " (not running)")
                    }
                  >
                    <span
                      className={
                        "status-dot status-dot--" +
                        (c.running ? "online" : "offline")
                      }
                    />
                    {c.name}
                  </span>
                ))
              )}
            </dd>
          </div>
        </dl>
      </header>

      <section className="tasks">
        <div className="section-head">
          <h3>Tasks</h3>
          <button className="ghost-button" onClick={() => setNewTaskOpen(true)}>
            New task
          </button>
        </div>

        {project.tasks.length === 0 ? (
          <p className="muted">No tasks yet. Create one to scaffold a main.sh.</p>
        ) : (
          <ul className="task-list">
            {project.tasks.map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                containers={resolvedContainers}
                dockerReady={dockerReady}
                onOpen={() => setOpenTaskId(task.id)}
                onRun={(container) => startRun(task, container)}
              />
            ))}
          </ul>
        )}
      </section>

      {activeRun && (
        <RunConsole
          projectId={project.id}
          taskName={activeRun.task.name}
          taskId={activeRun.task.id}
          container={activeRun.container}
          runId={activeRun.runId}
          onClose={() => setActiveRun(null)}
        />
      )}

      {newTaskOpen && (
        <NewTaskDialog
          onCancel={() => setNewTaskOpen(false)}
          onCreate={async (input) => {
            const created = await run(() =>
              api.createTask({ projectId: project.id, ...input }),
            );
            if (created) {
              setNewTaskOpen(false);
              onChanged(project.id);
            }
          }}
        />
      )}

      {confirmDeleteOpen && (
        <ConfirmDialog
          title="Delete project"
          message={
            <>
              Delete project <strong>{project.name}</strong>? This removes its
              managed directory and all of its tasks. The project's own codebase
              is not touched.
            </>
          }
          confirmLabel="Delete project"
          busy={busy}
          onCancel={() => setConfirmDeleteOpen(false)}
          onConfirm={async () => {
            setBusy(true);
            setErr(null);
            try {
              await api.deleteProject(project.id);
              onDeleted();
            } catch (e) {
              setErr(String(e));
              setBusy(false);
              setConfirmDeleteOpen(false);
            }
          }}
        />
      )}
    </div>
  );
}

function TaskRow({
  task,
  containers,
  dockerReady,
  onOpen,
  onRun,
}: {
  task: Task;
  containers: DockerContainer[];
  dockerReady: boolean;
  onOpen: () => void;
  onRun: (container: string) => void;
}) {
  const runnable = containers.filter((c) => c.running);
  const [target, setTarget] = useState("");
  const effectiveTarget =
    runnable.find((c) => c.reference === target)?.reference ??
    runnable[0]?.reference ??
    "";

  const disabled = !dockerReady || runnable.length === 0;
  const title = !dockerReady
    ? "Docker is unavailable"
    : runnable.length === 0
      ? "No running container for this project"
      : `Run in ${effectiveTarget}`;

  return (
    <li className="task-row">
      <button className="task-info task-info--button" onClick={onOpen}>
        <span className="task-name">{task.name}</span>
        <code className="task-entry">{task.dir}/main.sh</code>
        {task.description && (
          <span className="task-desc">{task.description}</span>
        )}
      </button>
      <div className="task-run-controls">
        {runnable.length > 1 && (
          <select
            className="container-select"
            value={effectiveTarget}
            onChange={(e) => setTarget(e.target.value)}
            title="Target container"
          >
            {runnable.map((c) => (
              <option key={c.id} value={c.reference}>
                {c.name || c.reference}
              </option>
            ))}
          </select>
        )}
        <button
          className="run-button"
          disabled={disabled}
          title={title}
          onClick={() => onRun(effectiveTarget)}
        >
          ▶ Run
        </button>
      </div>
    </li>
  );
}

function ProjectConfigEditor({
  project,
  running,
  onCancel,
  onSaved,
}: {
  project: Project;
  running: RunningContainer[] | null;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(project.name);
  const [codebasePath, setCodebasePath] = useState(project.codebasePath);
  const [workingDir, setWorkingDir] = useState(project.containerWorkingDir);
  const [containers, setContainers] = useState<DockerContainer[]>(
    project.containers,
  );
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function addContainer() {
    const id = "c" + Math.random().toString(36).slice(2, 8);
    setContainers((cs) => [
      ...cs,
      { id, name: "", reference: "", running: false },
    ]);
  }

  function addRunningContainer(rc: RunningContainer) {
    const id = "c" + Math.random().toString(36).slice(2, 8);
    setContainers((cs) =>
      cs.some((c) => c.reference === rc.name)
        ? cs
        : [
            ...cs,
            {
              id,
              name: rc.name,
              reference: rc.name,
              running: true,
            },
          ],
    );
  }

  function updateContainer(id: string, patch: Partial<DockerContainer>) {
    setContainers((cs) =>
      cs.map((c) => (c.id === id ? { ...c, ...patch } : c)),
    );
  }

  function removeContainer(id: string) {
    setContainers((cs) => cs.filter((c) => c.id !== id));
  }

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      const cleaned = containers
        .map((c) => ({
          ...c,
          name: c.name.trim() || c.reference.trim(),
          reference: c.reference.trim(),
        }))
        .filter((c) => c.reference.length > 0);
      await api.updateProject({
        id: project.id,
        name: name.trim() || project.name,
        codebasePath: codebasePath.trim(),
        containerWorkingDir: workingDir.trim(),
        containers: cleaned,
      });
      onSaved();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="project-view">
      <div className="section-head">
        <h2>Configure project</h2>
      </div>
      {err && <div className="banner banner--error">{err}</div>}

      <div className="form-grid">
        <label className="field">
          <span className="field-label">Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <CodebasePathField
          label="Codebase path (read-only source)"
          value={codebasePath}
          onChange={setCodebasePath}
        />
        <label className="field">
          <span className="field-label">Container working directory</span>
          <input
            value={workingDir}
            placeholder="/app"
            onChange={(e) => setWorkingDir(e.target.value)}
          />
        </label>
      </div>

      <div className="section-head section-head--spaced">
        <h3>Containers</h3>
        <button className="ghost-button" onClick={addContainer}>
          Add manually
        </button>
      </div>
      <p className="muted container-hint">
        A container reference is matched live against running containers
        (`docker ps`). The persisted “running” flag is only a fallback for when
        Docker is unavailable.
      </p>

      {running && running.length > 0 && (
        <div className="running-picker">
          <span className="field-label">Add a running container:</span>
          <div className="running-picker-list">
            {running.map((rc) => {
              const already = containers.some((c) => c.reference === rc.name);
              return (
                <button
                  key={rc.id}
                  className="chip chip--button"
                  disabled={already}
                  title={`${rc.image} · ${rc.status}`}
                  onClick={() => addRunningContainer(rc)}
                >
                  <span className="status-dot status-dot--online" />
                  {rc.name}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {containers.length === 0 ? (
        <p className="muted">No containers configured.</p>
      ) : (
        <ul className="container-editor">
          {containers.map((c) => (
            <li key={c.id} className="container-editor-row">
              <input
                className="container-input"
                placeholder="Label (e.g. Postgres)"
                value={c.name}
                onChange={(e) => updateContainer(c.id, { name: e.target.value })}
              />
              <input
                className="container-input"
                placeholder="Container name / ref"
                value={c.reference}
                onChange={(e) =>
                  updateContainer(c.id, { reference: e.target.value })
                }
              />
              <label className="running-toggle">
                <input
                  type="checkbox"
                  checked={c.running}
                  onChange={(e) =>
                    updateContainer(c.id, { running: e.target.checked })
                  }
                />
                running
              </label>
              <button
                className="icon-button icon-button--light"
                title="Remove container"
                onClick={() => removeContainer(c.id)}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="form-actions">
        <button className="ghost-button" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button className="primary-button" onClick={save} disabled={busy}>
          {busy ? "Saving…" : "Save changes"}
        </button>
      </div>
    </div>
  );
}

function TaskDetail({
  project,
  task,
  containers,
  dockerReady,
  onClose,
  onDeleted,
}: {
  project: Project;
  task: Task;
  containers: DockerContainer[];
  dockerReady: boolean;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [files, setFiles] = useState<string[]>([]);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [contents, setContents] = useState("");
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [addFileOpen, setAddFileOpen] = useState(false);
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [target, setTarget] = useState("");
  const [activeRun, setActiveRun] = useState<{
    container: string;
    runId: string;
  } | null>(null);

  const runnable = containers.filter((c) => c.running);
  const effectiveTarget =
    runnable.find((c) => c.reference === target)?.reference ??
    runnable[0]?.reference ??
    "";

  const loadRuns = useCallback(() => {
    api
      .listRuns(project.id, task.id)
      .then(setRuns)
      .catch(() => {});
  }, [project.id, task.id]);

  useEffect(() => {
    loadRuns();
  }, [loadRuns]);

  function startRun() {
    if (!effectiveTarget) return;
    setActiveRun({
      container: effectiveTarget,
      runId: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    });
  }

  const loadFiles = useCallback(
    async (preferFile?: string) => {
      try {
        const list = await api.listTaskFiles(project.id, task.id);
        setFiles(list);
        setActiveFile((current) => {
          const wanted = preferFile ?? current;
          if (wanted && list.includes(wanted)) return wanted;
          return list[0] ?? null;
        });
        setErr(null);
      } catch (e) {
        setErr(String(e));
      }
    },
    [project.id, task.id],
  );

  useEffect(() => {
    loadFiles("main.sh");
  }, [loadFiles]);

  useEffect(() => {
    if (!activeFile) {
      setContents("");
      setDirty(false);
      return;
    }
    let cancelled = false;
    api
      .readTaskFile(project.id, task.id, activeFile)
      .then((text) => {
        if (!cancelled) {
          setContents(text);
          setDirty(false);
        }
      })
      .catch((e) => !cancelled && setErr(String(e)));
    return () => {
      cancelled = true;
    };
  }, [activeFile, project.id, task.id]);

  async function save() {
    if (!activeFile) return;
    setBusy(true);
    setErr(null);
    try {
      await api.writeTaskFile(project.id, task.id, activeFile, contents);
      setDirty(false);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function addFile(rawName: string) {
    const name = rawName.trim();
    if (!name) return;
    setBusy(true);
    setErr(null);
    try {
      await api.writeTaskFile(project.id, task.id, name, "");
      setAddFileOpen(false);
      await loadFiles(name);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="project-view">
      <div className="breadcrumb">
        <button className="link-button" onClick={onClose}>
          ← {project.name}
        </button>
        <span className="muted"> / Tasks / {task.name}</span>
      </div>

      <div className="project-title">
        <h2>{task.name}</h2>
        <div className="header-actions">
          {runnable.length > 1 && (
            <select
              className="container-select"
              value={effectiveTarget}
              onChange={(e) => setTarget(e.target.value)}
              title="Target container"
            >
              {runnable.map((c) => (
                <option key={c.id} value={c.reference}>
                  {c.name || c.reference}
                </option>
              ))}
            </select>
          )}
          <button
            className="primary-button"
            disabled={!dockerReady || runnable.length === 0}
            title={
              !dockerReady
                ? "Docker is unavailable"
                : runnable.length === 0
                  ? "No running container for this project"
                  : `Run in ${effectiveTarget}`
            }
            onClick={startRun}
          >
            ▶ Run
          </button>
          <button
            className="ghost-button ghost-button--danger"
            disabled={busy}
            onClick={() => setConfirmDeleteOpen(true)}
          >
            Delete task
          </button>
        </div>
      </div>
      {task.description && <p className="muted">{task.description}</p>}
      {err && <div className="banner banner--error">{err}</div>}

      <div className="file-editor">
        <div className="file-list">
          <div className="file-list-head">
            <span>Files</span>
            <button
              className="icon-button icon-button--light"
              title="New file"
              onClick={() => setAddFileOpen(true)}
            >
              +
            </button>
          </div>
          {files.length === 0 ? (
            <p className="muted file-empty">No files.</p>
          ) : (
            files.map((f) => (
              <button
                key={f}
                className={
                  "file-item" + (f === activeFile ? " is-active" : "")
                }
                onClick={() => setActiveFile(f)}
              >
                {f}
                {f === activeFile && dirty ? " •" : ""}
              </button>
            ))
          )}
        </div>

        <div className="file-content">
          {activeFile ? (
            <>
              <div className="file-content-head">
                <code>{activeFile}</code>
                <button
                  className="primary-button"
                  onClick={save}
                  disabled={busy || !dirty}
                >
                  {busy ? "Saving…" : dirty ? "Save" : "Saved"}
                </button>
              </div>
              <textarea
                className="code-editor"
                spellCheck={false}
                value={contents}
                onChange={(e) => {
                  setContents(e.target.value);
                  setDirty(true);
                }}
              />
            </>
          ) : (
            <div className="empty-state">
              <p>Select or add a file.</p>
            </div>
          )}
        </div>
      </div>

      <RunHistory runs={runs} />

      {activeRun && (
        <RunConsole
          projectId={project.id}
          taskName={task.name}
          taskId={task.id}
          container={activeRun.container}
          runId={activeRun.runId}
          onClose={() => setActiveRun(null)}
          onFinished={loadRuns}
        />
      )}

      {addFileOpen && (
        <PromptDialog
          title="New file"
          label="File name"
          placeholder="helper.php"
          confirmLabel="Create file"
          busy={busy}
          onCancel={() => setAddFileOpen(false)}
          onConfirm={addFile}
        />
      )}

      {confirmDeleteOpen && (
        <ConfirmDialog
          title="Delete task"
          message={
            <>
              Delete task <strong>{task.name}</strong>? This removes its
              directory and all of its files.
            </>
          }
          confirmLabel="Delete task"
          busy={busy}
          onCancel={() => setConfirmDeleteOpen(false)}
          onConfirm={async () => {
            setBusy(true);
            setErr(null);
            try {
              await api.deleteTask(project.id, task.id);
              onDeleted();
            } catch (e) {
              setErr(String(e));
              setBusy(false);
              setConfirmDeleteOpen(false);
            }
          }}
        />
      )}
    </div>
  );
}

function NewProjectDialog({
  onCancel,
  onCreate,
}: {
  onCancel: () => void;
  onCreate: (input: {
    name: string;
    codebasePath: string;
    containerWorkingDir: string;
  }) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [codebasePath, setCodebasePath] = useState("");
  const [workingDir, setWorkingDir] = useState("/app");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    if (!name.trim()) {
      setErr("Project name is required.");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await onCreate({
        name: name.trim(),
        codebasePath: codebasePath.trim(),
        containerWorkingDir: workingDir.trim(),
      });
    } catch (e) {
      setErr(String(e));
      setBusy(false);
    }
  }

  return (
    <Modal title="New project" onClose={onCancel}>
      {err && <div className="banner banner--error">{err}</div>}
      <label className="field">
        <span className="field-label">Name</span>
        <input
          autoFocus
          value={name}
          placeholder="My Project"
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <CodebasePathField
        label="Codebase path (optional)"
        value={codebasePath}
        onChange={setCodebasePath}
      />
      <label className="field">
        <span className="field-label">Container working directory</span>
        <input
          value={workingDir}
          placeholder="/app"
          onChange={(e) => setWorkingDir(e.target.value)}
        />
      </label>
      <div className="form-actions">
        <button className="ghost-button" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button className="primary-button" onClick={submit} disabled={busy}>
          {busy ? "Creating…" : "Create project"}
        </button>
      </div>
    </Modal>
  );
}

function NewTaskDialog({
  onCancel,
  onCreate,
}: {
  onCancel: () => void;
  onCreate: (input: {
    name: string;
    description?: string;
  }) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    if (!name.trim()) {
      setErr("Task name is required.");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await onCreate({
        name: name.trim(),
        description: description.trim() || undefined,
      });
    } catch (e) {
      setErr(String(e));
      setBusy(false);
    }
  }

  return (
    <Modal title="New task" onClose={onCancel}>
      {err && <div className="banner banner--error">{err}</div>}
      <p className="muted modal-hint">
        Creates a task directory with a starter <code>main.sh</code>.
      </p>
      <label className="field">
        <span className="field-label">Name</span>
        <input
          autoFocus
          value={name}
          placeholder="Run migrations"
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <label className="field">
        <span className="field-label">Description (optional)</span>
        <input
          value={description}
          placeholder="What does this task do?"
          onChange={(e) => setDescription(e.target.value)}
        />
      </label>
      <div className="form-actions">
        <button className="ghost-button" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button className="primary-button" onClick={submit} disabled={busy}>
          {busy ? "Creating…" : "Create task"}
        </button>
      </div>
    </Modal>
  );
}

function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="icon-button icon-button--light" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

function EmptyState({ onNew }: { onNew: () => void }) {
  return (
    <div className="empty-state">
      <div className="empty-inner">
        <p>No project selected.</p>
        <button className="primary-button" onClick={onNew}>
          New project
        </button>
      </div>
    </div>
  );
}

// Codebase path input paired with a native folder picker (Tauri dialog
// plugin). The path stays editable by hand; "Browse…" just fills it in.
function CodebasePathField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  async function browse() {
    const selected = await openDialog({
      directory: true,
      multiple: false,
      title: "Select codebase folder",
      defaultPath: value || undefined,
    });
    if (typeof selected === "string") onChange(selected);
  }

  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <div className="path-input">
        <input
          value={value}
          placeholder="/Users/you/code/my-project"
          onChange={(e) => onChange(e.target.value)}
        />
        <button type="button" className="ghost-button" onClick={browse}>
          Browse…
        </button>
      </div>
    </label>
  );
}

// Inline confirmation dialog, replacing window.confirm so it matches the app's
// look and works reliably inside the Tauri webview.
function ConfirmDialog({
  title,
  message,
  confirmLabel,
  busy,
  onCancel,
  onConfirm,
}: {
  title: string;
  message: ReactNode;
  confirmLabel: string;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal title={title} onClose={onCancel}>
      <p className="modal-hint">{message}</p>
      <div className="form-actions">
        <button className="ghost-button" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button
          className="primary-button primary-button--danger"
          onClick={onConfirm}
          disabled={busy}
        >
          {busy ? "Working…" : confirmLabel}
        </button>
      </div>
    </Modal>
  );
}

// Inline single-field prompt, replacing window.prompt.
function PromptDialog({
  title,
  label,
  placeholder,
  confirmLabel,
  busy,
  onCancel,
  onConfirm,
}: {
  title: string;
  label: string;
  placeholder?: string;
  confirmLabel: string;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: (value: string) => void;
}) {
  const [value, setValue] = useState("");
  const trimmed = value.trim();

  return (
    <Modal title={title} onClose={onCancel}>
      <label className="field">
        <span className="field-label">{label}</span>
        <input
          autoFocus
          value={value}
          placeholder={placeholder}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && trimmed && !busy) onConfirm(trimmed);
          }}
        />
      </label>
      <div className="form-actions">
        <button className="ghost-button" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button
          className="primary-button"
          onClick={() => onConfirm(trimmed)}
          disabled={busy || !trimmed}
        >
          {busy ? "Working…" : confirmLabel}
        </button>
      </div>
    </Modal>
  );
}

// Live console for a task run. It attaches event listeners *before* kicking off
// the run (guarded against StrictMode double-invocation) so no early output is
// missed, then streams stdout/stderr and reports the exit code.
function RunConsole({
  projectId,
  taskId,
  taskName,
  container,
  runId,
  onClose,
  onFinished,
}: {
  projectId: string;
  taskId: string;
  taskName: string;
  container: string;
  runId: string;
  onClose: () => void;
  onFinished?: () => void;
}) {
  const [lines, setLines] = useState<OutputLine[]>([]);
  const [status, setStatus] = useState<RunStatus | "starting">("starting");
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const startedRef = useRef(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    let unOut: (() => void) | undefined;
    let unFin: (() => void) | undefined;

    api
      .onRunOutput((e) => {
        if (e.runId !== runId) return;
        setLines((prev) => [...prev, { stream: e.stream, text: e.line }]);
      })
      .then((fn) => (cancelled ? fn() : (unOut = fn)));

    api
      .onRunFinished((e) => {
        if (e.runId !== runId) return;
        setStatus(e.status);
        setExitCode(e.exitCode);
        onFinished?.();
      })
      .then((fn) => (cancelled ? fn() : (unFin = fn)));

    return () => {
      cancelled = true;
      unOut?.();
      unFin?.();
    };
  }, [runId, onFinished]);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    setStatus("running");
    api
      .runTask({ projectId, taskId, container, runId })
      .catch((e) => {
        setError(String(e));
        setStatus("error");
      });
  }, [projectId, taskId, container, runId]);

  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  const finished = status !== "starting" && status !== "running";

  return (
    <div className="modal-overlay" onClick={finished ? onClose : undefined}>
      <div
        className="run-modal"
        role="dialog"
        aria-label={"Run " + taskName}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="run-modal-head">
          <div className="run-modal-title">
            <RunStatusBadge status={status} exitCode={exitCode} />
            <span className="run-modal-name">{taskName}</span>
            <code className="run-modal-target">{container}</code>
          </div>
          <button
            className="icon-button icon-button--light"
            onClick={onClose}
            disabled={!finished}
            title={finished ? "Close" : "Run in progress…"}
          >
            ×
          </button>
        </div>
        {error && <div className="banner banner--error">{error}</div>}
        <OutputView lines={lines} forwardRef={bodyRef} live={!finished} />
        <div className="run-modal-foot">
          {status === "running" && <span className="muted">Running…</span>}
          {finished && (
            <span className="muted">
              {status === "success"
                ? "Completed successfully"
                : status === "failed"
                  ? `Exited with code ${exitCode ?? "?"}`
                  : "Run error"}
            </span>
          )}
          <button
            className="ghost-button"
            onClick={onClose}
            disabled={!finished}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function RunStatusBadge({
  status,
  exitCode,
}: {
  status: RunStatus | "starting";
  exitCode?: number | null;
}) {
  const cls =
    status === "success"
      ? "run-badge run-badge--success"
      : status === "failed" || status === "error"
        ? "run-badge run-badge--failed"
        : "run-badge run-badge--running";
  const label =
    status === "starting"
      ? "Starting"
      : status === "running"
        ? "Running"
        : status === "success"
          ? "Success"
          : status === "failed"
            ? `Failed (${exitCode ?? "?"})`
            : "Error";
  return <span className={cls}>{label}</span>;
}

function OutputView({
  lines,
  forwardRef,
  live,
}: {
  lines: OutputLine[];
  forwardRef?: RefObject<HTMLDivElement | null>;
  live?: boolean;
}) {
  return (
    <div className="run-output" ref={forwardRef}>
      {lines.length === 0 ? (
        <span className="run-output-empty">
          {live ? "Waiting for output…" : "No output."}
        </span>
      ) : (
        lines.map((l, i) => (
          <div
            key={i}
            className={
              "run-line" + (l.stream === "stderr" ? " run-line--err" : "")
            }
          >
            {l.text}
          </div>
        ))
      )}
    </div>
  );
}

function RunHistory({ runs }: { runs: RunRecord[] }) {
  return (
    <section className="runs-section">
      <div className="section-head section-head--spaced">
        <h3>Run history</h3>
      </div>
      {runs.length === 0 ? (
        <p className="muted">No runs yet.</p>
      ) : (
        <ul className="runs-list">
          {runs.map((run) => (
            <RunHistoryItem key={run.id} run={run} />
          ))}
        </ul>
      )}
    </section>
  );
}

function RunHistoryItem({ run }: { run: RunRecord }) {
  const [open, setOpen] = useState(false);
  const when = new Date(run.startedAt).toLocaleString();
  const duration =
    run.finishedAt != null
      ? `${((run.finishedAt - run.startedAt) / 1000).toFixed(1)}s`
      : "—";

  return (
    <li className="run-item">
      <button className="run-item-head" onClick={() => setOpen((o) => !o)}>
        <RunStatusBadge status={run.status} exitCode={run.exitCode} />
        <span className="run-item-when">{when}</span>
        <code className="run-item-target">{run.container}</code>
        <span className="run-item-dur muted">{duration}</span>
        <span className="run-item-chevron">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="run-item-body">
          <code className="run-item-cmd">{run.command}</code>
          <OutputView lines={run.output} />
        </div>
      )}
    </li>
  );
}

// Full-screen warning shown when the Docker CLI/daemon can't be reached. Dogger
// never starts Docker itself (see context/rules.md) — it just guides the user.
function DockerWarning({
  status,
  onRetry,
  onContinue,
}: {
  status: DockerStatus | null;
  onRetry: () => void;
  onContinue: () => void;
}) {
  const notInstalled = status != null && !status.cliInstalled;
  return (
    <div className="docker-warning">
      <div className="docker-warning-card">
        <div className="docker-warning-mark">🐳</div>
        <h2>{notInstalled ? "Docker not found" : "Docker isn't running"}</h2>
        <p className="muted">
          {status?.message ??
            "Dogger needs the Docker CLI and a running daemon to execute tasks."}
        </p>
        <p className="muted docker-warning-note">
          Dogger never starts or manages containers itself — start Docker (and
          your containers) on the host, then retry.
        </p>
        <div className="form-actions form-actions--center">
          <button className="ghost-button" onClick={onContinue}>
            Continue without Docker
          </button>
          <button className="primary-button" onClick={onRetry}>
            Retry
          </button>
        </div>
      </div>
    </div>
  );
}

export default App;
