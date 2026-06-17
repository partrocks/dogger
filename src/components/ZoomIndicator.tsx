import { useEffect, useState } from "react";
import type { Zoom } from "../useZoom";

// A subtle pill that briefly appears in the top-center while the user changes
// the UI scale. It lives inside the zoomed document, so we counter-scale it
// with an inverse `zoom` to keep it a constant, readable size at any level.
const VISIBLE_MS = 1100;

export function ZoomIndicator({ percent, pulse }: Zoom) {
    const [visible, setVisible] = useState(false);

    useEffect(() => {
        if (pulse === 0) return; // Don't flash on initial load.
        setVisible(true);
        const handle = setTimeout(() => setVisible(false), VISIBLE_MS);
        return () => clearTimeout(handle);
    }, [pulse]);

    return (
        <div
            className={"zoom-indicator" + (visible ? " is-visible" : "")}
            style={{ zoom: 100 / percent }}
            aria-hidden={!visible}
        >
            {percent}%
        </div>
    );
}
