import { useEffect, useState } from "react";
import {
    ArrowLeftIcon,
    EyeIcon,
    EyeSlashIcon,
} from "@heroicons/react/24/outline";
import { openUrl } from "@tauri-apps/plugin-opener";
import * as api from "../api";

// Where users create the API key that goes in the field below.
const OPENAI_KEYS_URL = "https://platform.openai.com/api-keys";

// Full-screen Settings panel rendered into the app's main area (not a modal),
// so it can be reached from the sidebar, the Cmd+, shortcut, or the tray's
// "Settings…" item which opens the full app on this screen. Values live in the
// shared `~/.dogger/config.json` via the Rust `get_settings`/`save_settings`
// commands.
export function SettingsView({ onClose }: { onClose: () => void }) {
    const [openOnStartup, setOpenOnStartup] = useState(false);
    const [openaiToken, setOpenaiToken] = useState("");
    const [showToken, setShowToken] = useState(false);

    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState<string | null>(null);
    const [saved, setSaved] = useState(false);

    useEffect(() => {
        let alive = true;
        api.getSettings()
            .then((s) => {
                if (!alive) return;
                setOpenOnStartup(s.openOnStartup);
                setOpenaiToken(s.openaiToken);
            })
            .catch((e) => alive && setErr(String(e)))
            .finally(() => alive && setLoading(false));
        return () => {
            alive = false;
        };
    }, []);

    async function save() {
        setBusy(true);
        setErr(null);
        setSaved(false);
        try {
            await api.saveSettings({
                openOnStartup,
                openaiToken: openaiToken.trim(),
            });
            setSaved(true);
        } catch (e) {
            setErr(String(e));
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className="project-view">
            <div className="breadcrumb">
                <button className="link-button" onClick={onClose}>
                    <ArrowLeftIcon className="ic-sm" /> Back
                </button>
            </div>

            <div className="section-head">
                <h2>Settings</h2>
            </div>

            {err && <div className="banner banner--error">{err}</div>}

            {loading ? (
                <p className="muted">Loading…</p>
            ) : (
                <>
                    <div className="form-grid">
                        <label className="setting-toggle">
                            <input
                                type="checkbox"
                                checked={openOnStartup}
                                onChange={(e) => {
                                    setOpenOnStartup(e.target.checked);
                                    setSaved(false);
                                }}
                            />
                            <span>
                                <span className="setting-toggle-title">
                                    Open on startup
                                </span>
                                <span className="setting-toggle-hint">
                                    Show the main window when Dogger launches.
                                    When off, Dogger starts hidden in the menu
                                    bar.
                                </span>
                            </span>
                        </label>

                        <label className="field">
                            <span className="field-label">OpenAI token</span>
                            <div className="path-input">
                                <input
                                    type={showToken ? "text" : "password"}
                                    value={openaiToken}
                                    placeholder="sk-…"
                                    autoComplete="off"
                                    spellCheck={false}
                                    onChange={(e) => {
                                        setOpenaiToken(e.target.value);
                                        setSaved(false);
                                    }}
                                />
                                <button
                                    type="button"
                                    className="icon-button--light"
                                    onClick={() => setShowToken((v) => !v)}
                                    aria-label={
                                        showToken ? "Hide token" : "Show token"
                                    }
                                    title={
                                        showToken ? "Hide token" : "Show token"
                                    }
                                >
                                    {showToken ? (
                                        <EyeSlashIcon className="ic" />
                                    ) : (
                                        <EyeIcon className="ic" />
                                    )}
                                </button>
                            </div>
                            <span className="field-hint">
                                Used by the task Generate tab. Create a secret
                                key (it starts with <code>sk-</code>) at{" "}
                                <button
                                    type="button"
                                    className="link-button"
                                    onClick={() =>
                                        void openUrl(OPENAI_KEYS_URL).catch(
                                            () => {},
                                        )
                                    }
                                >
                                    platform.openai.com/api-keys
                                </button>
                                , then paste it here. Your key is stored locally
                                in <code>~/.dogger/config.json</code> and is only
                                sent to OpenAI.
                            </span>
                        </label>
                    </div>

                    <div className="form-actions">
                        {saved && !busy && (
                            <span className="settings-saved">Saved</span>
                        )}
                        <button
                            className="primary-button"
                            onClick={save}
                            disabled={busy}
                        >
                            {busy ? "Saving…" : "Save changes"}
                        </button>
                    </div>
                </>
            )}
        </div>
    );
}
