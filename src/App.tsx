import { useCallback, useEffect, useRef, useState } from "react";
import type { MouseEvent, ReactNode, RefObject } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import Editor from "react-simple-code-editor";
import type {
  DockerStatus,
  OutputLine,
  Project,
  RunningContainer,
  RunRecord,
  RunStatus,
  ShellInfo,
  Task,
} from "./types";
import { getProjectStatus, matchesRunning } from "./types";
import * as api from "./api";
import { highlightCode, languageLabel } from "./highlight";
import "./App.css";

// Dogger UI, backed by on-disk state under `~/.dogger` (via the Rust commands
// in src/api.ts). Projects and tasks are read from and written to disk; a
// project's own codebase is never touched (see context/rules.md).
//
// Phase 2: container status is derived live from `docker ps`, and tasks run
// inside a running container via `docker cp` + `docker exec`, streaming output
// into the UI.

// Whether a project's single configured container is currently running. When
// Docker is unavailable (`running === null`) we can't confirm it, so treat it
// as not running.
function isProjectContainerRunning(
  project: Project,
  running: RunningContainer[] | null,
): boolean {
  if (!project.container || !running) return false;
  return matchesRunning(project.container, running);
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
    container: string;
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
            <DoggerMark className="brand-mark" />
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
              const status = getProjectStatus(project, running);
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
          running={running}
          dockerReady={!!docker?.daemonRunning}
          onCancel={() => setNewProjectOpen(false)}
          onCreate={handleCreateProject}
        />
      )}
    </div>
  );
}

