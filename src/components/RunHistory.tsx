import { useState } from "react";
import type { RunRecord } from "../types";
import { RunStatusBadge } from "./RunStatusBadge";
import { OutputView } from "./OutputView";

export function RunHistory({ runs }: { runs: RunRecord[] }) {
    return (
        <section className="runs-section">
            <div className="section-head section-head--spaced">
                <h3>Run history</h3>
            </div>
            {runs.length === 0 ? (
                <p className="muted">No runs yet.</p>
            ) : (
                <ul className="runs-list">
                    {runs.map((run) => (
                        <RunHistoryItem key={run.id} run={run} />
                    ))}
                </ul>
            )}
        </section>
    );
}

function RunHistoryItem({ run }: { run: RunRecord }) {
    const [open, setOpen] = useState(false);
    const when = new Date(run.startedAt).toLocaleString();
    const duration =
        run.finishedAt != null
            ? `${((run.finishedAt - run.startedAt) / 1000).toFixed(1)}s`
            : "—";

    return (
        <li className="run-item">
            <button
                className="run-item-head"
                onClick={() => setOpen((o) => !o)}
            >
                <RunStatusBadge status={run.status} exitCode={run.exitCode} />
                <span className="run-item-when">{when}</span>
                <code className="run-item-target">{run.container}</code>
                <span className="run-item-dur muted">{duration}</span>
                <span className="run-item-chevron">{open ? "▾" : "▸"}</span>
            </button>
            {open && (
                <div className="run-item-body">
                    <code className="run-item-cmd">{run.command}</code>
                    <OutputView lines={run.output} />
                </div>
            )}
        </li>
    );
}
