import type { MouseEvent } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

export function Titlebar() {
    const appWindow = getCurrentWindow();

    // `data-tauri-drag-region` alone is unreliable in the Tauri v2 webview, so we
    // also start the native drag explicitly on mousedown. We ignore the press
    // when it lands on an interactive control (the traffic-light buttons).
    function handleDragMouseDown(e: MouseEvent<HTMLDivElement>) {
        if (e.button !== 0) return;
        if ((e.target as HTMLElement).closest("button")) return;
        void appWindow.startDragging();
    }

    return (
        <div
            className="titlebar"
            data-tauri-drag-region
            onMouseDown={handleDragMouseDown}
            onDoubleClick={() => void appWindow.toggleMaximize()}
        >
            <div className="window-controls">
                <button
                    className="win-btn win-close"
                    aria-label="Close"
                    onClick={() => appWindow.close()}
                />
                <button
                    className="win-btn win-min"
                    aria-label="Minimize"
                    onClick={() => appWindow.minimize()}
                />
                <button
                    className="win-btn win-max"
                    aria-label="Toggle maximize"
                    onClick={() => appWindow.toggleMaximize()}
                />
            </div>
        </div>
    );
}
