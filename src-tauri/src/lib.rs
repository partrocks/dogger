// Tauri command surface for Dogger. All disk access lives in `storage`, which
// keeps every byte Dogger manages under `~/.dogger` (never inside a project's
// own codebase — see context/rules.md).

mod ai;
mod docker;
mod storage;
mod tray;

use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use tauri::{LogicalPosition, LogicalSize, Manager, WebviewWindow, Window, WindowEvent};
use tauri_plugin_autostart::ManagerExt;

use docker::{DockerStatus, RunningContainer, ShellInfo};
use storage::{Project, RunRecord, Settings, Task, WindowState};
use tray::TrayProject;

#[tauri::command]
fn list_projects() -> Result<Vec<Project>, String> {
    storage::list_projects()
}

#[tauri::command]
fn create_project(
    name: String,
    codebase_path: String,
    container_working_dir: String,
    container: String,
) -> Result<Project, String> {
    storage::create_project(&name, &codebase_path, &container_working_dir, &container)
}

#[tauri::command]
fn update_project(
    id: String,
    name: String,
    codebase_path: String,
    container_working_dir: String,
    container: String,
) -> Result<Project, String> {
    storage::update_project(
        &id,
        &name,
        &codebase_path,
        &container_working_dir,
        &container,
    )
}

#[tauri::command]
fn delete_project(id: String) -> Result<(), String> {
    storage::delete_project(&id)
}

#[tauri::command]
fn create_task(
    project_id: String,
    name: String,
    description: Option<String>,
) -> Result<Task, String> {
    storage::create_task(&project_id, &name, description.as_deref())
}

#[tauri::command]
fn update_task(
    project_id: String,
    task_id: String,
    name: String,
    description: Option<String>,
) -> Result<Task, String> {
    storage::update_task(&project_id, &task_id, &name, description.as_deref())
}

#[tauri::command]
fn delete_task(project_id: String, task_id: String) -> Result<(), String> {
    storage::delete_task(&project_id, &task_id)
}

#[tauri::command]
fn list_task_files(project_id: String, task_id: String) -> Result<Vec<String>, String> {
    storage::list_task_files(&project_id, &task_id)
}

#[tauri::command]
fn read_task_file(project_id: String, task_id: String, file: String) -> Result<String, String> {
    storage::read_task_file(&project_id, &task_id, &file)
}

#[tauri::command]
fn write_task_file(
    project_id: String,
    task_id: String,
    file: String,
    contents: String,
) -> Result<(), String> {
    storage::write_task_file(&project_id, &task_id, &file, &contents)
}

#[tauri::command]
fn docker_status() -> DockerStatus {
    docker::docker_status()
}

#[tauri::command]
fn list_running_containers() -> Result<Vec<RunningContainer>, String> {
    docker::list_running_containers()
}

#[tauri::command]
fn check_container_path(container: String, path: String) -> Result<bool, String> {
    docker::check_path(&container, &path)
}

#[tauri::command]
fn detect_container_shell(
    project_id: String,
    task_id: String,
    container: String,
) -> Result<ShellInfo, String> {
    docker::detect_container_shell(&project_id, &task_id, &container)
}

#[tauri::command]
fn list_runs(project_id: String, task_id: String) -> Result<Vec<RunRecord>, String> {
    storage::list_runs(&project_id, &task_id)
}

#[tauri::command]
fn run_task(
    app: tauri::AppHandle,
    project_id: String,
    task_id: String,
    container: String,
    run_id: String,
) -> Result<RunRecord, String> {
    docker::run_task(app, &project_id, &task_id, &container, &run_id)
}

/// Start an AI task generation. Validates configuration up front (returning a
/// clear error for the UI), then streams progress via the `ai-*` events; see
/// `ai::generate_task`.
#[tauri::command]
fn generate_task(
    app: tauri::AppHandle,
    project_id: String,
    task_id: String,
    gen_id: String,
    model: String,
    prompt: String,
    history: Vec<ai::AiMessage>,
) -> Result<(), String> {
    ai::generate_task(
        app,
        &project_id,
        &task_id,
        &gen_id,
        &model,
        &prompt,
        history,
    )
}

/// Request cancellation of an in-flight AI generation. A no-op if the
/// generation already finished. The running agent loop stops at its next
/// checkpoint and emits an `ai-finished` event with `status: "cancelled"`.
#[tauri::command]
fn cancel_generation(gen_id: String) {
    ai::cancel_generation(&gen_id);
}

/// Transcribe a short dictation clip recorded in the webview to text via
/// OpenAI. The API token stays in Rust; see `ai::transcribe_audio`.
#[tauri::command]
fn transcribe_audio(audio_base64: String, mime_type: String) -> Result<String, String> {
    ai::transcribe_audio(&audio_base64, &mime_type)
}

/// Refresh the tray's "online projects" submenu. Called by the frontend (the
/// single Docker poller) whenever the set of online projects/tasks changes.
#[tauri::command]
fn set_tray_menu(app: tauri::AppHandle, projects: Vec<TrayProject>) -> Result<(), String> {
    tray::update(&app, projects)
}

// ---- Menu bar popover actions ----------------------------------------------
// These back the rich popover panel (`?view=tray`), reusing the exact same
// handlers as the native tray menu so both stay behaviourally identical.

/// Show/hide the main window (the popover's "Show / Hide Dashboard" action).
#[tauri::command]
fn tray_show_hide(app: tauri::AppHandle) {
    tray::toggle_main_window(&app);
}

/// Bring the main window forward on the Settings screen.
#[tauri::command]
fn tray_open_settings(app: tauri::AppHandle) {
    tray::open_settings(&app);
}

