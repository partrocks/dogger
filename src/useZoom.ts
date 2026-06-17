import { useCallback, useEffect, useState } from "react";

// App-wide UI scaling. We apply the CSS `zoom` property to the document root so
// that *everything* (fonts, padding, icons, fixed px sizes) scales together,
// matching the Cmd+/Cmd- behaviour people expect from browsers and editors.
//
// The level is clamped to 40%–200% in 10% steps and persisted across launches.

const MIN_PERCENT = 40;
const MAX_PERCENT = 200;
const STEP_PERCENT = 10;
const DEFAULT_PERCENT = 100;
const STORAGE_KEY = "dogger.zoom";

function clamp(percent: number): number {
    return Math.min(MAX_PERCENT, Math.max(MIN_PERCENT, percent));
}

function snap(percent: number): number {
    return clamp(Math.round(percent / STEP_PERCENT) * STEP_PERCENT);
}

function loadInitial(): number {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw == null) return DEFAULT_PERCENT;
        const n = parseInt(raw, 10);
        return Number.isFinite(n) ? snap(n) : DEFAULT_PERCENT;
    } catch {
        return DEFAULT_PERCENT;
    }
}

export interface Zoom {
    /** Current scale as a whole-number percentage (40–200). */
    percent: number;
    /** Increments on every user-initiated change, even when clamped at a
     *  limit, so the indicator can re-show without the value changing. */
    pulse: number;
}

export function useZoom(): Zoom {
    const [percent, setPercent] = useState<number>(loadInitial);
    const [pulse, setPulse] = useState(0);

    useEffect(() => {
        document.documentElement.style.zoom = String(percent / 100);
        try {
            localStorage.setItem(STORAGE_KEY, String(percent));
        } catch {
            // Ignore storage failures; zoom still applies for this session.
        }
    }, [percent]);

    const step = useCallback((direction: 1 | -1) => {
        setPercent((p) => clamp(p + direction * STEP_PERCENT));
        setPulse((n) => n + 1);
    }, []);

    const reset = useCallback(() => {
        setPercent(DEFAULT_PERCENT);
        setPulse((n) => n + 1);
    }, []);

    useEffect(() => {
        function onKeyDown(e: KeyboardEvent) {
            // Cmd on macOS, Ctrl elsewhere.
            if (!(e.metaKey || e.ctrlKey) || e.altKey) return;

            switch (e.code) {
                case "Equal": // Cmd+= and Cmd+Shift+= (i.e. Cmd +)
                case "NumpadAdd":
                    e.preventDefault();
                    step(1);
                    break;
                case "Minus":
                case "NumpadSubtract":
                    e.preventDefault();
                    step(-1);
                    break;
                case "Digit0":
                case "Numpad0":
                    e.preventDefault();
                    reset();
                    break;
            }
        }
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [step, reset]);

    return { percent, pulse };
}
