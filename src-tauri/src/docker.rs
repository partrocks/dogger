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

use std::fs;
use std::io::{BufRead, BufReader};
use std::path::Path;
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

/// Check whether `path` exists as a directory inside a running container.
/// Used by the project forms to validate the configured working directory
/// before a project is created/saved. Errors when the container isn't running
/// so the UI can tell "not running" apart from "path missing".
pub fn check_path(container: &str, path: &str) -> Result<bool, String> {
    let container = container.trim();
    let path = path.trim();
    if container.is_empty() {
        return Err("no container selected".to_string());
    }
    if path.is_empty() {
        return Err("no path specified".to_string());
    }
    if !is_container_running(container) {
        return Err(format!("container '{container}' is not running"));
    }
    // `test -d` is run directly (no `sh -c`) so the path is passed as a single
    // argument and never needs shell quoting.
    let output = Command::new("docker")
        .args(["exec", container, "test", "-d", path])
        .output()
        .map_err(|e| format!("failed to run docker exec: {e}"))?;
    Ok(output.status.success())
}

/// Shells Dogger probes for inside a container, in rough preference order
/// (used both for detection and as the fallback ranking when a script's
/// shebang shell isn't installed).
const CANDIDATE_SHELLS: &[&str] = &["bash", "zsh", "sh", "ash", "dash", "ksh"];

/// What Dogger detected about how a task's `main.sh` will be executed in a
/// container: which shells exist there, the script's declared interpreter
/// (shebang), and the interpreter actually chosen. Surfaced to the UI so the
/// shell is shown rather than guessed.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellInfo {
    /// Shells found on `PATH` inside the container (subset of CANDIDATE_SHELLS).
    pub available: Vec<String>,
    /// The interpreter Dogger will invoke (`bash`, `zsh`, `sh`, …).
    pub interpreter: String,
    /// The raw shebang line parsed from `main.sh`, if present.
    pub shebang: Option<String>,
    /// Coarse family of the chosen interpreter: `bash`, `zsh`, or `posix`.
    pub family: String,
}

/// Probe a running container for the shells it has on `PATH`. Returns the
/// matching subset of [`CANDIDATE_SHELLS`] (empty when the probe fails).
fn probe_container_shells(container: &str) -> Vec<String> {
    let probe = CANDIDATE_SHELLS
        .iter()
        .map(|s| format!("command -v {s} >/dev/null 2>&1 && echo {s}"))
        .collect::<Vec<_>>()
        .join("\n");
    match Command::new("docker")
        .args(["exec", container, "sh", "-c", &probe])
        .output()
    {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout)
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .map(str::to_string)
            .collect(),
        _ => Vec::new(),
    }
}

/// Last path component of a shebang interpreter (`/usr/bin/env` -> `env`).
fn basename(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

/// Read the shebang line (without the leading `#!`) from a script on disk.
fn read_shebang(path: &Path) -> Option<String> {
    let content = fs::read_to_string(path).ok()?;
    let first = content.lines().next()?;
    first.strip_prefix("#!").map(|s| s.trim().to_string())
}

/// Extract the shell name from a shebang body such as `/usr/bin/env bash` or
/// `/bin/zsh -l`, returning the bare interpreter name (`bash`, `zsh`, `sh`, …).
fn shell_from_shebang(shebang: &str) -> Option<String> {
    let mut parts = shebang.split_whitespace();
    let first = parts.next()?;
    if basename(first) == "env" {
        // `env [-S] <interp> …` — skip env's own flags to find the interpreter.
        parts
            .find(|a| !a.starts_with('-'))
            .map(|s| basename(s).to_string())
    } else {
        Some(basename(first).to_string())
    }
}

fn shell_family(shell: &str) -> &'static str {
    match shell {
        "bash" => "bash",
        "zsh" => "zsh",
        _ => "posix",
    }
}

