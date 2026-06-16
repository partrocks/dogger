// Tauri command surface for Dogger. All disk access lives in `storage`, which
// keeps every byte Dogger manages under `~/.dogger` (never inside a project's
// own codebase — see context/rules.md).

mod storage;

use storage::{DockerContainer, Project, Task};

#[tauri::command]
fn list_projects() -> Result<Vec<Project>, String> {
    storage::list_projects()
}

#[tauri::command]
fn create_project(
    name: String,
    codebase_path: String,
    container_working_dir: String,
) -> Result<Project, String> {
    storage::create_project(&name, &codebase_path, &container_working_dir)
}

#[tauri::command]
fn update_project(
    id: String,
    name: String,
    codebase_path: String,
    container_working_dir: String,
    containers: Vec<DockerContainer>,
) -> Result<Project, String> {
    storage::update_project(
        &id,
        &name,
        &codebase_path,
        &container_working_dir,
        containers,
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            list_projects,
            create_project,
            update_project,
            delete_project,
            create_task,
            delete_task,
            list_task_files,
            read_task_file,
            write_task_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
