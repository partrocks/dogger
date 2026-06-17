import { DoggerMark } from "./DoggerMark";

export function EmptyState({ onNew }: { onNew: () => void }) {
    return (
        <div className="empty-state">
            <div className="empty-inner">
                <DoggerMark className="empty-mark" />
                <p>No project selected.</p>
                <button className="primary-button" onClick={onNew}>
                    New project
                </button>
            </div>
        </div>
    );
}