/// Decide how to run a task's `main.sh` inside `container`: honour the shell
/// named by the script's shebang when it is actually installed, otherwise fall
/// back to the best shell that is present. `sh` is the last resort.
pub fn detect_shell(container: &str, main_sh: &Path) -> ShellInfo {
    let available = probe_container_shells(container);
    let shebang = read_shebang(main_sh);

    let interpreter = shebang
        .as_deref()
        .and_then(shell_from_shebang)
        .filter(|s| available.iter().any(|a| a == s))
        .or_else(|| {
            CANDIDATE_SHELLS
                .iter()
                .find(|pref| available.iter().any(|a| a == **pref))
                .map(|s| s.to_string())
        })
        .or_else(|| available.first().cloned())
        .unwrap_or_else(|| "sh".to_string());

    let family = shell_family(&interpreter).to_string();
    ShellInfo {
        available,
        interpreter,
        shebang,
        family,
    }
}

/// Detect the shell that would run a task's `main.sh` in `container`, for the
/// UI to display before a run. Errors when the container isn't running.
pub fn detect_container_shell(
    project_id: &str,
    task_id: &str,
    container: &str,
) -> Result<ShellInfo, String> {
    let container = container.trim();
    if container.is_empty() {
        return Err("no container selected".to_string());
    }
    if !is_container_running(container) {
        return Err(format!("container '{container}' is not running"));
    }
    let main_sh = storage::task_dir(project_id, task_id)?.join("main.sh");
    if !main_sh.exists() {
        return Err("this task has no main.sh".to_string());
    }
    Ok(detect_shell(container, &main_sh))
}

/// True when `b` would make an adjacent filename part of a larger token — so a
/// match there is *not* a standalone reference to that file. Covers word chars,
/// a path separator, a dot or dash (sibling/extension), and any non-ASCII byte.
fn extends_token(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b == b'/' || b == b'.' || b == b'-' || b >= 0x80
}

