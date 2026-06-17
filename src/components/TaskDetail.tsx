import { useCallback, useEffect, useState } from "react";
import Editor from "react-simple-code-editor";
import type { Project, RunRecord, ShellInfo, Task } from "../types";
import * as api from "../api";
import { highlightCode, languageLabel } from "../highlight";
import { RunConsole } from "./RunConsole";
import { RunHistory } from "./RunHistory";
import { PromptDialog } from "./PromptDialog";
import { ConfirmDialog } from "./ConfirmDialog";

export function TaskDetail({
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
        api.listRuns(project.id, task.id)
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
        api.detectContainerShell(project.id, task.id, effectiveTarget)
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
        api.readTaskFile(project.id, task.id, activeFile)
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
                                (shell.shebang
                                    ? ` · shebang #!${shell.shebang}`
                                    : "") +
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
                                    "file-item" +
                                    (f === activeFile ? " is-active" : "")
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
                                        {busy
                                            ? "Saving…"
                                            : dirty
                                              ? "Save"
                                              : "Saved"}
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
                                    highlight={(code) =>
                                        highlightCode(code, activeFile)
                                    }
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
                            Delete task <strong>{task.name}</strong>? This
                            removes its directory and all of its files.
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
