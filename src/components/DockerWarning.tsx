import type { DockerStatus } from "../types";
import { DoggerMark } from "./DoggerMark";

// Full-screen warning shown when the Docker CLI/daemon can't be reached. Dogger
// never starts Docker itself (see context/rules.md) — it just guides the user.
export function DockerWarning({
    status,
    onRetry,
    onContinue,
}: {
    status: DockerStatus | null;
    onRetry: () => void;
    onContinue: () => void;
}) {
    const notInstalled = status != null && !status.cliInstalled;
    return (
        <div className="docker-warning">
            <div className="docker-warning-card">
                <DoggerMark className="docker-warning-mark" />
                <h2>
                    {notInstalled ? "Docker not found" : "Docker isn't running"}
                </h2>
                <p className="muted">
                    {status?.message ??
                        "Dogger needs the Docker CLI and a running daemon to execute tasks."}
                </p>
                <p className="muted docker-warning-note">
                    Dogger never starts or manages containers itself — start
                    Docker (and your containers) on the host, then retry.
                </p>
                <div className="form-actions form-actions--center">
                    <button className="ghost-button" onClick={onContinue}>
                        Continue without Docker
                    </button>
                    <button className="primary-button" onClick={onRetry}>
                        Retry
                    </button>
                </div>
            </div>
        </div>
    );
}