/// Rewrite bare or `./`-prefixed references to any of `resources` into
/// `"$DOGGER_TASK_DIR/<name>"`.
///
/// Conservative on purpose: a filename is only rewritten when it stands alone as
/// a token (not embedded in a longer path or word), so with a resource `foo.php`
/// the references `foo.php` and `./foo.php` are rewritten while `vendor/foo.php`
/// and `foobar.php` are left as-is. Longer resource names take precedence over
/// shorter ones. The input is never mutated; the result feeds a throwaway
/// in-container copy of `main.sh`.
fn rewrite_resource_refs(script: &str, resources: &[String]) -> String {
    let mut names: Vec<&str> = resources
        .iter()
        .map(String::as_str)
        .filter(|s| !s.is_empty())
        .collect();
    // Longest first so e.g. `seed.php.bak` is matched before `seed.php`.
    names.sort_by(|a, b| b.len().cmp(&a.len()));

    let bytes = script.as_bytes();
    let mut out = String::with_capacity(script.len());
    let mut i = 0;
    while i < script.len() {
        let rest = &script[i..];
        let mut matched = false;
        for name in &names {
            // A reference is the filename, optionally prefixed with `./`, with
            // either form beginning at the current position.
            let ref_len = if let Some(after_dot) = rest.strip_prefix("./") {
                if after_dot.starts_with(name) {
                    2 + name.len()
                } else {
                    continue;
                }
            } else if rest.starts_with(name) {
                name.len()
            } else {
                continue;
            };

            let lead_ok = i == 0 || !extends_token(bytes[i - 1]);
            let after = i + ref_len;
            let trail_ok = after >= bytes.len() || !extends_token(bytes[after]);
            if lead_ok && trail_ok {
                out.push_str("\"$DOGGER_TASK_DIR/");
                out.push_str(name);
                out.push('"');
                i = after;
                matched = true;
                break;
            }
        }
        if !matched {
            let ch = rest.chars().next().unwrap();
            out.push(ch);
            i += ch.len_utf8();
        }
    }
    out
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
    let main_sh_host = task_dir.join("main.sh");
    if !main_sh_host.exists() {
        return Err("this task has no main.sh to run".to_string());
    }
    let task_dir = task_dir.to_string_lossy().to_string();
    let working_dir = project.container_working_dir.trim().to_string();

    // Where the task lands inside the container.
    let dest = format!("/tmp/dogger/{run_id}");
    let script = format!("{dest}/main.sh");

    // Materialize a rewritten copy of `main.sh` for the container: bare or
    // `./`-prefixed references to the task's own resource files are turned into
    // `"$DOGGER_TASK_DIR/<file>"` so they resolve from the copied task dir no
    // matter the working directory. The source `main.sh` is never modified —
    // only this throwaway in-container copy is.
    let resources: Vec<String> = storage::list_task_files(project_id, task_id)?
        .into_iter()
        .filter(|f| f != "main.sh")
        .collect();
    let original_script =
        fs::read_to_string(&main_sh_host).map_err(|e| format!("read main.sh: {e}"))?;
    let materialized_script = rewrite_resource_refs(&original_script, &resources);
    let script_rewritten = materialized_script != original_script;

    // Pick the interpreter by probing the container's available shells and the
    // script's shebang rather than blindly guessing bash/sh — this honours
    // `#!/bin/zsh` etc. and degrades to whatever shell the image actually has.
    let shell = detect_shell(&container, &main_sh_host);
    let runner = format!("exec {interp} {script}", interp = shell.interpreter);
    let wd_display = if working_dir.is_empty() {
        String::new()
    } else {
        format!(" -w {working_dir}")
    };
    // Expose the task's copied location as an env var. This both backs the
    // rewritten resource references above and lets hand-written scripts use
    // `"$DOGGER_TASK_DIR/foo.php"` directly.
    let task_dir_env = format!("DOGGER_TASK_DIR={dest}");
    let command =
        format!("docker exec{wd_display} -e {task_dir_env} {container} sh -c '{runner}'");

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
            // Overwrite the copied main.sh with the rewritten version (the source
            // on disk stays untouched; only this in-container copy changes).
            if script_rewritten {
                let tmp = std::env::temp_dir().join(format!("dogger-{run_id}-main.sh"));
                fs::write(&tmp, &materialized_script)
                    .map_err(|e| format!("stage rewritten main.sh: {e}"))?;
                let tmp_str = tmp.to_string_lossy().to_string();
                let cp = run_quiet(Command::new("docker").args([
                    "cp",
                    &tmp_str,
                    &format!("{container}:{script}"),
                ]));
                let _ = fs::remove_file(&tmp);
                cp?;
            }
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
        cmd.args(["-e", &task_dir_env]);
        cmd.args([&container, "sh", "-c", &runner]);
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

#[cfg(test)]
mod tests {
    use super::rewrite_resource_refs;

    fn res(names: &[&str]) -> Vec<String> {
        names.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn rewrites_dot_slash_reference() {
        let out = rewrite_resource_refs("php ./seed.php\n", &res(&["seed.php"]));
        assert_eq!(out, "php \"$DOGGER_TASK_DIR/seed.php\"\n");
    }

    #[test]
    fn rewrites_bare_reference() {
        let out = rewrite_resource_refs("php seed.php\n", &res(&["seed.php"]));
        assert_eq!(out, "php \"$DOGGER_TASK_DIR/seed.php\"\n");
    }

    #[test]
    fn leaves_path_prefixed_reference_untouched() {
        let script = "php vendor/seed.php\n";
        assert_eq!(rewrite_resource_refs(script, &res(&["seed.php"])), script);
    }

    #[test]
    fn leaves_substring_of_longer_name_untouched() {
        // Resource `seed.php` must not match inside `seed.php.bak` or `xseed.php`.
        let script = "php seed.php.bak\ncat xseed.php\n";
        assert_eq!(rewrite_resource_refs(script, &res(&["seed.php"])), script);
    }

    #[test]
    fn longer_name_wins() {
        let out = rewrite_resource_refs(
            "cat ./seed.php.bak\n",
            &res(&["seed.php", "seed.php.bak"]),
        );
        assert_eq!(out, "cat \"$DOGGER_TASK_DIR/seed.php.bak\"\n");
    }

    #[test]
    fn rewrites_multiple_refs_on_one_line() {
        let out = rewrite_resource_refs("cp a.txt b.txt\n", &res(&["a.txt", "b.txt"]));
        assert_eq!(
            out,
            "cp \"$DOGGER_TASK_DIR/a.txt\" \"$DOGGER_TASK_DIR/b.txt\"\n"
        );
    }

    #[test]
    fn no_resources_is_identity() {
        let script = "php ./seed.php\n";
        assert_eq!(rewrite_resource_refs(script, &[]), script);
    }
}
