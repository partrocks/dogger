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
//! Settings…                  (opens the full app on the Settings screen)
//! Quit Dogger
//! ```
//!
//! The "Online project list" is driven from the frontend: it already polls
//! `docker ps`, so rather than poll a second time from Rust it pushes the set of
//! online projects (and their tasks) to [`update`] via the `set_tray_menu`
//! command whenever that set changes. This keeps a single source of truth and a
//! single Docker poller.

use std::sync::Mutex;

use serde::Deserialize;
use tauri::menu::{Menu, MenuBuilder, MenuItem, SubmenuBuilder};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, Runtime, WebviewUrl, WebviewWindowBuilder};

/// Event emitted to the main window when "Settings…" is chosen from the tray,
/// telling the frontend to navigate to the Settings screen.
pub const OPEN_SETTINGS_EVENT: &str = "dogger://open-settings";

/// Event emitted to the main window when "About Dogger" is chosen from the
/// tray, telling the frontend to navigate to the in-app About screen.
pub const OPEN_ABOUT_EVENT: &str = "dogger://open-about";

/// Stable id of the single tray icon, used to look it up for menu updates.
const TRAY_ID: &str = "dogger-tray";

/// Menu item id prefix for "run this task" entries: `run::<project>::<task>`.
const RUN_PREFIX: &str = "run::";

/// How many recently-applied tray menus to keep alive. See [`TrayMenuInner`].
const RETAINED_MENU_LIMIT: usize = 16;

/// Per-app tray menu state, kept in Tauri's managed state.
struct TrayMenuState<R: Runtime> {
    inner: Mutex<TrayMenuInner<R>>,
}

struct TrayMenuInner<R: Runtime> {
    /// Signature of the menu currently applied to the tray. The frontend pushes
    /// the online set on every Docker poll (every few seconds), so we compare
    /// against this to skip rebuilding/swapping the menu when nothing changed.
    signature: Option<String>,
    /// Recently-applied menus, retained to dodge a macOS use-after-free.
    ///
    /// `TrayIcon::set_menu` swaps the tray's `NSMenu`, but AppKit keeps the
    /// *currently displayed* `NSMenu` (and its `NSMenuItem`s) alive until it is
    /// dismissed. muda's items hold raw pointers into the Rust-side [`Menu`], so
    /// dropping the old `Menu` while its items are still on screen turns the
    /// next click into a use-after-free that aborts the app
    /// (tauri-apps/muda#328, surfaced by Rust 1.78+ as a `slice::from_raw_parts`
    /// precondition panic). Holding on to a handful of recent menus keeps those
    /// pointers valid until the menu is closed and rebuilt.
    retained: Vec<Menu<R>>,
}

/// A stable, order-sensitive fingerprint of the online set the tray menu is
/// built from, used to detect no-op updates. Control characters separate the
/// fields so ordinary names can't forge a boundary.
fn menu_signature(projects: &[TrayProject]) -> String {
    let mut sig = String::new();
    for project in projects {
        sig.push_str(&project.id);
        sig.push('\u{1f}');
        sig.push_str(&project.name);
        sig.push('\u{1f}');
        for task in &project.tasks {
            sig.push_str(&task.id);
            sig.push('\u{1e}');
            sig.push_str(&task.name);
            sig.push('\u{1e}');
        }
        sig.push('\u{1d}');
    }
    sig
}

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
    // Custom "About" entry (rather than the native macOS about panel) so it can
    // open Dogger's own branded About screen in the main window.
    let about = MenuItem::with_id(app, "about", "About Dogger", true, None::<&str>)?;

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

    let settings = MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?;
    let toggle = MenuItem::with_id(app, "toggle", "Show / Hide Dogger", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Dogger", true, None::<&str>)?;

    menu.separator()
        .item(&toggle)
        .item(&settings)
        .separator()
        .item(&quit)
        .build()
}

/// Create the tray icon during app setup. Starts with an empty project list;
/// the frontend fills it in via [`update`] once it has probed Docker.
pub fn init<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let projects: &[TrayProject] = &[];
    let menu = build_menu(app, projects)?;
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
    app.manage(TrayMenuState {
        inner: Mutex::new(TrayMenuInner {
            signature: Some(menu_signature(projects)),
            retained: vec![menu],
        }),
    });
    Ok(())
}

/// Rebuild and apply the tray menu for the current set of online projects.
/// Menu mutation must happen on the main thread (macOS/GTK requirement), so the
/// work is hopped there.
pub fn update<R: Runtime>(app: &AppHandle<R>, projects: Vec<TrayProject>) -> Result<(), String> {
    let handle = app.clone();
    app.run_on_main_thread(move || apply_menu(&handle, &projects))
        .map_err(|e| e.to_string())
}

/// Apply a new tray menu on the main thread, skipping redundant rebuilds and
/// retaining recent menus so a swap can't free a menu that's still on screen.
fn apply_menu<R: Runtime>(app: &AppHandle<R>, projects: &[TrayProject]) {
    let Some(state) = app.try_state::<TrayMenuState<R>>() else {
        return;
    };
    let Ok(mut inner) = state.inner.lock() else {
        return;
    };

    let signature = menu_signature(projects);
    if inner.signature.as_deref() == Some(signature.as_str()) {
        // Nothing changed since the last apply (the frontend re-pushes on every
        // Docker poll). Leave the live menu untouched so we don't needlessly
        // swap — and risk freeing — an `NSMenu` the user may have open.
        return;
    }

    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return;
    };
    let Ok(menu) = build_menu(app, projects) else {
        return;
    };
    if tray.set_menu(Some(menu.clone())).is_err() {
        return;
    }

    inner.signature = Some(signature);
    inner.retained.push(menu);
    if inner.retained.len() > RETAINED_MENU_LIMIT {
        let excess = inner.retained.len() - RETAINED_MENU_LIMIT;
        inner.retained.drain(..excess);
    }
}

/// Route tray menu clicks to their action.
fn on_menu_event<R: Runtime>(app: &AppHandle<R>, event: tauri::menu::MenuEvent) {
    let id = event.id().as_ref();
    match id {
        "toggle" => toggle_main_window(app),
        "about" => open_about(app),
        "settings" => open_settings(app),
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

/// Bring the main window forward and ask the frontend to switch to the Settings
/// screen. The window may be hidden (closing it only hides it), so show + focus
/// first, then emit the navigation event the React app listens for.
fn open_settings<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let _ = window.show();
    let _ = window.set_focus();
    let _ = window.emit(OPEN_SETTINGS_EVENT, ());
}

/// Bring the main window forward and ask the frontend to switch to the About
/// screen. Mirrors [`open_settings`]: show + focus first (the window may be
/// hidden), then emit the navigation event the React app listens for.
fn open_about<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let _ = window.show();
    let _ = window.set_focus();
    let _ = window.emit(OPEN_ABOUT_EVENT, ());
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
