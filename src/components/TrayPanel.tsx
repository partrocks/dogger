import { useCallback, useEffect, useState } from "react";
import {
    ChevronRightIcon,
    Cog6ToothIcon,
    InformationCircleIcon,
    PlayIcon,
    PowerIcon,
    WindowIcon,
} from "@heroicons/react/24/outline";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { Project, RunningContainer } from "../types";
import { isProjectContainerRunning } from "../types";
import * as api from "../api";
import { DoggerMark } from "./DoggerMark";

// The menu bar popover, loaded as its own window with `?view=tray`. It mirrors
// the native tray menu: the set of *online* projects (their container is
// running) with their tasks, plus the same Show/Hide, Settings, About and Quit
// actions. Clicking a task opens the dedicated runner window, exactly as the
// native menu does. All actions route through the `tray_*` Rust commands so the
// two menus stay behaviourally identical.
export function TrayPanel() {
    const [projects, setProjects] = useState<Project[]>([]);
    const [running, setRunning] = useState<RunningContainer[] | null>(null);
    const [dockerReady, setDockerReady] = useState(true);
    const [expandedId, setExpandedId] = useState<string | null>(null);
    // The popover spends most of its life hidden; only poll while it's open
    // (focused) so we don't run `docker ps` in the background alongside the
    // main window's own poller.
    const [active, setActive] = useState(false);

    const refresh = useCallback(async () => {
        try {
            const [list, docker] = await Promise.all([
                api.listProjects(),
                api.dockerStatus(),
            ]);
            setProjects(list);
            setDockerReady(docker.daemonRunning);
            if (docker.daemonRunning) {
                try {
                    setRunning(await api.listRunningContainers());
                } catch {
                    setRunning(null);
                }
            } else {
                setRunning(null);
            }
        } catch {
            // Keep the last known state on a transient failure.
        }
    }, []);

    // The panel window is preloaded hidden at startup; prime it once so the
    // first open shows current data immediately rather than an empty flash.
    useEffect(() => {
        refresh();
    }, [refresh]);

    // Refresh the moment the popover is shown (it gains focus), and track that
    // open/closed state to drive polling.
    useEffect(() => {
        let unlisten: (() => void) | undefined;
        getCurrentWindow()
            .onFocusChanged(({ payload: focused }) => {
                setActive(focused);
                if (focused) refresh();
            })
            .then((fn) => (unlisten = fn))
            .catch(() => {});
        return () => unlisten?.();
    }, [refresh]);

    // While open, keep the list reasonably fresh.
    useEffect(() => {
        if (!active) return;
        const handle = setInterval(refresh, 4000);
        return () => clearInterval(handle);
    }, [active, refresh]);

    const online = projects.filter((p) =>
        isProjectContainerRunning(p, running),
    );

    function runTask(projectId: string, taskId: string) {
        api.trayRunTask(projectId, taskId).catch(() => {});
        api.trayHidePanel().catch(() => {});
    }

    function act(fn: () => Promise<void>) {
        fn().catch(() => {});
        api.trayHidePanel().catch(() => {});
    }

    const statusText = !dockerReady
        ? "Docker unavailable"
        : online.length === 0
          ? "No projects online"
          : `${online.length} project${online.length === 1 ? "" : "s"} online`;

    return (
        <div className="tray-panel">
            <header className="tray-head">
                <DoggerMark className="tray-mark" />
                <div className="tray-head-text">
                    <span className="tray-title">Dogger</span>
                    <span className="tray-status">{statusText}</span>
                </div>
            </header>

            <div className="tray-body">
                {online.length === 0 ? (
                    <div className="tray-empty">
                        {dockerReady
                            ? "No online projects"
                            : "Start Docker to see online projects"}
                    </div>
                ) : (
                    <ul className="tray-projects">
                        {online.map((p) => {
                            const isOpen = expandedId === p.id;
                            return (
                                <li key={p.id} className="tray-project">
                                    <button
                                        className="tray-project-head"
                                        aria-expanded={isOpen}
                                        onClick={() =>
                                            setExpandedId(isOpen ? null : p.id)
                                        }
                                    >
                                        <span className="status-dot status-dot--online" />
                                        <span className="tray-project-name">
                                            {p.name}
                                        </span>
                                        <span className="tray-project-count">
                                            {p.tasks.length}
                                        </span>
                                        <ChevronRightIcon
                                            className={`tray-chevron${isOpen ? " is-open" : ""}`}
                                        />
                                    </button>

                                    {isOpen && (
                                        <ul className="tray-tasks">
                                            {p.tasks.length === 0 ? (
                                                <li className="tray-task-empty">
                                                    No tasks
                                                </li>
                                            ) : (
                                                p.tasks.map((t) => (
                                                    <li key={t.id}>
                                                        <button
                                                            className="tray-task"
                                                            onClick={() =>
                                                                runTask(
                                                                    p.id,
                                                                    t.id,
                                                                )
                                                            }
                                                        >
                                                            <PlayIcon className="tray-task-ic" />
                                                            <span className="tray-task-name">
                                                                {t.name}
                                                            </span>
                                                        </button>
                                                    </li>
                                                ))
                                            )}
                                        </ul>
                                    )}
                                </li>
                            );
                        })}
                    </ul>
                )}
            </div>

            <footer className="tray-foot">
                <button
                    className="tray-action"
                    title="Show / Hide Dogger"
                    onClick={() => act(api.trayShowHide)}
                >
                    <WindowIcon className="ic" />
                </button>
                <button
                    className="tray-action"
                    title="Settings"
                    onClick={() => act(api.trayOpenSettings)}
                >
                    <Cog6ToothIcon className="ic" />
                </button>
                <button
                    className="tray-action"
                    title="About Dogger"
                    onClick={() => act(api.trayOpenAbout)}
                >
                    <InformationCircleIcon className="ic" />
                </button>
                <button
                    className="tray-action tray-action--quit"
                    title="Quit Dogger"
                    onClick={() => api.trayQuit()}
                >
                    <PowerIcon className="ic" />
                </button>
            </footer>
        </div>
    );
}
