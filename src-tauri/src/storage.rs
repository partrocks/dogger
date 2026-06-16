//! On-disk persistence for Dogger's managed state.
//!
//! Everything Dogger owns lives under `~/.dogger` (see `context/rules.md` and
//! `context/decisions.md`). A project's *own* codebase is never written to —
//! all project metadata, task definitions and `main.sh` scripts live here.
//!
//! Layout:
//! ```text
//! ~/.dogger/
//!   config.json             # top-level app config (window position/size)
//!   <project-id>/
//!     project.json          # name, codebase path, container config
//!     tasks/
//!       <task-id>/
//!         task.json         # task metadata (name, description)
//!         main.sh           # required entrypoint
//!         ...               # supporting resources
//! ```

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// A legacy multi-container entry. Projects now attach to a single container
/// (see `ProjectFile::container`); this type is kept only so older
/// `project.json` files that still carry a `containers` array can be read and
/// migrated. It is never written back out.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyContainer {
    #[serde(default)]
    pub reference: String,
}

/// The persisted shape of `project.json`. The project id is the directory name
/// (not stored in the file) and `tasks` are derived from the `tasks/` folder.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFile {
    pub name: String,
    #[serde(default)]
    pub codebase_path: String,
    #[serde(default)]
    pub container_working_dir: String,
    /// Reference (name/id/image) of the single container tasks run in. Empty
    /// when the project has no container configured yet.
    #[serde(default)]
    pub container: String,
    /// Legacy multi-container config. Read for migration only; `skip_serializing`
    /// keeps it out of any file Dogger writes.
    #[serde(default, skip_serializing)]
    pub containers: Vec<LegacyContainer>,
}

/// Dogger's top-level app config, persisted at `~/.dogger/config.json`. This is
/// Dogger's own memory (window geometry today, room for more later), kept
/// separate from any individual project. Unknown fields are ignored on read so
/// the file can grow without breaking older builds.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    /// Last known main-window geometry, restored on startup.
    #[serde(default)]
    pub window: Option<WindowState>,
}

/// Persisted main-window geometry, in *logical* (DPI-independent) units so the
/// numbers match `tauri.conf.json` and round-trip across scale factors.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowState {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// The persisted shape of `task.json`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskFile {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
}

/// A single line of captured output from a task run.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputLine {
    /// `"stdout"` or `"stderr"`.
    pub stream: String,
    pub text: String,
}

/// A persisted record of a single task run. Stored as JSON under a hidden
/// `.runs/` directory inside the task folder so it never appears in the task's
/// editable file list. `started_at`/`finished_at` are epoch milliseconds.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunRecord {
    pub id: String,
    /// Container reference (name or id) the run targeted.
    pub container: String,
    /// The command Dogger executed inside the container (for transparency).
    pub command: String,
    pub started_at: i64,
    #[serde(default)]
    pub finished_at: Option<i64>,
    #[serde(default)]
    pub exit_code: Option<i32>,
    /// `"running" | "success" | "failed" | "error"`.
    pub status: String,
    #[serde(default)]
    pub output: Vec<OutputLine>,
}

/// A task as surfaced to the UI. `dir` equals `id` (the task's folder name).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub name: String,
    pub dir: String,
    pub description: Option<String>,
}

/// A fully-assembled project as surfaced to the UI.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    /// Absolute path of the Dogger-managed dir for this project (`~/.dogger/<id>`).
    pub project_dir: String,
    /// Absolute path of the project's own (read-only) codebase, if configured.
    pub codebase_path: String,
    pub container_working_dir: String,
    /// Reference of the container this project runs tasks in (empty if unset).
    pub container: String,
    pub tasks: Vec<Task>,
}

type Result<T> = std::result::Result<T, String>;

fn map_err<E: std::fmt::Display>(ctx: &str) -> impl FnOnce(E) -> String + '_ {
    move |e| format!("{ctx}: {e}")
}

/// Absolute path to the Dogger home (`~/.dogger`), creating it (and seeding
/// example projects) on first use.
pub fn dogger_home() -> Result<PathBuf> {
    let home = dirs::home_dir().ok_or_else(|| "could not determine home directory".to_string())?;
    let root = home.join(".dogger");
    if !root.exists() {
        fs::create_dir_all(&root).map_err(map_err("create ~/.dogger"))?;
        seed_examples(&root);
    }
    Ok(root)
}

/// Absolute path to Dogger's top-level config file (`~/.dogger/config.json`).
fn config_path() -> Result<PathBuf> {
    Ok(dogger_home()?.join("config.json"))
}

