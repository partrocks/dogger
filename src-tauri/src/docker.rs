//! Docker integration for Dogger (Phase 2).
//!
//! Dogger never *manages* containers (see `context/rules.md`): it only probes
//! the Docker CLI/daemon, lists already-running containers, and executes a
//! task's `main.sh` inside a chosen running container.
//!
//! Execution strategy (see `context/decisions.md`): a task directory is copied
//! into the target container with `docker cp` and then run with `docker exec`.
//! We deliberately do *not* bind-mount, because adding a mount requires
//! (re)creating the container — which would violate the "Dogger does not manage
//! containers" rule. `main.sh` is invoked with the project's configured
//! container working directory (its codebase root) as the working directory.

use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::storage::{self, OutputLine, RunRecord};

/// Result of probing the local Docker installation.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerStatus {
    /// Whether the `docker` CLI is on `PATH`.
    pub cli_installed: bool,
    /// Whether the daemon responded (i.e. it is running and reachable).
    pub daemon_running: bool,
    /// Server version string when the daemon is reachable.
    pub server_version: Option<String>,
    /// Human-readable explanation when something is wrong.
    pub message: Option<String>,
}

/// A container currently running on the host (`docker ps`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunningContainer {
    pub id: String,
    pub name: String,
    pub image: String,
    pub status: String,
}

/// Event payload streamed to the frontend for each captured output line.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OutputEvent {
    run_id: String,
    stream: String,
    line: String,
}

/// Event payload emitted once when a run finishes (or fails to start).
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FinishedEvent {
    run_id: String,
    exit_code: Option<i32>,
    status: String,
}

pub const OUTPUT_EVENT: &str = "dogger://run-output";
pub const FINISHED_EVENT: &str = "dogger://run-finished";

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Probe the Docker CLI and daemon. Never returns an error — the whole point is
/// to report the failure mode to the UI so it can show a warning screen.
pub fn docker_status() -> DockerStatus {
    // `docker version --format {{.Server.Version}}` exits non-zero (and prints
    // to stderr) when the CLI exists but the daemon is unreachable, which lets
    // us distinguish "not installed" from "daemon down" in one call.
    match Command::new("docker")
        .args(["version", "--format", "{{.Server.Version}}"])
        .output()
    {
        Err(_) => DockerStatus {
            cli_installed: false,
            daemon_running: false,
            server_version: None,
            message: Some(
                "The Docker CLI was not found on your PATH. Install Docker to run tasks."
                    .to_string(),
            ),
        },
        Ok(output) if output.status.success() => {
            let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
            DockerStatus {
                cli_installed: true,
                daemon_running: true,
                server_version: if version.is_empty() {
                    None
                } else {
                    Some(version)
                },
                message: None,
            }
        }
        Ok(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            DockerStatus {
                cli_installed: true,
                daemon_running: false,
                server_version: None,
                message: Some(if stderr.is_empty() {
                    "The Docker daemon is not reachable. Is Docker running?".to_string()
                } else {
                    stderr
                }),
            }
        }
    }
}

