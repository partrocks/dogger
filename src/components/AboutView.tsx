import { useEffect, useState } from "react";
import { ArrowLeftIcon } from "@heroicons/react/24/outline";
import { getVersion } from "@tauri-apps/api/app";
import { DoggerMark } from "./DoggerMark";

// Full-screen About panel rendered into the app's main area (matching the
// Settings screen), reachable from the sidebar footer or the tray's "About
// Dogger" item. The app version is read from the bundle so it always matches
// the shipped build.
export function AboutView({ onClose }: { onClose: () => void }) {
    const [version, setVersion] = useState<string | null>(null);

    useEffect(() => {
        let alive = true;
        getVersion()
            .then((v) => alive && setVersion(v))
            .catch(() => alive && setVersion(null));
        return () => {
            alive = false;
        };
    }, []);

    return (
        <div className="project-view">
            <div className="breadcrumb">
                <button className="link-button" onClick={onClose}>
                    <ArrowLeftIcon className="ic-sm" /> Back
                </button>
            </div>

            <div className="about">
                <DoggerMark className="about-logo" />
                <h2 className="about-name">Dogger</h2>
                <p className="about-tagline">Your Development Docker Dog</p>
                {version && (
                    <p className="about-version">Version {version}</p>
                )}

                <div className="about-meta">
                    <p className="about-product">
                        Dogger is a PartRocks product from Happy Coder.
                    </p>
                    <p className="about-author">
                        Made by Paul Rooney ·{" "}
                        <a href="mailto:paul@happycoder.co.uk">
                            paul@happycoder.co.uk
                        </a>
                    </p>
                </div>

                <p className="about-copyright">
                    &copy; 2026 PartRocks, Happy Coder. All rights reserved.
                </p>
            </div>
        </div>
    );
}
