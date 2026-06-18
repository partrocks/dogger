import { useEffect, useState } from "react";
import {
    ArrowLeftIcon,
    CheckCircleIcon,
    ExclamationTriangleIcon,
    EyeIcon,
    EyeSlashIcon,
    XCircleIcon,
} from "@heroicons/react/24/outline";
import { openUrl } from "@tauri-apps/plugin-opener";
import * as api from "../api";
import type { TokenCheck } from "../api";

// Where users create the API key that goes in the field below.
const OPENAI_KEYS_URL = "https://platform.openai.com/api-keys";

// Full-screen Settings panel rendered into the app's main area (not a modal),
// so it can be reached from the sidebar, the Cmd+, shortcut, or the tray's
// "Settings…" item which opens the full app on this screen. Values live in the
// shared `~/.dogger/config.json` via the Rust `get_settings`/`save_settings`
// commands.
export function SettingsView({ onClose }: { onClose: () => void }) {
    const [launchOnStartup, setLaunchOnStartup] = useState(false);
    const [launchInBackground, setLaunchInBackground] = useState(true);
    const [autoRun, setAutoRun] = useState(false);
    const [openaiToken, setOpenaiToken] = useState("");
    const [showToken, setShowToken] = useState(false);

    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState<string | null>(null);
    const [saved, setSaved] = useState(false);

    // Result of the most recent token check (the "Test" button or a save).
    // Cleared whenever the token field changes, since it'd otherwise be stale.
    const [testing, setTesting] = useState(false);
    const [tokenCheck, setTokenCheck] = useState<TokenCheck | null>(null);

    useEffect(() => {
        let alive = true;
        api.getSettings()
            .then((s) => {
                if (!alive) return;
                setLaunchOnStartup(s.launchOnStartup);
                setLaunchInBackground(s.launchInBackground);
                setAutoRun(s.autoRun);
                setOpenaiToken(s.openaiToken);
            })
            .catch((e) => alive && setErr(String(e)))
            .finally(() => alive && setLoading(false));
        return () => {
            alive = false;
        };
    }, []);

    // Verify the token on demand (the "Test" button). Reflects the outcome
    // inline without saving, so users can confirm a key before committing it.
    async function testToken() {
        const token = openaiToken.trim();
        if (!token || testing) return;
        setTesting(true);
        setErr(null);
        setTokenCheck(null);
        try {
            setTokenCheck(await api.validateOpenaiToken(token));
        } catch (e) {
            setTokenCheck({ valid: false, reachable: false, message: String(e) });
        } finally {
            setTesting(false);
        }
    }

    async function save() {
        setBusy(true);
        setErr(null);
        setSaved(false);

        const token = openaiToken.trim();
        // Soft validation: only block the save when OpenAI *definitively*
        // rejects the key. A network failure (reachable: false) is inconclusive,
        // so we let the save through rather than trapping the user offline.
        if (token) {
            try {
                const check = await api.validateOpenaiToken(token);
                setTokenCheck(check);
                if (check.reachable && !check.valid) {
                    setErr(
                        check.message ??
                            "This OpenAI token was rejected. Check the key and try again.",
                    );
                    setBusy(false);
                    return;
                }
            } catch {
                // Treat an unexpected failure to even run the check as
                // inconclusive and proceed, mirroring the "unreachable" case.
                setTokenCheck(null);
            }
        } else {
            setTokenCheck(null);
        }

        try {
            await api.saveSettings({
                launchOnStartup,
                launchInBackground,
                autoRun,
                openaiToken: token,
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
                                checked={launchOnStartup}
                                onChange={(e) => {
                                    setLaunchOnStartup(e.target.checked);
                                    setSaved(false);
                                }}
                            />
                            <span>
                                <span className="setting-toggle-title">
                                    Launch on startup
                                </span>
                                <span className="setting-toggle-hint">
                                    Open Dogger automatically on startup.
                                </span>
                            </span>
                        </label>

                        <label className="setting-toggle">
                            <input
                                type="checkbox"
                                checked={launchInBackground}
                                onChange={(e) => {
                                    setLaunchInBackground(e.target.checked);
                                    setSaved(false);
                                }}
                            />
                            <span>
                                <span className="setting-toggle-title">
                                    Launch app in background
                                </span>
                                <span className="setting-toggle-hint">
                                    Start Dogger hidden in the menu bar.
                                </span>
                            </span>
                        </label>

                        <label className="setting-toggle">
                            <input
                                type="checkbox"
                                checked={autoRun}
                                onChange={(e) => {
                                    setAutoRun(e.target.checked);
                                    setSaved(false);
                                }}
                            />
                            <span>
                                <span className="setting-toggle-title">
                                    Auto-run tasks from menu bar
                                </span>
                                <span className="setting-toggle-hint">
                                    Run a task automatically when you open it
                                    from the menu bar.
                                </span>
                            </span>
                        </label>

                        <label className="field">
                            <span className="field-label">OpenAI token</span>
                            <div className="token-field">
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
                                            setTokenCheck(null);
                                        }}
                                    />
                                    <button
                                        type="button"
                                        className="icon-button--light"
                                        onClick={() => setShowToken((v) => !v)}
                                        aria-label={
                                            showToken
                                                ? "Hide token"
                                                : "Show token"
                                        }
                                        title={
                                            showToken
                                                ? "Hide token"
                                                : "Show token"
                                        }
                                    >
                                        {showToken ? (
                                            <EyeSlashIcon className="ic" />
                                        ) : (
                                            <EyeIcon className="ic" />
                                        )}
                                    </button>
                                </div>
                                <button
                                    type="button"
                                    className="ghost-button"
                                    onClick={testToken}
                                    disabled={
                                        testing || busy || !openaiToken.trim()
                                    }
                                >
                                    {testing ? "Testing…" : "Test"}
                                </button>
                            </div>
                            {tokenCheck && (
                                <span
                                    className={
                                        "token-check " +
                                        (tokenCheck.valid
                                            ? "token-check--ok"
                                            : tokenCheck.reachable
                                              ? "token-check--error"
                                              : "token-check--warn")
                                    }
                                >
                                    {tokenCheck.valid ? (
                                        <CheckCircleIcon className="ic-sm" />
                                    ) : tokenCheck.reachable ? (
                                        <XCircleIcon className="ic-sm" />
                                    ) : (
                                        <ExclamationTriangleIcon className="ic-sm" />
                                    )}
                                    {tokenCheck.valid
                                        ? "This token works."
                                        : (tokenCheck.message ??
                                          "Couldn't verify this token.")}
                                </span>
                            )}
                            <span className="field-hint">
                                Create a secret key (it starts with{" "}
                                <code>sk-</code>) at{" "}
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
                                , then paste it here.
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
