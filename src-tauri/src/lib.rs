// Tauri command surface for Dogger. All disk access lives in `storage`, which
// keeps every byte Dogger manages under `~/.dogger` (never inside a project's
// own codebase — see context/rules.md).

mod docker;
mod storage;
mod tray;

use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use tauri::{LogicalPosition, LogicalSize, Manager, WebviewWindow, Window, WindowEvent};

use docker::{DockerStatus, RunningContainer, ShellInfo};
use storage::{Project, RunRecord, Task, WindowState};
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

/// Refresh the tray's "online projects" submenu. Called by the frontend (the
/// single Docker poller) whenever the set of online projects/tasks changes.
#[tauri::command]
fn set_tray_menu(app: tauri::AppHandle, projects: Vec<TrayProject>) -> Result<(), String> {
    tray::update(&app, projects)
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
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                restore_window_state(&window);
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
            // (so "Show / Hide Dogger" can bring it back) rather than quitting.
            // Use the tray's "Quit Dogger" to actually exit. Runner windows
            // close normally.
            WindowEvent::CloseRequested { api, .. } => {
                if window.label() == "main" {
                    persist_window_state(window, true);
                    api.prevent_close();
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
            set_tray_menu,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
