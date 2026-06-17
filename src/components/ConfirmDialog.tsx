import type { ReactNode } from "react";
import { Modal } from "./Modal";

// Inline confirmation dialog, replacing window.confirm so it matches the app's
// look and works reliably inside the Tauri webview.
export function ConfirmDialog({
    title,
    message,
    confirmLabel,
    busy,
    onCancel,
    onConfirm,
}: {
    title: string;
    message: ReactNode;
    confirmLabel: string;
    busy?: boolean;
    onCancel: () => void;
    onConfirm: () => void;
}) {
    return (
        <Modal title={title} onClose={onCancel}>
            <p className="modal-hint">{message}</p>
            <div className="form-actions">
                <button
                    className="ghost-button"
                    onClick={onCancel}
                    disabled={busy}
                >
                    Cancel
                </button>
                <button
                    className="primary-button primary-button--danger"
                    onClick={onConfirm}
                    disabled={busy}
                >
                    {busy ? "Working…" : confirmLabel}
                </button>
            </div>
        </Modal>
    );
}
