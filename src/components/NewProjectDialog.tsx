import { useState } from "react";
import type { RunningContainer } from "../types";
import * as api from "../api";
import { Modal } from "./Modal";
import { CodebasePathField } from "./CodebasePathField";
import { ContainerField } from "./ContainerField";

export function NewProjectDialog({
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
                <button
                    className="ghost-button"
                    onClick={onCancel}
                    disabled={busy}
                >
                    Cancel
                </button>
                <button
                    className="primary-button"
                    onClick={submit}
                    disabled={busy}
                >
                    {busy ? "Creating…" : "Create project"}
                </button>
            </div>
        </Modal>
    );
}