/// Bring the main window forward on the About screen.
#[tauri::command]
fn tray_open_about(app: tauri::AppHandle) {
    tray::open_about(&app);
}

/// Open (or focus) the runner window for a task, matching the native menu.
#[tauri::command]
fn tray_run_task(app: tauri::AppHandle, project_id: String, task_id: String) -> Result<(), String> {
    tray::open_runner_window(&app, &project_id, &task_id).map_err(|e| e.to_string())
}

/// Quit Dogger entirely.
#[tauri::command]
fn tray_quit(app: tauri::AppHandle) {
    app.exit(0);
}

/// Dismiss the popover panel (called after a panel action).
#[tauri::command]
fn tray_hide_panel(app: tauri::AppHandle) {
    tray::hide_panel(&app);
}

/// Read the persisted user settings for the Settings screen.
#[tauri::command]
fn get_settings() -> Result<Settings, String> {
    storage::load_settings()
}

/// Persist user settings. The "launch in the background" preference only takes
/// effect on the next launch (it decides whether the dashboard is shown or
/// stays hidden in the tray), but "launch on startup" is applied live here by
/// registering/unregistering Dogger as a macOS login item.
#[tauri::command]
fn save_settings(app: tauri::AppHandle, settings: Settings) -> Result<(), String> {
    apply_launch_on_startup(&app, settings.launch_on_startup);
    storage::save_settings(settings)
}

/// Reconcile the OS login item with the desired "launch on startup" state.
/// Best-effort: the setting is still the source of truth in `config.json`, so a
/// transient failure to toggle the login item doesn't fail the save.
fn apply_launch_on_startup<R: tauri::Runtime>(app: &tauri::AppHandle<R>, enabled: bool) {
    let manager = app.autolaunch();
    let result = if enabled {
        manager.enable()
    } else {
        manager.disable()
    };
    if let Err(e) = result {
        eprintln!("dogger: failed to update launch-on-startup login item: {e}");
    }
}

/// Apply the last persisted window geometry to the main window on startup.
/// Best-effort: a missing/corrupt config just leaves the `tauri.conf.json`
/// defaults in place.
fn restore_window_state(window: &WebviewWindow) {
    if let Ok(Some(state)) = storage::load_window_state() {
        let _ = window.set_size(LogicalSize::new(state.width, state.height));
        let _ = window.set_position(LogicalPosition::new(state.x, state.y));
    }
}

/// Persist the main window's current geometry to `~/.dogger/config.json`.
///
/// macOS fires a flood of `Moved`/`Resized` events while dragging, so non-forced
/// saves are throttled; `force` (used on close) bypasses it to capture the final
/// resting geometry. Geometry is stored in logical units for DPI independence.
fn persist_window_state(window: &Window, force: bool) {
    static LAST_SAVE: OnceLock<Mutex<Instant>> = OnceLock::new();
    let throttle = LAST_SAVE.get_or_init(|| Mutex::new(Instant::now() - Duration::from_secs(1)));
    if !force {
        if let Ok(mut last) = throttle.lock() {
            if last.elapsed() < Duration::from_millis(400) {
                return;
            }
            *last = Instant::now();
        }
    }

    let scale = window.scale_factor().unwrap_or(1.0);
    let (Ok(position), Ok(size)) = (window.outer_position(), window.inner_size()) else {
        return;
    };
    let position = position.to_logical::<f64>(scale);
    let size = size.to_logical::<f64>(scale);
    let _ = storage::save_window_state(WindowState {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .setup(|app| {
            let settings = storage::load_settings().unwrap_or_default();
            // Keep the OS login item in sync with the persisted preference in
            // case it was changed outside Dogger (e.g. System Settings).
            apply_launch_on_startup(app.handle(), settings.launch_on_startup);
            // The main window is configured `visible: false` so we can decide
            // here whether to reveal it or leave Dogger running quietly in the
            // tray, based on the user's "launch in the background" preference.
            if let Some(window) = app.get_webview_window("main") {
                restore_window_state(&window);
                if !settings.launch_in_background {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            tray::init(app.handle())?;
            Ok(())
        })
        .on_window_event(|window, event| match event {
            WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
                if window.label() == "main" {
                    persist_window_state(window, false);
                }
            }
            // The main window lives behind the tray icon: closing it hides it
            // (so "Show / Hide Dashboard" can bring it back) rather than quitting.
            // Use the tray's "Quit Dogger" to actually exit. Runner windows
            // close normally.
            WindowEvent::CloseRequested { api, .. } => {
                if window.label() == "main" {
                    persist_window_state(window, true);
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
            // The menu bar popover dismisses itself when it loses focus (click
            // elsewhere, or a re-click on the tray icon). Note the time so a
            // dismissing icon click doesn't immediately reopen it.
            WindowEvent::Focused(false) => {
                if window.label() == "tray" {
                    tray::note_panel_hidden(window.app_handle());
                    let _ = window.hide();
                }
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            list_projects,
            create_project,
            update_project,
            delete_project,
            create_task,
            update_task,
            delete_task,
            list_task_files,
            read_task_file,
            write_task_file,
            docker_status,
            list_running_containers,
            check_container_path,
            detect_container_shell,
            list_runs,
            run_task,
            generate_task,
            cancel_generation,
            transcribe_audio,
            set_tray_menu,
            tray_show_hide,
            tray_open_settings,
            tray_open_about,
            tray_run_task,
            tray_quit,
            tray_hide_panel,
            get_settings,
            save_settings,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
