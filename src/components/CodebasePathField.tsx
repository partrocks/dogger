import { open as openDialog } from "@tauri-apps/plugin-dialog";

// Codebase path input paired with a native folder picker (Tauri dialog
// plugin). The path stays editable by hand; "Browse…" just fills it in.
export function CodebasePathField({
    label,
    value,
    onChange,
}: {
    label: string;
    value: string;
    onChange: (value: string) => void;
}) {
    async function browse() {
        const selected = await openDialog({
            directory: true,
            multiple: false,
            title: "Select codebase folder",
            defaultPath: value || undefined,
        });
        if (typeof selected === "string") onChange(selected);
    }

    return (
        <label className="field">
            <span className="field-label">{label}</span>
            <div className="path-input">
                <input
                    value={value}
                    placeholder="/Users/you/code/my-project"
                    onChange={(e) => onChange(e.target.value)}
                />
                <button type="button" className="ghost-button" onClick={browse}>
                    Browse…
                </button>
            </div>
        </label>
    );
}
