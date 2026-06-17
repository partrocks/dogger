import { PlayIcon } from "@heroicons/react/24/solid";
import type { Task } from "../types";

export function TaskRow({
    task,
    container,
    containerRunning,
    dockerReady,
    onOpen,
    onRun,
}: {
    task: Task;
    container: string;
    containerRunning: boolean;
    dockerReady: boolean;
    onOpen: () => void;
    onRun: (container: string) => void;
}) {
    const disabled = !dockerReady || !container || !containerRunning;
    const title = !dockerReady
        ? "Docker is unavailable"
        : !container
          ? "No container configured for this project"
          : !containerRunning
            ? `Container ${container} is not running`
            : `Run in ${container}`;

    return (
        <li className="task-row">
            <button className="task-info task-info--button" onClick={onOpen}>
                <span className="task-name">{task.name}</span>
                <code className="task-entry">{task.dir}/main.sh</code>
                {task.description && (
                    <span className="task-desc">{task.description}</span>
                )}
            </button>
            <div className="task-run-controls">
                <button
                    className="run-button"
                    disabled={disabled}
                    title={title}
                    onClick={() => onRun(container)}
                >
                    <PlayIcon className="ic" />
                    Run
                </button>
            </div>
        </li>
    );
}
