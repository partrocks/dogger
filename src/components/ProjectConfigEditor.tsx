import { useState } from "react";
import type { Project, RunningContainer } from "../types";
import * as api from "../api";
import { CodebasePathField } from "./CodebasePathField";
import { ContainerField } from "./ContainerField";

export function ProjectConfigEditor({
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
                    <input
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                    />
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
                <button
                    className="ghost-button"
                    onClick={onCancel}
                    disabled={busy}
                >
                    Cancel
                </button>
                <button
                    className="primary-button"
                    onClick={save}
                    disabled={busy}
                >
                    {busy ? "Saving…" : "Save changes"}
                </button>
            </div>
        </div>
    );
}
