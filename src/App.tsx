import { useCallback, useEffect, useRef, useState } from "react";
import {
    ChevronDoubleLeftIcon,
    ChevronDoubleRightIcon,
    Cog6ToothIcon,
    PlusIcon,
} from "@heroicons/react/24/outline";
import type { DockerStatus, Project, RunningContainer } from "./types";
import { getProjectStatus, isProjectContainerRunning } from "./types";
import * as api from "./api";
import { Titlebar } from "./components/Titlebar";
import { DockerWarning } from "./components/DockerWarning";
import { ProjectView } from "./components/ProjectView";
import { EmptyState } from "./components/EmptyState";
import { NewProjectDialog } from "./components/NewProjectDialog";
import { SettingsView } from "./components/SettingsView";
import { AboutView } from "./components/AboutView";
import { DoggerMark } from "./components/DoggerMark";
import { ZoomIndicator } from "./components/ZoomIndicator";
import { useZoom } from "./useZoom";
import "./App.css";

// Dogger UI, backed by on-disk state under `~/.dogger` (via the Rust commands
// in src/api.ts). Projects and tasks are read from and written to disk; a
// project's own codebase is never touched (see context/rules.md).
//
// Phase 2: container status is derived live from `docker ps`, and tasks run
// inside a running container via `docker cp` + `docker exec`, streaming output
// into the UI.

// Below this window width the sidebar auto-collapses to its icon rail.
const SIDEBAR_COLLAPSE_WIDTH = 760;