function Titlebar() {
  const appWindow = getCurrentWindow();

  // `data-tauri-drag-region` alone is unreliable in the Tauri v2 webview, so we
  // also start the native drag explicitly on mousedown. We ignore the press
  // when it lands on an interactive control (the traffic-light buttons).
  function handleDragMouseDown(e: MouseEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button")) return;
    void appWindow.startDragging();
  }

  return (
    <div
      className="titlebar"
      data-tauri-drag-region
      onMouseDown={handleDragMouseDown}
      onDoubleClick={() => void appWindow.toggleMaximize()}
    >
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

  const containerRunning = isProjectContainerRunning(project, running);
  const status = getProjectStatus(project, running);
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
        containerRunning={containerRunning}
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
        dockerReady={dockerReady}
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
            {project.container
              ? "The project's container isn't running. Start it on the host to bring this project online."
              : "No container configured. Add one in Configure to run tasks."}
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
            <dt>Container</dt>
            <dd>
              {!project.container ? (
                <span className="muted">None configured</span>
              ) : (
                <span
                  className={"chip" + (containerRunning ? "" : " chip--offline")}
                  title={
                    project.container +
                    (containerRunning ? " (running)" : " (not running)")
                  }
                >
                  <span
                    className={
                      "status-dot status-dot--" +
                      (containerRunning ? "online" : "offline")
                    }
                  />
                  {project.container}
                </span>
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
                container={project.container}
                containerRunning={containerRunning}
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
  container,
  containerRunning,
  dockerReady,
  onOpen,
  onRun,
}: {
  task: Task;
  container: string;
  containerRunning: boolean;
  dockerReady: boolean;
  onOpen: () => void;
  onRun: (container: string) => void;
}) {
  const disabled = !dockerReady || !container || !containerRunning;
  const title = !dockerReady
    ? "Docker is unavailable"
    : !container
      ? "No container configured for this project"
      : !containerRunning
        ? `Container ${container} is not running`
        : `Run in ${container}`;

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
        <button
          className="run-button"
          disabled={disabled}
          title={title}
          onClick={() => onRun(container)}
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
  dockerReady,
  onCancel,
  onSaved,
}: {
  project: Project;
  running: RunningContainer[] | null;
  dockerReady: boolean;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(project.name);
  const [codebasePath, setCodebasePath] = useState(project.codebasePath);
  const [workingDir, setWorkingDir] = useState(project.containerWorkingDir);
  const [container, setContainer] = useState(project.container);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      if (container.trim() && workingDir.trim() && dockerReady) {
        const ok = await api
          .checkContainerPath(container.trim(), workingDir.trim())
          .catch((e) => {
            throw new Error(String(e));
          });
        if (!ok) {
          setErr(
            `"${workingDir.trim()}" was not found in ${container.trim()}.`,
          );
          setBusy(false);
          return;
        }
      }
      await api.updateProject({
        id: project.id,
        name: name.trim() || project.name,
        codebasePath: codebasePath.trim(),
        containerWorkingDir: workingDir.trim(),
        container: container.trim(),
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
        <ContainerField
          running={running}
          dockerReady={dockerReady}
          container={container}
          onContainerChange={setContainer}
          workingDir={workingDir}
          onWorkingDirChange={setWorkingDir}
        />
      </div>

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
  containerRunning,
  dockerReady,
  onClose,
  onDeleted,
}: {
  project: Project;
  task: Task;
  containerRunning: boolean;
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
  const [shell, setShell] = useState<ShellInfo | null>(null);
  const [activeRun, setActiveRun] = useState<{
    container: string;
    runId: string;
  } | null>(null);

  // The project runs tasks in a single container; it's a valid run target only
  // when Docker is reachable and that container is currently running.
  const container = project.container;
  const canRun = dockerReady && !!container && containerRunning;
  const effectiveTarget = canRun ? container : "";

  const loadRuns = useCallback(() => {
    api
      .listRuns(project.id, task.id)
      .then(setRuns)
      .catch(() => {});
  }, [project.id, task.id]);

  useEffect(() => {
    loadRuns();
  }, [loadRuns]);

  // Probe the target container so we can show which shell will actually run
  // `main.sh` (honouring its shebang) instead of leaving the user guessing.
  useEffect(() => {
    if (!dockerReady || !effectiveTarget) {
      setShell(null);
      return;
    }
    let cancelled = false;
    api
      .detectContainerShell(project.id, task.id, effectiveTarget)
      .then((s) => !cancelled && setShell(s))
      .catch(() => !cancelled && setShell(null));
    return () => {
      cancelled = true;
    };
  }, [dockerReady, effectiveTarget, project.id, task.id]);

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
          {shell && (
            <span
              className="shell-indicator"
              title={
                `main.sh runs with ${shell.interpreter}` +
                (shell.shebang ? ` · shebang #!${shell.shebang}` : "") +
                (shell.available.length
                  ? ` · available: ${shell.available.join(", ")}`
                  : "")
              }
            >
              <span className="shell-indicator-icon">$</span>
              {shell.interpreter}
            </span>
          )}
          <button
            className="primary-button"
            disabled={!canRun}
            title={
              !dockerReady
                ? "Docker is unavailable"
                : !container
                  ? "No container configured for this project"
                  : !containerRunning
                    ? `Container ${container} is not running`
                    : `Run in ${container}`
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
                <div className="file-content-head-actions">
                  {languageLabel(activeFile) && (
                    <span className="lang-badge">
                      {languageLabel(activeFile)}
                    </span>
                  )}
                  <button
                    className="primary-button"
                    onClick={save}
                    disabled={busy || !dirty}
                  >
                    {busy ? "Saving…" : dirty ? "Save" : "Saved"}
                  </button>
                </div>
              </div>
              <div className="code-editor-wrap">
                <Editor
                  className="code-editor"
                  value={contents}
                  onValueChange={(code) => {
                    setContents(code);
                    setDirty(true);
                  }}
                  highlight={(code) => highlightCode(code, activeFile)}
                  padding={12}
                  tabSize={2}
                />
              </div>
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
  running,
  dockerReady,
  onCancel,
  onCreate,
}: {
  running: RunningContainer[] | null;
  dockerReady: boolean;
  onCancel: () => void;
  onCreate: (input: {
    name: string;
    codebasePath: string;
    containerWorkingDir: string;
    container: string;
  }) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [codebasePath, setCodebasePath] = useState("");
  const [workingDir, setWorkingDir] = useState("/app");
  const [container, setContainer] = useState("");
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
      // When a running container is chosen, confirm the working directory
      // actually exists in it before creating the project.
      if (container.trim() && workingDir.trim() && dockerReady) {
        const ok = await api
          .checkContainerPath(container.trim(), workingDir.trim())
          .catch((e) => {
            throw new Error(String(e));
          });
        if (!ok) {
          setErr(
            `"${workingDir.trim()}" was not found in ${container.trim()}.`,
          );
          setBusy(false);
          return;
        }
      }
      await onCreate({
        name: name.trim(),
        codebasePath: codebasePath.trim(),
        containerWorkingDir: workingDir.trim(),
        container: container.trim(),
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
      <ContainerField
        running={running}
        dockerReady={dockerReady}
        container={container}
        onContainerChange={setContainer}
        workingDir={workingDir}
        onWorkingDirChange={setWorkingDir}
      />
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
        <DoggerMark className="empty-mark" />
        <p>No project selected.</p>
        <button className="primary-button" onClick={onNew}>
          New project
        </button>
      </div>
    </div>
  );
}

// The Dogger mark: a rounded dog/bear head with two eyes and a nose, drawn with
// `currentColor` so it picks up whatever color its container sets.
function DoggerMark({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 64 64"
      fill="none"
      role="img"
      aria-label="Dogger"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M18 18 C14 13, 9.5 14, 10.5 19.5 C7.5 23.5, 7.5 29, 9.5 34 C11.5 45, 20 50.5, 32 50.5 C44 50.5, 52.5 45, 54.5 34 C56.5 29, 56.5 23.5, 53.5 19.5 C54.5 14, 50 13, 46 18 C42 15.5, 37 14.5, 32 14.5 C27 14.5, 22 15.5, 18 18 Z"
        stroke="currentColor"
        strokeWidth="3.4"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <g fill="currentColor">
        <ellipse cx="24.5" cy="31" rx="2.6" ry="3.3" />
        <ellipse cx="39.5" cy="31" rx="2.6" ry="3.3" />
        <ellipse cx="32" cy="39" rx="3.1" ry="2.7" />
      </g>
    </svg>
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

// Container picker + working-directory input, shared by the new-project and
// configure-project forms. The container is chosen from the live `docker ps`
// list (Rule 3: only running containers), with a manual-entry fallback for when
// Docker is unavailable. The working directory is validated against the chosen
// container so a bad path is caught before the project is saved.
type PathCheck = "idle" | "checking" | "ok" | "missing" | "error";

function ContainerField({
  running,
  dockerReady,
  container,
  onContainerChange,
  workingDir,
  onWorkingDirChange,
}: {
  running: RunningContainer[] | null;
  dockerReady: boolean;
  container: string;
  onContainerChange: (value: string) => void;
  workingDir: string;
  onWorkingDirChange: (value: string) => void;
}) {
  const runningList = running ?? [];
  const hasRunning = runningList.length > 0;
  const runningNames = runningList.map((rc) => rc.name);
  // Manual entry kicks in when there are no running containers to pick from, or
  // when the configured reference isn't one of them (e.g. typed by hand).
  const [manual, setManual] = useState(
    container !== "" && !runningNames.includes(container),
  );

  const [check, setCheck] = useState<PathCheck>("idle");
  const [checkMsg, setCheckMsg] = useState<string | null>(null);

  useEffect(() => {
    const c = container.trim();
    const wd = workingDir.trim();
    if (!dockerReady || !c || !wd) {
      setCheck("idle");
      setCheckMsg(null);
      return;
    }
    let cancelled = false;
    setCheck("checking");
    setCheckMsg(null);
    const handle = setTimeout(() => {
      api
        .checkContainerPath(c, wd)
        .then((ok) => {
          if (!cancelled) setCheck(ok ? "ok" : "missing");
        })
        .catch((e) => {
          if (!cancelled) {
            setCheck("error");
            setCheckMsg(String(e));
          }
        });
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [dockerReady, container, workingDir]);

  function onSelect(value: string) {
    if (value === "__custom__") {
      setManual(true);
      onContainerChange("");
    } else {
      setManual(false);
      onContainerChange(value);
    }
  }

  const useManual = manual || !hasRunning;
  const selectValue = runningNames.includes(container) ? container : "";

  return (
    <>
      <label className="field">
        <span className="field-label">Container</span>
        {useManual ? (
          <div className="path-input">
            <input
              value={container}
              placeholder="Container name / ref"
              onChange={(e) => onContainerChange(e.target.value)}
            />
            {hasRunning && (
              <button
                type="button"
                className="ghost-button"
                onClick={() => {
                  setManual(false);
                  onContainerChange("");
                }}
              >
                Pick running
              </button>
            )}
          </div>
        ) : (
          <select
            className="container-select container-select--full"
            value={selectValue}
            onChange={(e) => onSelect(e.target.value)}
          >
            <option value="">Select a running container…</option>
            {runningList.map((rc) => (
              <option key={rc.id} value={rc.name}>
                {rc.name} · {rc.image}
              </option>
            ))}
            <option value="__custom__">Enter manually…</option>
          </select>
        )}
        {!hasRunning && (
          <span className="muted container-hint">
            {dockerReady
              ? "No running containers detected — enter a reference manually."
              : "Docker is unavailable — enter a container reference manually."}
          </span>
        )}
      </label>

      <label className="field">
        <span className="field-label">Container working directory</span>
        <input
          value={workingDir}
          placeholder="/app"
          onChange={(e) => onWorkingDirChange(e.target.value)}
        />
        {container.trim() && workingDir.trim() && check !== "idle" && (
          <span className={"path-check path-check--" + check}>
            {check === "checking" && "Checking path…"}
            {check === "ok" && "✓ Path exists in the container"}
            {check === "missing" && "✗ Path not found in the container"}
            {check === "error" && (checkMsg ?? "Couldn't verify path")}
          </span>
        )}
      </label>
    </>
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
        <DoggerMark className="docker-warning-mark" />
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
