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
//! Show / Hide Dashboard
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
use std::time::{Duration, Instant};

use serde::Deserialize;
use tauri::menu::{Menu, MenuBuilder, MenuItem, SubmenuBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{
    AppHandle, Emitter, Manager, Monitor, PhysicalPosition, Rect, Runtime, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder,
};

/// Event emitted to the main window when "Settings…" is chosen from the tray,
/// telling the frontend to navigate to the Settings screen.
pub const OPEN_SETTINGS_EVENT: &str = "dogger://open-settings";

/// Event emitted to the main window when "About Dogger" is chosen from the
/// tray, telling the frontend to navigate to the in-app About screen.
pub const OPEN_ABOUT_EVENT: &str = "dogger://open-about";

/// Stable id of the single tray icon, used to look it up for menu updates.
const TRAY_ID: &str = "dogger-tray";

/// Window label of the rich menu bar popover panel shown on left-click. The
/// native [`Menu`] is kept as a right-click fallback.
const PANEL_LABEL: &str = "tray";

/// Logical size of the popover panel.
const PANEL_WIDTH: f64 = 320.0;
const PANEL_HEIGHT: f64 = 460.0;

/// Menu item id prefix for "run this task" entries: `run::<project>::<task>`.
const RUN_PREFIX: &str = "run::";

/// How many recently-applied tray menus to keep alive. See [`TrayMenuInner`].
const RETAINED_MENU_LIMIT: usize = 16;

/// Per-app tray menu state, kept in Tauri's managed state.
struct TrayMenuState<R: Runtime> {
    inner: Mutex<TrayMenuInner<R>>,
}

/// Tracks when the popover was last hidden so a click on the tray icon that
/// *dismisses* an open panel isn't immediately treated as a request to reopen
/// it. Clicking the icon while the panel is key first makes the panel resign
/// key (blur → hide); the click event arrives just after, and without this we'd
/// reopen the panel the user was trying to close.
struct TrayPanelState {
    last_hidden: Mutex<Instant>,
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
    let toggle = MenuItem::with_id(app, "toggle", "Show / Hide Dashboard", true, None::<&str>)?;
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
        // Left-click opens the rich popover panel (handled in `on_tray_icon_event`);
        // the native menu is reserved for right-click as a fallback.
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(on_menu_event)
        .on_tray_icon_event(on_tray_icon_event)
        .icon(icon)
        .icon_as_template(true)
        .build(app)?;
    app.manage(TrayMenuState {
        inner: Mutex::new(TrayMenuInner {
            signature: Some(menu_signature(projects)),
            retained: vec![menu],
        }),
    });
    app.manage(TrayPanelState {
        last_hidden: Mutex::new(Instant::now() - Duration::from_secs(1)),
    });
    // Build the popover up front (hidden) so the first left-click shows it
    // instantly rather than waiting for the webview to load.
    if let Err(e) = build_panel(app) {
        eprintln!("dogger: failed to pre-build tray panel: {e}");
    }
    Ok(())
}

/// Build the (initially hidden) popover panel window. It loads the same bundle
/// as the main app with `?view=tray`, so React renders the dedicated panel UI.
fn build_panel<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<WebviewWindow<R>> {
    WebviewWindowBuilder::new(
        app,
        PANEL_LABEL,
        WebviewUrl::App("index.html?view=tray".into()),
    )
    .title("Dogger")
    .inner_size(PANEL_WIDTH, PANEL_HEIGHT)
    .resizable(false)
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .visible(false)
    .build()
}

/// Handle raw tray icon events. A left-click toggles the popover; right-clicks
/// fall through to the native menu (configured via `show_menu_on_left_click`).
fn on_tray_icon_event<R: Runtime>(tray: &TrayIcon<R>, event: TrayIconEvent) {
    if let TrayIconEvent::Click {
        button: MouseButton::Left,
        button_state: MouseButtonState::Up,
        rect,
        ..
    } = event
    {
        toggle_panel(tray.app_handle(), rect);
    }
}

/// Show the popover anchored under the tray icon, or hide it if already open.
fn toggle_panel<R: Runtime>(app: &AppHandle<R>, rect: Rect) {
    let win = match app.get_webview_window(PANEL_LABEL) {
        Some(w) => w,
        None => match build_panel(app) {
            Ok(w) => w,
            Err(e) => {
                eprintln!("dogger: failed to build tray panel: {e}");
                return;
            }
        },
    };

    if win.is_visible().unwrap_or(false) {
        let _ = win.hide();
        return;
    }
    // The click that dismisses an open panel first blurs (and hides) it; don't
    // reopen it in that case. See `TrayPanelState`.
    if panel_recently_hidden(app) {
        return;
    }

    position_panel(&win, rect);
    let _ = win.show();
    let _ = win.set_focus();
}

/// Position the popover horizontally centred under the tray icon, just below the
/// menu bar, clamped to the monitor that holds the icon.
fn position_panel<R: Runtime>(win: &WebviewWindow<R>, rect: Rect) {
    let scale = win.scale_factor().unwrap_or(1.0);
    let icon_pos = rect.position.to_physical::<f64>(scale);
    let icon_size = rect.size.to_physical::<f64>(scale);
    let panel_w = win
        .outer_size()
        .map(|s| s.width as f64)
        .unwrap_or(PANEL_WIDTH * scale);

    let center_x = icon_pos.x + icon_size.width / 2.0;
    let below = icon_pos.y + icon_size.height + 6.0 * scale;
    let mut x = center_x - panel_w / 2.0;

    if let Some(mon) = monitor_for_point(win, center_x, below) {
        let mp = mon.position();
        let ms = mon.size();
        let margin = 8.0 * scale;
        let min_x = mp.x as f64 + margin;
        let max_x = mp.x as f64 + ms.width as f64 - panel_w - margin;
        if max_x >= min_x {
            x = x.clamp(min_x, max_x);
        }
    }

    let _ = win.set_position(PhysicalPosition::new(x.round() as i32, below.round() as i32));
}

/// Find the monitor whose bounds contain the given physical point, falling back
/// to the primary monitor.
fn monitor_for_point<R: Runtime>(win: &WebviewWindow<R>, x: f64, y: f64) -> Option<Monitor> {
    let monitors = win.available_monitors().ok()?;
    monitors
        .iter()
        .find(|m| {
            let p = m.position();
            let s = m.size();
            let px = p.x as f64;
            let py = p.y as f64;
            x >= px && x < px + s.width as f64 && y >= py && y < py + s.height as f64
        })
        .cloned()
        .or_else(|| win.primary_monitor().ok().flatten())
}

/// Record that the popover was just hidden (called from the blur handler).
pub(crate) fn note_panel_hidden<R: Runtime>(app: &AppHandle<R>) {
    if let Some(state) = app.try_state::<TrayPanelState>() {
        if let Ok(mut t) = state.last_hidden.lock() {
            *t = Instant::now();
        }
    }
}

/// Whether the popover was hidden within the debounce window.
fn panel_recently_hidden<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.try_state::<TrayPanelState>()
        .and_then(|s| {
            s.last_hidden
                .lock()
                .ok()
                .map(|t| t.elapsed() < Duration::from_millis(250))
        })
        .unwrap_or(false)
}

/// Hide the popover panel. Called by the frontend after a panel action so it
/// dismisses promptly (the blur-hide also covers this, but this avoids a race).
pub(crate) fn hide_panel<R: Runtime>(app: &AppHandle<R>) {
    if let Some(win) = app.get_webview_window(PANEL_LABEL) {
        let _ = win.hide();
    }
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
/// "Show / Hide Dashboard" entry.
pub(crate) fn toggle_main_window<R: Runtime>(app: &AppHandle<R>) {
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
pub(crate) fn open_settings<R: Runtime>(app: &AppHandle<R>) {
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
pub(crate) fn open_about<R: Runtime>(app: &AppHandle<R>) {
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
pub(crate) fn open_runner_window<R: Runtime>(
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