function App() {
    const [projects, setProjects] = useState<Project[]>([]);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [newProjectOpen, setNewProjectOpen] = useState(false);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [aboutOpen, setAboutOpen] = useState(false);
    // When true, the main area shows the home screen (logo + "New project"
    // CTA) regardless of which project is selected. Clicking the brand sets
    // this; selecting a project clears it.
    const [showHome, setShowHome] = useState(false);

    const zoom = useZoom();

    const [docker, setDocker] = useState<DockerStatus | null>(null);
    const [running, setRunning] = useState<RunningContainer[] | null>(null);
    const [dockerDismissed, setDockerDismissed] = useState(false);

    // The sidebar collapses to an icon rail. It auto-collapses on narrow
    // windows but stays manually toggleable; crossing the breakpoint re-syncs
    // to the window so resizing always feels natural.
    const [sidebarCollapsed, setSidebarCollapsed] = useState(
        () => window.innerWidth < SIDEBAR_COLLAPSE_WIDTH,
    );
    const wasNarrowRef = useRef(window.innerWidth < SIDEBAR_COLLAPSE_WIDTH);

    useEffect(() => {
        function onResize() {
            const narrow = window.innerWidth < SIDEBAR_COLLAPSE_WIDTH;
            if (narrow !== wasNarrowRef.current) {
                wasNarrowRef.current = narrow;
                setSidebarCollapsed(narrow);
            }
        }
        window.addEventListener("resize", onResize);
        return () => window.removeEventListener("resize", onResize);
    }, []);

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

    // Cmd/Ctrl+, opens Settings, matching the platform convention. The plain
    // comma (no Shift/Alt) keeps it distinct from other shortcuts.
    useEffect(() => {
        function onKeyDown(e: KeyboardEvent) {
            if (
                (e.metaKey || e.ctrlKey) &&
                !e.shiftKey &&
                !e.altKey &&
                e.key === ","
            ) {
                e.preventDefault();
                setAboutOpen(false);
                setSettingsOpen(true);
            }
        }
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, []);

    // The tray's "Settings…" item brings the window forward (Rust side) and
    // emits this event so we land on the Settings screen.
    useEffect(() => {
        const unlisten = api.onOpenSettings(() => {
            setAboutOpen(false);
            setSettingsOpen(true);
        });
        return () => {
            unlisten.then((fn) => fn()).catch(() => {});
        };
    }, []);

    // The tray's "About Dogger" item likewise brings the window forward and
    // emits this event so we land on the in-app About screen.
    useEffect(() => {
        const unlisten = api.onOpenAbout(() => {
            setSettingsOpen(false);
            setAboutOpen(true);
        });
        return () => {
            unlisten.then((fn) => fn()).catch(() => {});
        };
    }, []);

    // Keep live container status reasonably fresh while Docker is reachable.
    useEffect(() => {
        if (!docker?.daemonRunning) return;
        const handle = setInterval(() => {
            api.listRunningContainers()
                .then(setRunning)
                .catch(() => {});
        }, 5000);
        return () => clearInterval(handle);
    }, [docker?.daemonRunning]);

    // Keep the macOS tray menu's "online projects" list in sync. The frontend
    // owns the single Docker poll, so it pushes the derived online set to the
    // tray whenever projects or live container state change. The poll fires
    // every few seconds, so we skip the push when the derived set is unchanged
    // to avoid needlessly rebuilding/swapping the native menu.
    const lastTrayMenuRef = useRef<string>("");
    useEffect(() => {
        const online = projects
            .filter((p) => isProjectContainerRunning(p, running))
            .map((p) => ({
                id: p.id,
                name: p.name,
                tasks: p.tasks.map((t) => ({ id: t.id, name: t.name })),
            }));
        const signature = JSON.stringify(online);
        if (signature === lastTrayMenuRef.current) return;
        lastTrayMenuRef.current = signature;
        api.setTrayMenu(online).catch(() => {});
    }, [projects, running]);

    const selected = projects.find((p) => p.id === selectedId) ?? null;
    const dockerUnavailable = docker != null && !docker.daemonRunning;

    if (dockerUnavailable && !dockerDismissed) {
        return (
            <div className="window">
                <ZoomIndicator {...zoom} />
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
        setShowHome(false);
        await refresh(created.id);
    }

    return (
        <div className="window">
            <ZoomIndicator {...zoom} />
            <Titlebar />
            <div className="app">
                <aside
                    className={
                        "sidebar" +
                        (sidebarCollapsed ? " sidebar--collapsed" : "")
                    }
                >
                    <div className="brand">
                        <button
                            className="brand-home"
                            title="Home"
                            aria-label="Home"
                            onClick={() => {
                                setSettingsOpen(false);
                                setAboutOpen(false);
                                setShowHome(true);
                            }}
                        >
                            <DoggerMark className="brand-mark" />
                            {!sidebarCollapsed && (
                                <h1 className="brand-name">Dogger</h1>
                            )}
                        </button>
                        <button
                            className="sidebar-toggle"
                            title={
                                sidebarCollapsed
                                    ? "Expand sidebar"
                                    : "Collapse sidebar"
                            }
                            aria-label={
                                sidebarCollapsed
                                    ? "Expand sidebar"
                                    : "Collapse sidebar"
                            }
                            aria-expanded={!sidebarCollapsed}
                            onClick={() => setSidebarCollapsed((c) => !c)}
                        >
                            {sidebarCollapsed ? (
                                <ChevronDoubleRightIcon className="ic" />
                            ) : (
                                <ChevronDoubleLeftIcon className="ic" />
                            )}
                        </button>
                    </div>

                    <div className="sidebar-section-label">
                        {!sidebarCollapsed && <span>Projects</span>}
                        <button
                            className="icon-button"
                            title="New project"
                            aria-label="New project"
                            onClick={() => setNewProjectOpen(true)}
                        >
                            <PlusIcon className="ic" />
                        </button>
                    </div>

                    <nav className="project-list">
                        {projects.map((project) => {
                            const status = getProjectStatus(project, running);
                            const taskLabel = `${project.tasks.length} task${
                                project.tasks.length === 1 ? "" : "s"
                            }`;
                            return (
                                <button
                                    key={project.id}
                                    className={
                                        "project-item" +
                                        (project.id === selectedId
                                            ? " is-active"
                                            : "")
                                    }
                                    onClick={() => {
                                        setSettingsOpen(false);
                                        setAboutOpen(false);
                                        setShowHome(false);
                                        setSelectedId(project.id);
                                    }}
                                    title={
                                        sidebarCollapsed
                                            ? `${project.name} · ${taskLabel}`
                                            : undefined
                                    }
                                >
                                    {sidebarCollapsed ? (
                                        <span className="project-item-avatar">
                                            {project.name
                                                .trim()
                                                .charAt(0)
                                                .toUpperCase() || "?"}
                                            <span
                                                className={
                                                    "status-dot status-dot--" +
                                                    status +
                                                    " project-item-avatar-dot"
                                                }
                                            />
                                        </span>
                                    ) : (
                                        <>
                                            <span className="project-item-name">
                                                <span
                                                    className={
                                                        "status-dot status-dot--" +
                                                        status
                                                    }
                                                    title={
                                                        status === "online"
                                                            ? "Online"
                                                            : "Offline"
                                                    }
                                                />
                                                {project.name}
                                            </span>
                                            <span className="project-item-meta">
                                                {taskLabel}
                                            </span>
                                        </>
                                    )}
                                </button>
                            );
                        })}
                        {!loading &&
                            projects.length === 0 &&
                            !sidebarCollapsed && (
                                <p className="sidebar-empty">No projects yet.</p>
                            )}
                    </nav>

                    <div className="sidebar-bottom">
                        <button
                            className={
                                "sidebar-action" +
                                (settingsOpen ? " is-active" : "")
                            }
                            onClick={() => {
                                setAboutOpen(false);
                                setSettingsOpen(true);
                            }}
                            title="Settings"
                            aria-label="Settings"
                        >
                            <Cog6ToothIcon className="ic" />
                            {!sidebarCollapsed && <span>Settings</span>}
                        </button>
                        {!sidebarCollapsed && (
                            <button
                                className={
                                    "sidebar-footer" +
                                    (aboutOpen ? " is-active" : "")
                                }
                                onClick={() => {
                                    setSettingsOpen(false);
                                    setAboutOpen(true);
                                }}
                                title="About Dogger"
                            >
                                &copy; 2026 PartRocks, Happy Coder.
                            </button>
                        )}
                    </div>
                </aside>

                <main className="main">
                    {error && (
                        <div className="banner banner--error">{error}</div>
                    )}
                    {dockerUnavailable && dockerDismissed && (
                        <div className="banner banner--warn">
                            Docker is unavailable — tasks can't run.{" "}
                            {docker?.message}{" "}
                            <button
                                className="link-button"
                                onClick={refreshDocker}
                            >
                                Retry
                            </button>
                        </div>
                    )}
                    {aboutOpen ? (
                        <AboutView onClose={() => setAboutOpen(false)} />
                    ) : settingsOpen ? (
                        <SettingsView onClose={() => setSettingsOpen(false)} />
                    ) : loading ? (
                        <div className="empty-state">
                            <p>Loading…</p>
                        </div>
                    ) : selected && !showHome ? (
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

export default App;
