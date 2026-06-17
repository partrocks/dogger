import { useState } from "react";
import type { Project, RunningContainer, Task } from "../types";
import { getProjectStatus, isProjectContainerRunning } from "../types";
import * as api from "../api";
import { TaskDetail } from "./TaskDetail";
import { ProjectConfigEditor } from "./ProjectConfigEditor";
import { TaskRow } from "./TaskRow";
import { RunConsole } from "./RunConsole";
import { NewTaskDialog } from "./NewTaskDialog";
import { ConfirmDialog } from "./ConfirmDialog";

export function ProjectView({
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
                        <button
                            className="ghost-button"
                            onClick={() => setEditing(true)}
                        >
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
                                    className={
                                        "chip" +
                                        (containerRunning
                                            ? ""
                                            : " chip--offline")
                                    }
                                    title={
                                        project.container +
                                        (containerRunning
                                            ? " (running)"
                                            : " (not running)")
                                    }
                                >
                                    <span
                                        className={
                                            "status-dot status-dot--" +
                                            (containerRunning
                                                ? "online"
                                                : "offline")
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
                    <button
                        className="ghost-button"
                        onClick={() => setNewTaskOpen(true)}
                    >
                        New task
                    </button>
                </div>

                {project.tasks.length === 0 ? (
                    <p className="muted">
                        No tasks yet. Create one to scaffold a main.sh.
                    </p>
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
                            Delete project <strong>{project.name}</strong>? This
                            removes its managed directory and all of its tasks.
                            The project's own codebase is not touched.
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
