import { useCallback, useEffect, useRef, useState } from "react";
import { PlayIcon } from "@heroicons/react/24/solid";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { OutputLine, Project, RunStatus, Task } from "../types";
import { matchesRunning } from "../types";
import * as api from "../api";
import { Titlebar } from "./Titlebar";
import { RunStatusBadge } from "./RunStatusBadge";
import { OutputView } from "./OutputView";

type RunState = RunStatus | "idle" | "starting";

function newRunId(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// Standalone task runner shown in its own small window, opened from the tray
// menu. Unlike the in-app `RunConsole`, the run is triggered manually with a
// Run button and can be repeated; output streams in via the same Tauri events.
export function RunnerWindow({
    projectId,
    taskId,
}: {
    projectId: string;
    taskId: string;
}) {
    const [project, setProject] = useState<Project | null>(null);
    const [task, setTask] = useState<Task | null>(null);
    const [containerRunning, setContainerRunning] = useState(false);
    const [dockerReady, setDockerReady] = useState(false);
    const [loadError, setLoadError] = useState<string | null>(null);

    const [lines, setLines] = useState<OutputLine[]>([]);
    const [status, setStatus] = useState<RunState>("idle");
    const [exitCode, setExitCode] = useState<number | null>(null);
    const [runError, setRunError] = useState<string | null>(null);

    // Whether the "Auto-run" setting is on. `null` until settings load, so we
    // don't kick off a run before we know the user's preference.
    const [autoRun, setAutoRun] = useState<boolean | null>(null);
    // Guards the one-shot auto-run so it fires at most once per window, even as
    // Docker/container state churns the `canRun` flag.
    const autoRanRef = useRef(false);

    const runIdRef = useRef<string | null>(null);
    const bodyRef = useRef<HTMLDivElement | null>(null);

    const container = project?.container ?? "";
    const canRun =
        dockerReady &&
        !!container &&
        containerRunning &&
        !!task &&
        status !== "running" &&
        status !== "starting";

    const refresh = useCallback(async () => {
        try {
            const [projects, docker] = await Promise.all([
                api.listProjects(),
                api.dockerStatus(),
            ]);
            const proj = projects.find((p) => p.id === projectId) ?? null;
            setProject(proj);
            setTask(proj?.tasks.find((t) => t.id === taskId) ?? null);
            setDockerReady(docker.daemonRunning);
            if (proj?.container && docker.daemonRunning) {
                try {
                    const running = await api.listRunningContainers();
                    setContainerRunning(matchesRunning(proj.container, running));
                } catch {
                    setContainerRunning(false);
                }
            } else {
                setContainerRunning(false);
            }
            setLoadError(null);
        } catch (e) {
            setLoadError(String(e));
        }
    }, [projectId, taskId]);

    useEffect(() => {
        refresh();
    }, [refresh]);

    // Resolve the "Auto-run" preference once; failures fall back to "off" so a
    // settings read error can't trap the user in an unexpected run.
    useEffect(() => {
        let cancelled = false;
        api.getSettings()
            .then((s) => !cancelled && setAutoRun(s.autoRun))
            .catch(() => !cancelled && setAutoRun(false));
        return () => {
            cancelled = true;
        };
    }, []);

    // Attach the streaming listeners once; they filter to the active run id so
    // re-runs (which mint a fresh id) don't pick up stale events.
    useEffect(() => {
        let cancelled = false;
        let unOut: (() => void) | undefined;
        let unFin: (() => void) | undefined;

        api.onRunOutput((e) => {
            if (e.runId !== runIdRef.current) return;
            setLines((prev) => [...prev, { stream: e.stream, text: e.line }]);
        }).then((fn) => (cancelled ? fn() : (unOut = fn)));

        api.onRunFinished((e) => {
            if (e.runId !== runIdRef.current) return;
            setStatus(e.status);
            setExitCode(e.exitCode);
        }).then((fn) => (cancelled ? fn() : (unFin = fn)));

        return () => {
            cancelled = true;
            unOut?.();
            unFin?.();
        };
    }, []);

    useEffect(() => {
        const el = bodyRef.current;
        if (el) el.scrollTop = el.scrollHeight;
    }, [lines]);

    // Esc closes the runner window.
    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                e.preventDefault();
                getCurrentWindow().close();
            }
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, []);

    const run = useCallback(() => {
        if (!project || !task || !container) return;
        const runId = newRunId();
        runIdRef.current = runId;
        setLines([]);
        setExitCode(null);
        setRunError(null);
        setStatus("starting");
        api.runTask({ projectId: project.id, taskId: task.id, container, runId })
            .then(() => setStatus("running"))
            .catch((e) => {
                setRunError(String(e));
                setStatus("error");
            });
    }, [project, task, container]);

    // When "Auto-run" is enabled, start the task as soon as the window is ready
    // to run it (Docker up, container online, task loaded). Fires once per
    // window via `autoRanRef`; re-clicking a tray task just focuses the
    // existing window, so it won't trigger a second automatic run.
    useEffect(() => {
        if (autoRun && canRun && !autoRanRef.current) {
            autoRanRef.current = true;
            run();
        }
    }, [autoRun, canRun, run]);

    const finished =
        status === "success" || status === "failed" || status === "error";
    const running = status === "running" || status === "starting";

    const runHint = !dockerReady
        ? "Docker is unavailable"
        : !container
          ? "No container configured for this project"
          : !containerRunning
            ? `Container ${container} is not running`
            : `Run in ${container}`;

    return (
        <div className="window">
            <Titlebar />
            <div className="runner-body">
                <div className="runner-head">
                    <div className="runner-title">
                        <span className="runner-name">
                            {task?.name ?? "Task"}
                        </span>
                        {project && (
                            <span className="runner-project">
                                {project.name}
                            </span>
                        )}
                        {container && (
                            <code className="run-modal-target">
                                {container}
                            </code>
                        )}
                    </div>
                    {status !== "idle" && (
                        <RunStatusBadge
                            status={status === "starting" ? "starting" : status}
                            exitCode={exitCode}
                        />
                    )}
                </div>

                {loadError && (
                    <div className="banner banner--error">{loadError}</div>
                )}
                {runError && (
                    <div className="banner banner--error">{runError}</div>
                )}
                {!loadError && !task && (
                    <div className="banner banner--warn">
                        This task could not be found.
                    </div>
                )}

                <OutputView lines={lines} forwardRef={bodyRef} live={running} />

                <div className="runner-foot">
                    <span className="muted">
                        {status === "idle"
                            ? "Ready to run"
                            : status === "starting"
                              ? "Starting…"
                              : status === "running"
                                ? "Running…"
                                : status === "success"
                                  ? "Completed successfully"
                                  : status === "failed"
                                    ? `Exited with code ${exitCode ?? "?"}`
                                    : "Run error"}
                    </span>
                    <div className="runner-foot-actions">
                        {finished ? (
                            <button
                                className="primary-button"
                                onClick={() => getCurrentWindow().close()}
                            >
                                Close
                            </button>
                        ) : (
                            <>
                                <button
                                    className="ghost-button"
                                    onClick={() => getCurrentWindow().close()}
                                >
                                    Close
                                </button>
                                <button
                                    className="primary-button"
                                    disabled={!canRun}
                                    title={runHint}
                                    onClick={run}
                                >
                                    <PlayIcon className="ic" />
                                    Run
                                </button>
                            </>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}
