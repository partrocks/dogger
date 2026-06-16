import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { DockerContainer, Project, Task } from "./types";
import { getProjectStatus } from "./types";
import * as api from "./api";
import "./App.css";

// Dogger UI shell, now backed by on-disk state under `~/.dogger` (via the Rust
// commands in src/api.ts). Projects and tasks are read from and written to
// disk; a project's own codebase is never touched (see context/rules.md).
//
// Still Phase 1: task "Run" is a placeholder — Docker execution arrives in
// Phase 2.

function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newProjectOpen, setNewProjectOpen] = useState(false);

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

  useEffect(() => {
    refresh();
  }, [refresh]);

  const selected = projects.find((p) => p.id === selectedId) ?? null;

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
              const status = getProjectStatus(project);
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

          <div className="sidebar-footer">Phase 1 · stored in ~/.dogger</div>
        </aside>

        <main className="main">
          {error && <div className="banner banner--error">{error}</div>}
          {loading ? (
            <div className="empty-state">
              <p>Loading…</p>
            </div>
          ) : selected ? (
            <ProjectView
              key={selected.id}
              project={selected}
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
  onChanged,
  onDeleted,
}: {
  project: Project;
  onChanged: (id: string) => void;
  onDeleted: () => void;
}) {
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const status = getProjectStatus(project);
  const openTask = project.tasks.find((t) => t.id === openTaskId) ?? null;

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
              {project.containers.length === 0 ? (
                <span className="muted">None configured</span>
              ) : (
                project.containers.map((c) => (
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
                onOpen={() => setOpenTaskId(task.id)}
              />
            ))}
          </ul>
        )}
      </section>

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

function TaskRow({ task, onOpen }: { task: Task; onOpen: () => void }) {
  return (
    <li className="task-row">
      <button className="task-info task-info--button" onClick={onOpen}>
        <span className="task-name">{task.name}</span>
        <code className="task-entry">{task.dir}/main.sh</code>
        {task.description && (
          <span className="task-desc">{task.description}</span>
        )}
      </button>
      <button
        className="run-button"
        disabled
        title="Execution coming in Phase 2"
      >
        ▶ Run
      </button>
    </li>
  );
}

function ProjectConfigEditor({
  project,
  onCancel,
  onSaved,
}: {
  project: Project;
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
          Add container
        </button>
      </div>
      <p className="muted container-hint">
        In Phase 2 these are matched against running containers (`docker ps`).
        The “running” toggle is a temporary mock until then.
      </p>

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
  onClose,
  onDeleted,
}: {
  project: Project;
  task: Task;
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

export default App;
