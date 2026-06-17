import { useState } from "react";
import { Modal } from "./Modal";

// Inline single-field prompt, replacing window.prompt.
export function PromptDialog({
    title,
    label,
    placeholder,
    confirmLabel,
    busy,
    onCancel,
    onConfirm,
}: {
    title: string;
    label: string;
    placeholder?: string;
    confirmLabel: string;
    busy?: boolean;
    onCancel: () => void;
    onConfirm: (value: string) => void;
}) {
    const [value, setValue] = useState("");
    const trimmed = value.trim();

    return (
        <Modal title={title} onClose={onCancel}>
            <label className="field">
                <span className="field-label">{label}</span>
                <input
                    autoFocus
                    value={value}
                    placeholder={placeholder}
                    onChange={(e) => setValue(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === "Enter" && trimmed && !busy)
                            onConfirm(trimmed);
                    }}
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
                    onClick={() => onConfirm(trimmed)}
                    disabled={busy || !trimmed}
                >
                    {busy ? "Working…" : confirmLabel}
                </button>
            </div>
        </Modal>
    );
}
