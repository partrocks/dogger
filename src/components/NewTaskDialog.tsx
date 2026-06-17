import { useState } from "react";
import { Modal } from "./Modal";

export function NewTaskDialog({
    onCancel,
    onCreate,
}: {
    onCancel: () => void;
    onCreate: (input: { name: string; description?: string }) => Promise<void>;
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
                    {busy ? "Creating…" : "Create task"}
                </button>
            </div>
        </Modal>
    );
}