/// List running containers via `docker ps`.
pub fn list_running_containers() -> Result<Vec<RunningContainer>, String> {
    let output = Command::new("docker")
        .args([
            "ps",
            "--no-trunc",
            "--format",
            "{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Status}}",
        ])
        .output()
        .map_err(|e| format!("failed to run `docker ps`: {e}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let mut containers = Vec::new();
    for line in text.lines() {
        let mut parts = line.splitn(4, '\t');
        let id = parts.next().unwrap_or("").to_string();
        let name = parts.next().unwrap_or("").to_string();
        let image = parts.next().unwrap_or("").to_string();
        let status = parts.next().unwrap_or("").to_string();
        if id.is_empty() {
            continue;
        }
        containers.push(RunningContainer {
            id,
            name,
            image,
            status,
        });
    }
    Ok(containers)
}

/// True when a configured container reference matches something in `docker ps`.
/// Matches by exact name, full or short id, or image.
pub fn is_container_running(reference: &str) -> bool {
    let reference = reference.trim();
    if reference.is_empty() {
        return false;
    }
    list_running_containers()
        .map(|cs| {
            cs.iter().any(|c| {
                c.name == reference
                    || c.id == reference
                    || c.id.starts_with(reference)
                    || c.image == reference
            })
        })
        .unwrap_or(false)
}

/// Start a task run inside `container`. The heavy lifting (copy + exec +
/// streaming) happens on a background thread; this returns once the run record
/// has been created so the caller gets the run id immediately. Progress is
/// streamed to the frontend via [`OUTPUT_EVENT`] / [`FINISHED_EVENT`], keyed by
/// `run_id`.
pub fn run_task(
    app: AppHandle,
    project_id: &str,
    task_id: &str,
    container: &str,
    run_id: &str,
) -> Result<RunRecord, String> {
    let container = container.trim().to_string();
    if container.is_empty() {
        return Err("no container selected for this task".to_string());
    }
    if !is_container_running(&container) {
        return Err(format!(
            "container '{container}' is not running. Start it on the host and try again."
        ));
    }

    let project = storage::load_project(project_id)?;
    let task_dir = storage::task_dir(project_id, task_id)?;
    if !task_dir.join("main.sh").exists() {
        return Err("this task has no main.sh to run".to_string());
    }
    let task_dir = task_dir.to_string_lossy().to_string();
    let working_dir = project.container_working_dir.trim().to_string();

    // Where the task lands inside the container.
    let dest = format!("/tmp/dogger/{run_id}");
    let command = format!("bash {dest}/main.sh");

    let mut record = RunRecord {
        id: run_id.to_string(),
        container: container.clone(),
        command: command.clone(),
        started_at: now_millis(),
        finished_at: None,
        exit_code: None,
        status: "running".to_string(),
        output: Vec::new(),
    };
    storage::save_run(project_id, task_id, &record)?;

    let project_id = project_id.to_string();
    let task_id = task_id.to_string();
    let run_id = run_id.to_string();

    thread::spawn(move || {
        let collected: Arc<Mutex<Vec<OutputLine>>> = Arc::new(Mutex::new(Vec::new()));

        // Helper to emit + collect a line.
        let emit_line = |app: &AppHandle,
                         collected: &Arc<Mutex<Vec<OutputLine>>>,
                         stream: &str,
                         line: String| {
            let _ = app.emit(
                OUTPUT_EVENT,
                OutputEvent {
                    run_id: run_id.clone(),
                    stream: stream.to_string(),
                    line: line.clone(),
                },
            );
            if let Ok(mut buf) = collected.lock() {
                buf.push(OutputLine {
                    stream: stream.to_string(),
                    text: line,
                });
            }
        };

        // 1. Make the destination dir and copy the task in.
        let prep = (|| -> std::result::Result<(), String> {
            run_quiet(Command::new("docker").args(["exec", &container, "mkdir", "-p", &dest]))?;
            run_quiet(Command::new("docker").args([
                "cp",
                &format!("{task_dir}/."),
                &format!("{container}:{dest}"),
            ]))?;
            Ok(())
        })();

        if let Err(e) = prep {
            emit_line(&app, &collected, "stderr", format!("dogger: {e}"));
            finish(
                &app,
                &project_id,
                &task_id,
                &run_id,
                &container,
                &command,
                &collected,
                None,
                "error",
            );
            return;
        }

        // 2. Run main.sh with the codebase root as the working directory.
        let mut cmd = Command::new("docker");
        cmd.arg("exec");
        if !working_dir.is_empty() {
            cmd.args(["-w", &working_dir]);
        }
        cmd.args([&container, "bash", &format!("{dest}/main.sh")]);
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());

        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                emit_line(
                    &app,
                    &collected,
                    "stderr",
                    format!("dogger: failed to start docker exec: {e}"),
                );
                finish(
                    &app,
                    &project_id,
                    &task_id,
                    &run_id,
                    &container,
                    &command,
                    &collected,
                    None,
                    "error",
                );
                return;
            }
        };

        // Drain stderr on its own thread; stdout on this one.
        let stderr_handle = child.stderr.take().map(|stderr| {
            let app = app.clone();
            let collected = collected.clone();
            let run_id = run_id.clone();
            thread::spawn(move || {
                for line in BufReader::new(stderr).lines() {
                    let Ok(line) = line else { break };
                    let _ = app.emit(
                        OUTPUT_EVENT,
                        OutputEvent {
                            run_id: run_id.clone(),
                            stream: "stderr".to_string(),
                            line: line.clone(),
                        },
                    );
                    if let Ok(mut buf) = collected.lock() {
                        buf.push(OutputLine {
                            stream: "stderr".to_string(),
                            text: line,
                        });
                    }
                }
            })
        });

        if let Some(stdout) = child.stdout.take() {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                emit_line(&app, &collected, "stdout", line);
            }
        }

        if let Some(handle) = stderr_handle {
            let _ = handle.join();
        }

        let exit_code = match child.wait() {
            Ok(status) => status.code(),
            Err(e) => {
                emit_line(&app, &collected, "stderr", format!("dogger: {e}"));
                None
            }
        };
        let status = match exit_code {
            Some(0) => "success",
            Some(_) => "failed",
            None => "error",
        };

        finish(
            &app,
            &project_id,
            &task_id,
            &run_id,
            &container,
            &command,
            &collected,
            exit_code,
            status,
        );
    });

    record.status = "running".to_string();
    Ok(record)
}

/// Run a command we don't need to stream (prep steps), surfacing stderr on
/// failure.
fn run_quiet(cmd: &mut Command) -> std::result::Result<(), String> {
    let output = cmd
        .output()
        .map_err(|e| format!("failed to invoke docker: {e}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

/// Persist the final run record and notify the frontend.
#[allow(clippy::too_many_arguments)]
fn finish(
    app: &AppHandle,
    project_id: &str,
    task_id: &str,
    run_id: &str,
    container: &str,
    command: &str,
    collected: &Arc<Mutex<Vec<OutputLine>>>,
    exit_code: Option<i32>,
    status: &str,
) {
    let output = collected.lock().map(|b| b.clone()).unwrap_or_default();
    let record = RunRecord {
        id: run_id.to_string(),
        container: container.to_string(),
        command: command.to_string(),
        // started_at was set when the record was first written; re-read would be
        // nicer but we keep it simple and reconstruct from the existing file.
        started_at: existing_started_at(project_id, task_id, run_id),
        finished_at: Some(now_millis()),
        exit_code,
        status: status.to_string(),
        output,
    };
    let _ = storage::save_run(project_id, task_id, &record);
    let _ = app.emit(
        FINISHED_EVENT,
        FinishedEvent {
            run_id: run_id.to_string(),
            exit_code,
            status: status.to_string(),
        },
    );
}

/// Best-effort lookup of the original `started_at` for a run already on disk so
/// the finished record keeps its true start time.
fn existing_started_at(project_id: &str, task_id: &str, run_id: &str) -> i64 {
    storage::list_runs(project_id, task_id)
        .ok()
        .and_then(|runs| runs.into_iter().find(|r| r.id == run_id))
        .map(|r| r.started_at)
        .unwrap_or_else(now_millis)
}
