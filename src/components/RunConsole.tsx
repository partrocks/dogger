import { useEffect, useRef, useState } from "react";
import { XMarkIcon } from "@heroicons/react/24/outline";
import type { OutputLine, RunStatus } from "../types";
import * as api from "../api";
import { RunStatusBadge } from "./RunStatusBadge";
import { OutputView } from "./OutputView";

// Live console for a task run. It attaches event listeners *before* kicking off
// the run (guarded against StrictMode double-invocation) so no early output is
// missed, then streams stdout/stderr and reports the exit code.
export function RunConsole({
    projectId,
    taskId,
    taskName,
    container,
    runId,
    onClose,
    onFinished,
}: {
    projectId: string;
    taskId: string;
    taskName: string;
    container: string;
    runId: string;
    onClose: () => void;
    onFinished?: () => void;
}) {
    const [lines, setLines] = useState<OutputLine[]>([]);
    const [status, setStatus] = useState<RunStatus | "starting">("starting");
    const [exitCode, setExitCode] = useState<number | null>(null);
    const [error, setError] = useState<string | null>(null);
    const startedRef = useRef(false);
    const bodyRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        let cancelled = false;
        let unOut: (() => void) | undefined;
        let unFin: (() => void) | undefined;

        api.onRunOutput((e) => {
            if (e.runId !== runId) return;
            setLines((prev) => [...prev, { stream: e.stream, text: e.line }]);
        }).then((fn) => (cancelled ? fn() : (unOut = fn)));

        api.onRunFinished((e) => {
            if (e.runId !== runId) return;
            setStatus(e.status);
            setExitCode(e.exitCode);
            onFinished?.();
        }).then((fn) => (cancelled ? fn() : (unFin = fn)));

        return () => {
            cancelled = true;
            unOut?.();
            unFin?.();
        };
    }, [runId, onFinished]);

    useEffect(() => {
        if (startedRef.current) return;
        startedRef.current = true;
        setStatus("running");
        api.runTask({ projectId, taskId, container, runId }).catch((e) => {
            setError(String(e));
            setStatus("error");
        });
    }, [projectId, taskId, container, runId]);

    useEffect(() => {
        const el = bodyRef.current;
        if (el) el.scrollTop = el.scrollHeight;
    }, [lines]);

    const finished = status !== "starting" && status !== "running";

    useEffect(() => {
        if (!finished) return;
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === "Escape") onClose();
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [finished, onClose]);

    return (
        <div className="modal-overlay" onClick={finished ? onClose : undefined}>
            <div
                className="run-modal"
                role="dialog"
                aria-label={"Run " + taskName}
                onClick={(e) => e.stopPropagation()}
            >
                <div className="run-modal-head">
                    <div className="run-modal-title">
                        <RunStatusBadge status={status} exitCode={exitCode} />
                        <span className="run-modal-name">{taskName}</span>
                        <code className="run-modal-target">{container}</code>
                    </div>
                    <button
                        className="icon-button icon-button--light"
                        onClick={onClose}
                        disabled={!finished}
                        title={finished ? "Close" : "Run in progress…"}
                        aria-label="Close"
                    >
                        <XMarkIcon className="ic-lg" />
                    </button>
                </div>
                {error && <div className="banner banner--error">{error}</div>}
                <OutputView
                    lines={lines}
                    forwardRef={bodyRef}
                    live={!finished}
                />
                <div className="run-modal-foot">
                    {status === "running" && (
                        <span className="muted">Running…</span>
                    )}
                    {finished && (
                        <span className="muted">
                            {status === "success"
                                ? "Completed successfully"
                                : status === "failed"
                                  ? `Exited with code ${exitCode ?? "?"}`
                                  : "Run error"}
                        </span>
                    )}
                    <button
                        className="ghost-button"
                        onClick={onClose}
                        disabled={!finished}
                    >
                        Close
                    </button>
                </div>
            </div>
        </div>
    );
}
