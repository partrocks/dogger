import type { RefObject } from "react";
import type { OutputLine } from "../types";

export function OutputView({
    lines,
    forwardRef,
    live,
}: {
    lines: OutputLine[];
    forwardRef?: RefObject<HTMLDivElement | null>;
    live?: boolean;
}) {
    return (
        <div className="run-output" ref={forwardRef}>
            {lines.length === 0 ? (
                <span className="run-output-empty">
                    {live ? "Waiting for output…" : "No output."}
                </span>
            ) : (
                lines.map((l, i) => (
                    <div
                        key={i}
                        className={
                            "run-line" +
                            (l.stream === "stderr" ? " run-line--err" : "")
                        }
                    >
                        {l.text}
                    </div>
                ))
            )}
        </div>
    );
}