/// Read the top-level app config, returning defaults if the file is absent.
/// A malformed file surfaces as an error so callers can decide how to recover
/// (startup simply ignores it rather than refusing to launch).
pub fn load_app_config() -> Result<AppConfig> {
    let path = config_path()?;
    if !path.exists() {
        return Ok(AppConfig::default());
    }
    read_json(&path)
}

/// The last persisted main-window geometry, if any.
pub fn load_window_state() -> Result<Option<WindowState>> {
    Ok(load_app_config().unwrap_or_default().window)
}

/// Persist the main-window geometry, preserving any other config fields.
pub fn save_window_state(state: WindowState) -> Result<()> {
    let mut config = load_app_config().unwrap_or_default();
    config.window = Some(state);
    write_json(&config_path()?, &config)
}

fn project_dir(id: &str) -> Result<PathBuf> {
    Ok(dogger_home()?.join(sanitize_component(id)?))
}

fn tasks_dir(project_id: &str) -> Result<PathBuf> {
    Ok(project_dir(project_id)?.join("tasks"))
}

pub fn task_dir(project_id: &str, task_id: &str) -> Result<PathBuf> {
    Ok(tasks_dir(project_id)?.join(sanitize_component(task_id)?))
}

fn runs_dir(project_id: &str, task_id: &str) -> Result<PathBuf> {
    Ok(task_dir(project_id, task_id)?.join(".runs"))
}

/// Turn a human name into a filesystem-safe slug for use as a directory id.
fn slugify(name: &str) -> String {
    let mut slug = String::new();
    let mut prev_dash = false;
    for ch in name.trim().to_lowercase().chars() {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch);
            prev_dash = false;
        } else if !prev_dash {
            slug.push('-');
            prev_dash = true;
        }
    }
    let slug = slug.trim_matches('-').to_string();
    if slug.is_empty() {
        "untitled".to_string()
    } else {
        slug
    }
}

/// Reject anything that is not a single, safe path component (guards against
/// path traversal from ids/filenames supplied by the frontend).
fn sanitize_component(component: &str) -> Result<String> {
    let trimmed = component.trim();
    if trimmed.is_empty()
        || trimmed == "."
        || trimmed == ".."
        || trimmed.contains('/')
        || trimmed.contains('\\')
        || trimmed.contains('\0')
    {
        return Err(format!("invalid name: {component:?}"));
    }
    Ok(trimmed.to_string())
}

/// Pick a unique id within `parent` based on `base`, appending `-2`, `-3`, ... .
fn unique_id(parent: &Path, base: &str) -> String {
    let mut candidate = base.to_string();
    let mut n = 2;
    while parent.join(&candidate).exists() {
        candidate = format!("{base}-{n}");
        n += 1;
    }
    candidate
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<T> {
    let raw = fs::read_to_string(path).map_err(map_err("read file"))?;
    serde_json::from_str(&raw).map_err(map_err("parse JSON"))
}

fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    let raw = serde_json::to_string_pretty(value).map_err(map_err("serialize JSON"))?;
    fs::write(path, raw).map_err(map_err("write file"))
}

// ---- Public API used by the Tauri commands ----------------------------------

pub fn list_projects() -> Result<Vec<Project>> {
    let root = dogger_home()?;
    let mut projects = Vec::new();
    for entry in fs::read_dir(&root).map_err(map_err("read ~/.dogger"))? {
        let entry = entry.map_err(map_err("read dir entry"))?;
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let id = entry.file_name().to_string_lossy().to_string();
        if id.starts_with('.') {
            continue;
        }
        if entry.path().join("project.json").exists() {
            projects.push(load_project(&id)?);
        }
    }
    projects.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(projects)
}

pub fn load_project(id: &str) -> Result<Project> {
    let dir = project_dir(id)?;
    let file: ProjectFile = read_json(&dir.join("project.json"))?;
    let tasks = list_tasks(id)?;
    // Prefer the new single-container field; fall back to the first reference in
    // any legacy `containers` array so existing projects keep working.
    let container = if !file.container.trim().is_empty() {
        file.container.trim().to_string()
    } else {
        file.containers
            .iter()
            .map(|c| c.reference.trim())
            .find(|r| !r.is_empty())
            .unwrap_or_default()
            .to_string()
    };
    Ok(Project {
        id: id.to_string(),
        name: file.name,
        project_dir: dir.to_string_lossy().to_string(),
        codebase_path: file.codebase_path,
        container_working_dir: file.container_working_dir,
        container,
        tasks,
    })
}

