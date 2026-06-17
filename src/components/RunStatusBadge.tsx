import type { RunStatus } from "../types";

export function RunStatusBadge({
    status,
    exitCode,
}: {
    status: RunStatus | "starting";
    exitCode?: number | null;
}) {
    const cls =
        status === "success"
            ? "run-badge run-badge--success"
            : status === "failed" || status === "error"
              ? "run-badge run-badge--failed"
              : "run-badge run-badge--running";
    const label =
        status === "starting"
            ? "Starting"
            : status === "running"
              ? "Running"
              : status === "success"
                ? "Success"
                : status === "failed"
                  ? `Failed (${exitCode ?? "?"})`
                  : "Error";
    return <span className={cls}>{label}</span>;
}
