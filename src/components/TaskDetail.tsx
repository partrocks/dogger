import { useCallback, useEffect, useRef, useState } from "react";
import {
    ArrowLeftIcon,
    PlusIcon,
    SparklesIcon,
} from "@heroicons/react/24/outline";
import { PlayIcon } from "@heroicons/react/24/solid";
import Editor from "react-simple-code-editor";
import type { Project, RunRecord, ShellInfo, Task } from "../types";
import * as api from "../api";
import { highlightCode, languageLabel } from "../highlight";
import { RunConsole } from "./RunConsole";
import { RunHistory } from "./RunHistory";
import { PromptDialog } from "./PromptDialog";
import { ConfirmDialog } from "./ConfirmDialog";
import { GenerateTab } from "./GenerateTab";

export function TaskDetail({
    project,
    task,
    containerRunning,
    dockerReady,
    onClose,
    onChanged,
    onDeleted,
}: {
    project: Project;
    task: Task;
    containerRunning: boolean;
    dockerReady: boolean;
    onClose: () => void;
    onChanged: () => void;
    onDeleted: () => void;
}) {
    const [activeTab, setActiveTab] = useState<"build" | "generate">("build");
    // Whether an OpenAI token is configured. The Generate tab needs it, so the
    // tab is disabled (with an explanatory tooltip) until one is set. Resolved
    // once on mount; `null` while loading, which we treat as "allowed" so the
    // tab isn't flagged as unavailable before we actually know.
    const [hasToken, setHasToken] = useState<boolean | null>(null);
    const [files, setFiles] = useState<string[]>([]);
    const [activeFile, setActiveFile] = useState<string | null>(null);
    const [contents, setContents] = useState("");
    const [dirty, setDirty] = useState(false);
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState<string | null>(null);

    // Task metadata (`task.json`) is edited through this form rather than as a
    // raw file in the list. Seeded from the task and kept in sync as it changes.
    const [name, setName] = useState(task.name);
    const [description, setDescription] = useState(task.description ?? "");
    const [detailsBusy, setDetailsBusy] = useState(false);
    const detailsDirty =
        name.trim() !== task.name ||
        description.trim() !== (task.description ?? "");
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

    // The Generate tab requires an OpenAI token; disable it until one is set.
    const generateDisabled = hasToken === false;

    const loadRuns = useCallback(() => {
        api.listRuns(project.id, task.id)
            .then(setRuns)
            .catch(() => {});
    }, [project.id, task.id]);

    useEffect(() => {
        loadRuns();
    }, [loadRuns]);

    useEffect(() => {
        let cancelled = false;
        api.getSettings()
            .then((s) => !cancelled && setHasToken(!!s.openaiToken.trim()))
            .catch(() => !cancelled && setHasToken(null));
        return () => {
            cancelled = true;
        };
    }, []);

    // If the token check resolves to missing while the Generate tab is active
    // (e.g. it was opened before the check finished), fall back to Build.
    useEffect(() => {
        if (generateDisabled && activeTab === "generate") setActiveTab("build");
    }, [generateDisabled, activeTab]);

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

    // `task.json` is task metadata, edited via the details form above the
    // editor — never surfaced as a raw, editable file in the list.
    const loadFiles = useCallback(
        async (preferFile?: string) => {
            try {
                const list = (
                    await api.listTaskFiles(project.id, task.id)
                ).filter((f) => f !== "task.json");
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

    const loadContents = useCallback(
        (file: string | null) => {
            if (!file) {
                setContents("");
                setDirty(false);
                return () => {};
            }
            let cancelled = false;
            api.readTaskFile(project.id, task.id, file)
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
        },
        [project.id, task.id],
    );

    useEffect(() => loadContents(activeFile), [activeFile, loadContents]);

    // The Generate tab can have the agent rewrite task files (or add/remove
    // them) while it's open. Re-reading only happens when `activeFile` changes,
    // so switching back to Build with the same file selected would otherwise
    // show stale content. Refresh the list and active file whenever the Build
    // tab becomes active. Using a ref to detect the transition avoids a
    // duplicate load on mount (where the tab already starts as "build").
    const prevTabRef = useRef(activeTab);
    useEffect(() => {
        const enteredBuild =
            activeTab === "build" && prevTabRef.current !== "build";
        prevTabRef.current = activeTab;
        if (!enteredBuild) return;
        loadFiles();
        return loadContents(activeFile);
    }, [activeTab, loadFiles, loadContents, activeFile]);

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

    useEffect(() => {
        setName(task.name);
        setDescription(task.description ?? "");
    }, [task.id, task.name, task.description]);

    async function saveDetails() {
        const trimmed = name.trim();
        if (!trimmed) {
            setErr("Task name is required.");
            return;
        }
        setDetailsBusy(true);
        setErr(null);
        try {
            await api.updateTask({
                projectId: project.id,
                taskId: task.id,
                name: trimmed,
                description: description.trim() || undefined,
            });
            onChanged();
        } catch (e) {
            setErr(String(e));
        } finally {
            setDetailsBusy(false);
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
                    <ArrowLeftIcon className="ic-sm" />
                    {project.name}
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
                        <PlayIcon className="ic" />
                        Run
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

            <section className="task-details">
                <div className="task-details-head">
                    <span>Details</span>
                    <button
                        className="primary-button"
                        onClick={saveDetails}
                        disabled={detailsBusy || !detailsDirty || !name.trim()}
                    >
                        {detailsBusy
                            ? "Saving…"
                            : detailsDirty
                              ? "Save"
                              : "Saved"}
                    </button>
                </div>
                <div className="task-details-fields">
                    <label className="field">
                        <span className="field-label">Title</span>
                        <input
                            value={name}
                            placeholder="Task name"
                            onChange={(e) => setName(e.target.value)}
                        />
                    </label>
                    <label className="field">
                        <span className="field-label">Description</span>
                        <textarea
                            className="task-details-description"
                            value={description}
                            placeholder="What does this task do?"
                            rows={3}
                            onChange={(e) => setDescription(e.target.value)}
                        />
                    </label>
                </div>
            </section>

            <div className="task-tabs">
                <div className="task-tab-strip" role="tablist">
                    <button
                        role="tab"
                        aria-selected={activeTab === "build"}
                        className={
                            "task-tab" +
                            (activeTab === "build" ? " is-active" : "")
                        }
                        onClick={() => setActiveTab("build")}
                    >
                        Build
                    </button>
                    {/* Wrapper carries the tooltip: a disabled <button> doesn't
                        emit the hover events a native `title` needs, so we let
                        pointer events fall through to this span instead. */}
                    <span
                        className="task-tab-wrap"
                        title={
                            generateDisabled
                                ? "Add your OpenAI token in Settings to generate tasks"
                                : undefined
                        }
                    >
                        <button
                            role="tab"
                            aria-selected={activeTab === "generate"}
                            aria-disabled={generateDisabled}
                            className={
                                "task-tab" +
                                (activeTab === "generate" ? " is-active" : "")
                            }
                            disabled={generateDisabled}
                            onClick={() => setActiveTab("generate")}
                        >
                            <SparklesIcon className="ic-sm" />
                            Generate
                        </button>
                    </span>
                </div>

                {activeTab === "build" ? (
                    <div className="file-editor">
                        <div className="file-list">
                            <div className="file-list-head">
                                <span>Files</span>
                                <button
                                    className="icon-button icon-button--light"
                                    title="New file"
                                    aria-label="New file"
                                    onClick={() => setAddFileOpen(true)}
                                >
                                    <PlusIcon className="ic-lg" />
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
                                            (f === activeFile
                                                ? " is-active"
                                                : "")
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
                                            onKeyDown={(e) => {
                                                if (
                                                    (e.metaKey || e.ctrlKey) &&
                                                    !e.shiftKey &&
                                                    !e.altKey &&
                                                    e.key === "s"
                                                ) {
                                                    e.preventDefault();
                                                    if (
                                                        dirty &&
                                                        !busy &&
                                                        activeFile
                                                    ) {
                                                        save();
                                                    }
                                                }
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
                ) : (
                    <GenerateTab
                        project={project}
                        task={task}
                        onGenerated={() => loadFiles()}
                    />
                )}
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