fn list_tasks(project_id: &str) -> Result<Vec<Task>> {
    let dir = tasks_dir(project_id)?;
    let mut tasks = Vec::new();
    if !dir.exists() {
        return Ok(tasks);
    }
    for entry in fs::read_dir(&dir).map_err(map_err("read tasks dir"))? {
        let entry = entry.map_err(map_err("read dir entry"))?;
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let id = entry.file_name().to_string_lossy().to_string();
        let meta_path = entry.path().join("task.json");
        let meta: TaskFile = if meta_path.exists() {
            read_json(&meta_path)?
        } else {
            TaskFile {
                name: id.clone(),
                description: None,
            }
        };
        tasks.push(Task {
            id: id.clone(),
            name: meta.name,
            dir: id,
            description: meta.description,
        });
    }
    tasks.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(tasks)
}

pub fn create_project(
    name: &str,
    codebase_path: &str,
    container_working_dir: &str,
    container: &str,
) -> Result<Project> {
    let root = dogger_home()?;
    if name.trim().is_empty() {
        return Err("project name is required".to_string());
    }
    let id = unique_id(&root, &slugify(name));
    let dir = root.join(&id);
    fs::create_dir_all(dir.join("tasks")).map_err(map_err("create project dir"))?;

    let working_dir = if container_working_dir.trim().is_empty() {
        "/app".to_string()
    } else {
        container_working_dir.trim().to_string()
    };
    let file = ProjectFile {
        name: name.trim().to_string(),
        codebase_path: codebase_path.trim().to_string(),
        container_working_dir: working_dir,
        container: container.trim().to_string(),
        containers: Vec::new(),
    };
    write_json(&dir.join("project.json"), &file)?;
    load_project(&id)
}

/// Persist edits to a project's config (name, codebase path, working dir,
/// container). Tasks are managed separately and left untouched.
pub fn update_project(
    id: &str,
    name: &str,
    codebase_path: &str,
    container_working_dir: &str,
    container: &str,
) -> Result<Project> {
    let dir = project_dir(id)?;
    if !dir.join("project.json").exists() {
        return Err(format!("project not found: {id}"));
    }
    let file = ProjectFile {
        name: name.trim().to_string(),
        codebase_path: codebase_path.trim().to_string(),
        container_working_dir: container_working_dir.trim().to_string(),
        container: container.trim().to_string(),
        containers: Vec::new(),
    };
    write_json(&dir.join("project.json"), &file)?;
    load_project(id)
}

pub fn delete_project(id: &str) -> Result<()> {
    let dir = project_dir(id)?;
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(map_err("delete project"))?;
    }
    Ok(())
}

const MAIN_SH_TEMPLATE: &str = r#"#!/usr/bin/env bash
set -euo pipefail

# Dogger task: __TASK_NAME__

echo "Running task: __TASK_NAME__"

echo "Done 🔥🔥🔥"
"#;

pub fn create_task(project_id: &str, name: &str, description: Option<&str>) -> Result<Task> {
    if name.trim().is_empty() {
        return Err("task name is required".to_string());
    }
    let parent = tasks_dir(project_id)?;
    if !project_dir(project_id)?.exists() {
        return Err(format!("project not found: {project_id}"));
    }
    fs::create_dir_all(&parent).map_err(map_err("create tasks dir"))?;
    let id = unique_id(&parent, &slugify(name));
    let dir = parent.join(&id);
    fs::create_dir_all(&dir).map_err(map_err("create task dir"))?;

    let meta = TaskFile {
        name: name.trim().to_string(),
        description: description
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string),
    };
    write_json(&dir.join("task.json"), &meta)?;

    let script = MAIN_SH_TEMPLATE.replace("__TASK_NAME__", name.trim());
    let main_sh = dir.join("main.sh");
    fs::write(&main_sh, script).map_err(map_err("write main.sh"))?;
    make_executable(&main_sh)?;

    Ok(Task {
        id: id.clone(),
        name: meta.name,
        dir: id,
        description: meta.description,
    })
}

pub fn delete_task(project_id: &str, task_id: &str) -> Result<()> {
    let dir = task_dir(project_id, task_id)?;
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(map_err("delete task"))?;
    }
    Ok(())
}

/// List file names (relative, single-level) inside a task directory.
pub fn list_task_files(project_id: &str, task_id: &str) -> Result<Vec<String>> {
    let dir = task_dir(project_id, task_id)?;
    let mut files = Vec::new();
    if !dir.exists() {
        return Ok(files);
    }
    for entry in fs::read_dir(&dir).map_err(map_err("read task dir"))? {
        let entry = entry.map_err(map_err("read dir entry"))?;
        if entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            files.push(entry.file_name().to_string_lossy().to_string());
        }
    }
    files.sort();
    Ok(files)
}

