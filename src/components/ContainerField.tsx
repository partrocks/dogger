import { useEffect, useState } from "react";
import type { RunningContainer } from "../types";
import * as api from "../api";

// Container picker + working-directory input, shared by the new-project and
// configure-project forms. The container is chosen from the live `docker ps`
// list (Rule 3: only running containers), with a manual-entry fallback for when
// Docker is unavailable. The working directory is validated against the chosen
// container so a bad path is caught before the project is saved.
type PathCheck = "idle" | "checking" | "ok" | "missing" | "error";

export function ContainerField({
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
            api.checkContainerPath(c, wd)
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
                        {check === "missing" &&
                            "✗ Path not found in the container"}
                        {check === "error" &&
                            (checkMsg ?? "Couldn't verify path")}
                    </span>
                )}
            </label>
        </>
    );
}
