//! macOS menu bar (system tray) integration for Dogger.
//!
//! The tray lives alongside the full window app — it does not replace it. Its
//! context menu gives quick access to running tasks without opening the main
//! window:
//!
//! ```text
//! About Dogger
//! ─────────────
//! <Online project>        ▸  <task>  (opens a small runner window)
//!                            <task>
//! ─────────────
//! Show / Hide Dogger
//! Quit Dogger
//! ```
//!
//! The "Online project list" is driven from the frontend: it already polls
//! `docker ps`, so rather than poll a second time from Rust it pushes the set of
//! online projects (and their tasks) to [`update`] via the `set_tray_menu`
//! command whenever that set changes. This keeps a single source of truth and a
//! single Docker poller.

use serde::Deserialize;
use tauri::menu::{
    AboutMetadataBuilder, MenuBuilder, MenuItem, PredefinedMenuItem, SubmenuBuilder,
};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindowBuilder};

/// Stable id of the single tray icon, used to look it up for menu updates.
const TRAY_ID: &str = "dogger-tray";

/// Menu item id prefix for "run this task" entries: `run::<project>::<task>`.
const RUN_PREFIX: &str = "run::";

/// A task as surfaced in the tray menu (a subset of the full `Task`).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrayTask {
    pub id: String,
    pub name: String,
}

/// An online project (its container is running) plus its tasks, as pushed from
/// the frontend for the tray menu.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrayProject {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub tasks: Vec<TrayTask>,
}

/// Build the full tray context menu for the given set of online projects.
fn build_menu<R: Runtime>(
    app: &AppHandle<R>,
    projects: &[TrayProject],
) -> tauri::Result<tauri::menu::Menu<R>> {
    let about = PredefinedMenuItem::about(
        app,
        Some("About Dogger"),
        Some(
            AboutMetadataBuilder::new()
                .name(Some("Dogger"))
                .version(Some(env!("CARGO_PKG_VERSION")))
                .comments(Some("Run containerised project tasks."))
                .build(),
        ),
    )?;

    let mut menu = MenuBuilder::new(app).item(&about).separator();

    if projects.is_empty() {
        let none = MenuItem::with_id(app, "no-online", "No online projects", false, None::<&str>)?;
        menu = menu.item(&none);
    } else {
        for project in projects {
            let mut sub = SubmenuBuilder::new(app, &project.name);
            if project.tasks.is_empty() {
                let empty = MenuItem::with_id(
                    app,
                    format!("no-tasks::{}", project.id),
                    "No tasks",
                    false,
                    None::<&str>,
                )?;
                sub = sub.item(&empty);
            } else {
                for task in &project.tasks {
                    let id = format!("{RUN_PREFIX}{}::{}", project.id, task.id);
                    let item = MenuItem::with_id(app, id, &task.name, true, None::<&str>)?;
                    sub = sub.item(&item);
                }
            }
            let submenu = sub.build()?;
            menu = menu.item(&submenu);
        }
    }

    let toggle = MenuItem::with_id(app, "toggle", "Show / Hide Dogger", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Dogger", true, None::<&str>)?;

    menu.separator()
        .item(&toggle)
        .separator()
        .item(&quit)
        .build()
}

/// Create the tray icon during app setup. Starts with an empty project list;
/// the frontend fills it in via [`update`] once it has probed Docker.
pub fn init<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let menu = build_menu(app, &[])?;
    // A monochrome template image (black glyph on transparency) so macOS tints
    // it to match the menu bar like the neighbouring status icons, rather than
    // showing the full colored app icon. Embedded at compile time so it ships
    // in the bundle. `icon_as_template(true)` is what enables the tinting.
    let icon = tauri::include_image!("icons/tray-template.png");
    TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("Dogger")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(on_menu_event)
        .icon(icon)
        .icon_as_template(true)
        .build(app)?;
    Ok(())
}

/// Rebuild and apply the tray menu for the current set of online projects.
/// Menu mutation must happen on the main thread (macOS/GTK requirement), so the
/// work is hopped there.
pub fn update<R: Runtime>(app: &AppHandle<R>, projects: Vec<TrayProject>) -> Result<(), String> {
    let handle = app.clone();
    app.run_on_main_thread(move || {
        if let Some(tray) = handle.tray_by_id(TRAY_ID) {
            if let Ok(menu) = build_menu(&handle, &projects) {
                let _ = tray.set_menu(Some(menu));
            }
        }
    })
    .map_err(|e| e.to_string())
}

/// Route tray menu clicks to their action.
fn on_menu_event<R: Runtime>(app: &AppHandle<R>, event: tauri::menu::MenuEvent) {
    let id = event.id().as_ref();
    match id {
        "toggle" => toggle_main_window(app),
        "quit" => app.exit(0),
        _ if id.starts_with(RUN_PREFIX) => {
            // run::<project_id>::<task_id>
            let rest = &id[RUN_PREFIX.len()..];
            if let Some((project_id, task_id)) = rest.split_once("::") {
                if let Err(e) = open_runner_window(app, project_id, task_id) {
                    eprintln!("dogger: failed to open runner window: {e}");
                }
            }
        }
        _ => {}
    }
}

/// Show the main window if hidden, hide it if visible — backing the menu's
/// "Show / Hide Dogger" entry.
fn toggle_main_window<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    if window.is_visible().unwrap_or(false) {
        let _ = window.hide();
    } else {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Open (or focus, if already open) a small runner window for a single task.
/// The window loads the same frontend bundle with `?view=runner` query params
/// so React renders the dedicated runner UI instead of the full app.
fn open_runner_window<R: Runtime>(
    app: &AppHandle<R>,
    project_id: &str,
    task_id: &str,
) -> tauri::Result<()> {
    let label = format!("runner-{project_id}-{task_id}");

    if let Some(existing) = app.get_webview_window(&label) {
        let _ = existing.show();
        let _ = existing.set_focus();
        return Ok(());
    }

    let url = format!("index.html?view=runner&project={project_id}&task={task_id}");
    WebviewWindowBuilder::new(app, &label, WebviewUrl::App(url.into()))
        .title("Dogger — Run Task")
        .inner_size(560.0, 480.0)
        .min_inner_size(420.0, 320.0)
        .resizable(true)
        .decorations(false)
        .build()?;
    Ok(())
}