pub fn read_task_file(project_id: &str, task_id: &str, file: &str) -> Result<String> {
    let path = task_dir(project_id, task_id)?.join(sanitize_component(file)?);
    fs::read_to_string(&path).map_err(map_err("read task file"))
}

pub fn write_task_file(project_id: &str, task_id: &str, file: &str, contents: &str) -> Result<()> {
    let name = sanitize_component(file)?;
    let dir = task_dir(project_id, task_id)?;
    if !dir.exists() {
        return Err(format!("task not found: {task_id}"));
    }
    let path = dir.join(&name);
    fs::write(&path, contents).map_err(map_err("write task file"))?;
    if name == "main.sh" {
        make_executable(&path)?;
    }
    Ok(())
}

/// Persist a run record under the task's hidden `.runs/` directory. Used both
/// to record a run as it starts (`status: "running"`) and to overwrite it with
/// the final result when it finishes.
pub fn save_run(project_id: &str, task_id: &str, run: &RunRecord) -> Result<()> {
    let dir = runs_dir(project_id, task_id)?;
    fs::create_dir_all(&dir).map_err(map_err("create runs dir"))?;
    let id = sanitize_component(&run.id)?;
    write_json(&dir.join(format!("{id}.json")), run)
}

/// List a task's run history, most recent first.
pub fn list_runs(project_id: &str, task_id: &str) -> Result<Vec<RunRecord>> {
    let dir = runs_dir(project_id, task_id)?;
    let mut runs = Vec::new();
    if !dir.exists() {
        return Ok(runs);
    }
    for entry in fs::read_dir(&dir).map_err(map_err("read runs dir"))? {
        let entry = entry.map_err(map_err("read dir entry"))?;
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        if let Ok(run) = read_json::<RunRecord>(&path) {
            runs.push(run);
        }
    }
    runs.sort_by(|a, b| b.started_at.cmp(&a.started_at));
    Ok(runs)
}

#[cfg(unix)]
fn make_executable(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let mut perms = fs::metadata(path)
        .map_err(map_err("stat file"))?
        .permissions();
    perms.set_mode(0o755);
    fs::set_permissions(path, perms).map_err(map_err("chmod file"))
}

#[cfg(not(unix))]
fn make_executable(_path: &Path) -> Result<()> {
    Ok(())
}

/// Seed a couple of example projects the first time `~/.dogger` is created so
/// the app is browsable out of the box. Failures here are non-fatal.
fn seed_examples(root: &Path) {
    let _ = || -> io::Result<()> {
        // Acme API
        let acme = root.join("acme-api");
        fs::create_dir_all(acme.join("tasks"))?;
        fs::write(
            acme.join("project.json"),
            serde_json::to_string_pretty(&ProjectFile {
                name: "Acme API".to_string(),
                codebase_path: String::new(),
                container_working_dir: "/var/www/html".to_string(),
                container: "acme-api-php".to_string(),
                containers: Vec::new(),
            })
            .unwrap_or_default(),
        )?;
        seed_task(
            &acme,
            "migrate",
            "Run migrations",
            "Applies pending database migrations.",
        )?;
        seed_task(
            &acme,
            "seed",
            "Seed demo data",
            "Loads demo fixtures for local testing.",
        )?;

        // Marketing Site
        let mkt = root.join("marketing-site");
        fs::create_dir_all(mkt.join("tasks"))?;
        fs::write(
            mkt.join("project.json"),
            serde_json::to_string_pretty(&ProjectFile {
                name: "Marketing Site".to_string(),
                codebase_path: String::new(),
                container_working_dir: "/app".to_string(),
                container: "marketing-node".to_string(),
                containers: Vec::new(),
            })
            .unwrap_or_default(),
        )?;
        seed_task(
            &mkt,
            "build",
            "Build static site",
            "Compiles the static marketing site.",
        )?;
        Ok(())
    }();
}

fn seed_task(project: &Path, id: &str, name: &str, description: &str) -> io::Result<()> {
    let dir = project.join("tasks").join(id);
    fs::create_dir_all(&dir)?;
    fs::write(
        dir.join("task.json"),
        serde_json::to_string_pretty(&TaskFile {
            name: name.to_string(),
            description: Some(description.to_string()),
        })
        .unwrap_or_default(),
    )?;
    let main_sh = dir.join("main.sh");
    fs::write(&main_sh, MAIN_SH_TEMPLATE.replace("__TASK_NAME__", name))?;
    let _ = make_executable(&main_sh);
    Ok(())
}
