//! AI task generation for Dogger (Phase 3).
//!
//! The "Generate" tab runs a tool-using agent in Rust that reads a project's
//! (read-only) codebase on demand and writes task files into the Dogger-managed
//! task directory under `~/.dogger`. Doing the HTTP work here — rather than in
//! the webview — keeps the API token off the frontend and sidesteps the app's
//! content-security policy.
//!
//! This module starts with the provider/model abstraction. Today only OpenAI is
//! wired up, but the shape below (a [`Provider`] enum plus a [`Model`] list) is
//! deliberately open: adding Anthropic/OpenRouter later is a new enum arm and a
//! few more [`models`] entries, with the rest of the agent loop unchanged.

// A few items below are only read across the Tauri boundary (serialised model
// metadata) or kept ready for future providers (e.g. `Provider::id`), so they
// have no in-crate caller yet. The module-level allow keeps the build quiet
// without scattering per-item attributes.
#![allow(dead_code)]

use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use crate::storage;

/// A chat-completions backend. Only [`Provider::OpenAi`] is supported for now;
/// the enum exists so the agent loop can branch on the backend (base URL, auth
/// header, request shape) without the call sites caring which one is active.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Provider {
    OpenAi,
}

impl Provider {
    /// Base URL of the provider's OpenAI-compatible chat-completions endpoint.
    pub fn chat_completions_url(self) -> &'static str {
        match self {
            Provider::OpenAi => "https://api.openai.com/v1/chat/completions",
        }
    }

    /// Stable string id used when (de)serialising a [`Model`] reference across
    /// the Tauri boundary. Mirrors the `camelCase` serde tag above.
    pub fn id(self) -> &'static str {
        match self {
            Provider::OpenAi => "openAi",
        }
    }
}

/// A user-selectable model. `id` is the provider's wire identifier (sent
/// verbatim in the request body), `label` is what the model selector shows, and
/// `provider` decides how the request is dispatched.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Model {
    /// Provider-native model identifier, e.g. `"gpt-4o"`.
    pub id: &'static str,
    /// Friendly name shown in the UI, e.g. `"GPT-4o"`.
    pub label: &'static str,
    /// Which backend serves this model.
    pub provider: Provider,
}

/// The hardcoded list of models offered in the Generate tab, in display order.
/// All entries support streaming tool calls via the chat-completions API. The
/// first entry is treated as the default selection.
pub fn models() -> Vec<Model> {
    vec![
        Model {
            id: "gpt-5.5",
            label: "GPT-5.5",
            provider: Provider::OpenAi,
        },
        Model {
            id: "gpt-4o",
            label: "GPT-4o",
            provider: Provider::OpenAi,
        },
        Model {
            id: "gpt-4o-mini",
            label: "GPT-4o mini",
            provider: Provider::OpenAi,
        },
        Model {
            id: "gpt-4.1",
            label: "GPT-4.1",
            provider: Provider::OpenAi,
        },
        Model {
            id: "gpt-4.1-mini",
            label: "GPT-4.1 mini",
            provider: Provider::OpenAi,
        },
    ]
}

/// Look up a model by its wire id, falling back to the first (default) entry
/// when the requested id is unknown. The list is tiny, so a linear scan is fine.
pub fn resolve_model(id: &str) -> Model {
    models()
        .into_iter()
        .find(|m| m.id == id)
        .unwrap_or_else(|| models().remove(0))
}

// ---- Events ----------------------------------------------------------------

/// Streamed assistant text deltas: `{ genId, delta }`.
pub const OUTPUT_EVENT: &str = "dogger://ai-output";
/// Tool activity, so the UI can show "Read src/index.ts" etc.:
/// `{ genId, tool, summary, phase }` where `phase` is `"running" | "done" | "error"`.
pub const TOOL_EVENT: &str = "dogger://ai-tool";
/// Emitted exactly once when a generation ends (or fails to start):
/// `{ genId, status, message? }` where `status` is `"success" | "error"`.
pub const FINISHED_EVENT: &str = "dogger://ai-finished";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OutputEvent {
    gen_id: String,
    delta: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ToolEvent {
    gen_id: String,
    tool: String,
    summary: String,
    phase: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FinishedEvent {
    gen_id: String,
    status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}

// ---- Public types -----------------------------------------------------------

/// One turn of prior conversation, as sent from the Generate tab. Tool rounds
/// stay internal to a single send, so history is just plain `user`/`assistant`
/// text turns (a deliberate v1 simplification — see the plan).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiMessage {
    /// `"user"` or `"assistant"`.
    pub role: String,
    pub text: String,
}

// ---- Limits -----------------------------------------------------------------

/// Hard cap on agent ↔ tool round-trips, so a confused model can't loop forever.
const MAX_ITERATIONS: usize = 20;
/// Largest file `read_file` will return, to keep a single tool result bounded.
const MAX_FILE_BYTES: u64 = 64 * 1024;
/// Largest directory listing `list_dir` will return.
const MAX_DIR_ENTRIES: usize = 500;
/// How long to wait for the TCP/TLS connection to the provider before giving up.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
/// Total deadline for a *single* model turn (one streamed completion). The
/// agent makes a fresh request per turn, so this bounds a hung/stalled response
/// without capping the overall multi-turn generation, which may make several
/// requests as it uses tools.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(180);

// ---- Cancellation -----------------------------------------------------------

/// Per-generation cancellation flags, keyed by `gen_id`. A generation registers
/// its flag on start and removes it on finish; [`cancel_generation`] sets the
/// flag so the running agent loop can stop at the next checkpoint.
fn cancellations() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    static FLAGS: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();
    FLAGS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Register (or reuse) a cancellation flag for `gen_id`.
fn register_cancel(gen_id: &str) -> Arc<AtomicBool> {
    let flag = Arc::new(AtomicBool::new(false));
    if let Ok(mut map) = cancellations().lock() {
        map.insert(gen_id.to_string(), flag.clone());
    }
    flag
}

/// Remove the cancellation flag for a finished generation.
fn unregister_cancel(gen_id: &str) {
    if let Ok(mut map) = cancellations().lock() {
        map.remove(gen_id);
    }
}

/// Request cancellation of an in-flight generation. No-op if it already
/// finished (or never existed). The agent loop checks the flag between stream
/// reads and tool calls, so cancellation takes effect promptly.
pub fn cancel_generation(gen_id: &str) {
    if let Ok(map) = cancellations().lock() {
        if let Some(flag) = map.get(gen_id) {
            flag.store(true, Ordering::Relaxed);
        }
    }
}

// ---- System prompt ----------------------------------------------------------

/// The output contract handed to the model on every generation. Placeholders
/// are substituted per request in [`build_system_prompt`].
const SYSTEM_PROMPT: &str = r#"You are Dogger's task-generation agent. Your job is to author the files for a single Dogger "task": a small, self-contained job that runs inside the project's container.

The task you are building is named: "__TASK_NAME__".

## How a task runs
- Dogger copies the task directory into the project's container and executes `main.sh` from there.
- The working directory at run time is the project's codebase root inside the container: __CONTAINER_WORKING_DIR__
- The environment variable `DOGGER_TASK_DIR` points at the task directory inside the container. Reference sibling files you create as "$DOGGER_TASK_DIR/<file>" (never with a relative or absolute host path).

## Hard rules
1. The project codebase at "__CODEBASE_PATH__" is STRICTLY READ-ONLY. Use `list_dir` and `read_file` to understand it, but NEVER attempt to modify it. Your only writable surface is the task directory, reached through `write_task_file`.
2. `main.sh` is the REQUIRED entrypoint. It must begin with:
       #!/usr/bin/env bash
       set -euo pipefail
3. Keep the task focused and idempotent where reasonable.
4. Inspect the codebase first when the request depends on how the project is built or run, rather than guessing.

## File layout
- You are NOT limited to a single `main.sh`. Prefer a clean, modular layout over one monolithic script.
- Keep `main.sh` as a thin entrypoint that orchestrates the work, and split distinct steps, reusable logic, configuration, or large here-docs into their own helper files (e.g. `lib.sh`, `setup.sh`, a config file, a Python/Node script).
- Reference sibling files through `$DOGGER_TASK_DIR`, e.g. `source "$DOGGER_TASK_DIR/lib.sh"` or `python3 "$DOGGER_TASK_DIR/report.py"`. Never use a relative or absolute host path.
- Use judgment: a tiny task can still be a single `main.sh`. Split things out when it genuinely improves readability or reuse, not for its own sake.

## Existing task files
- If this task already has files, their current contents are provided to you as context before the conversation.
- Treat them as the starting point: modify or extend the existing files only as needed to satisfy the request, and leave unrelated parts intact. Don't rewrite a file wholesale when a targeted change will do, and don't recreate files that are already correct.
- `write_task_file` overwrites a file in full, so when changing an existing file, re-send its complete intended contents (the original plus your edits).

## Workflow
- Explore with `list_dir`/`read_file` as needed. The existing task files (if any) are already given to you; use `list_task_files`/`read_task_file` only to re-check the latest state after your own writes.
- Write the task with `write_task_file` (the final task must always include `main.sh`).
- When everything is written, reply with a short, plain-language summary of what the task does and how to run it. Do not paste the full file contents back."#;

/// Fill the [`SYSTEM_PROMPT`] placeholders for a specific project/task.
fn build_system_prompt(
    codebase_path: &str,
    container_working_dir: &str,
    task_name: &str,
) -> String {
    let codebase = if codebase_path.trim().is_empty() {
        "(no codebase path configured — list_dir/read_file are unavailable)".to_string()
    } else {
        codebase_path.to_string()
    };
    let working_dir = if container_working_dir.trim().is_empty() {
        "/app".to_string()
    } else {
        container_working_dir.to_string()
    };
    SYSTEM_PROMPT
        .replace("__TASK_NAME__", task_name)
        .replace("__CODEBASE_PATH__", &codebase)
        .replace("__CONTAINER_WORKING_DIR__", &working_dir)
}

/// Snapshot the task directory's current files into a single context block, so
/// the model can build on an existing task instead of regenerating it blind.
/// Returns `None` when the task has no files yet (a fresh generation). Each file
/// is truncated to [`MAX_FILE_BYTES`] to keep the prompt bounded.
fn build_existing_files_context(project_id: &str, task_id: &str) -> Option<String> {
    let files = storage::list_task_files(project_id, task_id).ok()?;
    if files.is_empty() {
        return None;
    }
    let mut out = String::from(
        "The task directory already contains the following files. Use them as the \
         starting point and change only what the request requires.\n",
    );
    for file in &files {
        let body = match storage::read_task_file(project_id, task_id, file) {
            Ok(mut contents) => {
                if contents.len() as u64 > MAX_FILE_BYTES {
                    contents.truncate(MAX_FILE_BYTES as usize);
                    contents.push_str(&format!("\n… (truncated at {MAX_FILE_BYTES} bytes)"));
                }
                contents
            }
            // A file we can't read (e.g. binary/non-UTF-8) is still worth noting.
            Err(e) => format!("(could not read this file as text: {e})"),
        };
        out.push_str(&format!("\n----- {file} -----\n{body}\n"));
    }
    Some(out)
}

// ---- Tool schemas -----------------------------------------------------------

/// The JSON tool specifications advertised to the model. Read-only,
/// codebase-scoped inspection plus task-scoped reads/writes — the task
/// directory is the only writable surface.
fn tool_specs() -> Value {
    json!([
        {
            "type": "function",
            "function": {
                "name": "list_dir",
                "description": "List the contents of a directory within the project's read-only codebase. Use an empty string or \".\" for the codebase root. Directories are suffixed with \"/\".",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "Path relative to the codebase root." }
                    },
                    "required": ["path"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "read_file",
                "description": "Read a UTF-8 text file from the project's read-only codebase. Large files are truncated.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "Path relative to the codebase root." }
                    },
                    "required": ["path"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "write_task_file",
                "description": "Create or overwrite a file in the task directory (the only writable location). Use single-level file names only, e.g. \"main.sh\". Writing \"main.sh\" makes it executable automatically.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "file": { "type": "string", "description": "Single-level file name within the task directory." },
                        "contents": { "type": "string", "description": "Full file contents." }
                    },
                    "required": ["file", "contents"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "list_task_files",
                "description": "List the file names already present in the task directory.",
                "parameters": { "type": "object", "properties": {} }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "read_task_file",
                "description": "Read a file you previously wrote into the task directory.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "file": { "type": "string", "description": "Single-level file name within the task directory." }
                    },
                    "required": ["file"]
                }
            }
        }
    ])
}

// ---- Path safety ------------------------------------------------------------

/// Resolve `rel` (an arbitrary-depth path supplied by the model) against `base`
/// and verify the canonical result stays inside `base`. Guards the read-only
/// codebase tools against `..`/symlink traversal. Unlike
/// `storage::sanitize_component`, this allows nested paths like `src/app/x.ts`.
fn resolve_within(base: &Path, rel: &str) -> Result<PathBuf, String> {
    let base = base
        .canonicalize()
        .map_err(|e| format!("codebase path is not accessible: {e}"))?;
    // Treat a leading slash as "from the codebase root", not the host root.
    let rel = rel.trim().trim_start_matches('/');
    let candidate = if rel.is_empty() || rel == "." {
        base.clone()
    } else {
        base.join(rel)
    };
    let resolved = candidate
        .canonicalize()
        .map_err(|e| format!("path not found: {rel} ({e})"))?;
    if !resolved.starts_with(&base) {
        return Err(format!("path escapes the codebase: {rel}"));
    }
    Ok(resolved)
}

// ---- Tool implementations ---------------------------------------------------

/// The outcome of running a tool: the textual `content` fed back to the model
/// and a short human `summary` for the UI's tool-activity line.
struct ToolOutcome {
    content: String,
    summary: String,
}

fn tool_list_dir(codebase_path: &str, path: &str) -> Result<ToolOutcome, String> {
    if codebase_path.trim().is_empty() {
        return Err(
            "no codebase path is configured for this project, so the codebase cannot be browsed"
                .to_string(),
        );
    }
    let dir = resolve_within(Path::new(codebase_path), path)?;
    if !dir.is_dir() {
        return Err(format!("not a directory: {path}"));
    }
    let mut entries: Vec<String> = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| format!("read dir: {e}"))? {
        let entry = entry.map_err(|e| format!("read dir entry: {e}"))?;
        let name = entry.file_name().to_string_lossy().to_string();
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        entries.push(if is_dir { format!("{name}/") } else { name });
    }
    entries.sort();
    let truncated = entries.len() > MAX_DIR_ENTRIES;
    entries.truncate(MAX_DIR_ENTRIES);
    let shown = if path.trim().is_empty() || path.trim() == "." {
        ".".to_string()
    } else {
        path.trim().to_string()
    };
    let mut content = if entries.is_empty() {
        format!("{shown} is empty")
    } else {
        format!("{shown}:\n{}", entries.join("\n"))
    };
    if truncated {
        content.push_str(&format!("\n… (truncated to {MAX_DIR_ENTRIES} entries)"));
    }
    Ok(ToolOutcome {
        content,
        summary: format!("Listed {shown}"),
    })
}

fn tool_read_file(codebase_path: &str, path: &str) -> Result<ToolOutcome, String> {
    if codebase_path.trim().is_empty() {
        return Err(
            "no codebase path is configured for this project, so files cannot be read".to_string(),
        );
    }
    let file = resolve_within(Path::new(codebase_path), path)?;
    if !file.is_file() {
        return Err(format!("not a file: {path}"));
    }
    let f = fs::File::open(&file).map_err(|e| format!("open file: {e}"))?;
    let mut buf = String::new();
    let mut handle = f.take(MAX_FILE_BYTES + 1);
    handle
        .read_to_string(&mut buf)
        .map_err(|e| format!("read file (is it UTF-8 text?): {e}"))?;
    let truncated = buf.len() as u64 > MAX_FILE_BYTES;
    if truncated {
        buf.truncate(MAX_FILE_BYTES as usize);
        buf.push_str(&format!("\n… (truncated at {MAX_FILE_BYTES} bytes)"));
    }
    Ok(ToolOutcome {
        content: buf,
        summary: format!("Read {}", path.trim()),
    })
}

fn tool_write_task_file(
    project_id: &str,
    task_id: &str,
    file: &str,
    contents: &str,
) -> Result<ToolOutcome, String> {
    storage::write_task_file(project_id, task_id, file, contents)?;
    Ok(ToolOutcome {
        content: format!("wrote {} ({} bytes)", file, contents.len()),
        summary: format!("Wrote {file}"),
    })
}

fn tool_list_task_files(project_id: &str, task_id: &str) -> Result<ToolOutcome, String> {
    let files = storage::list_task_files(project_id, task_id)?;
    let content = if files.is_empty() {
        "the task directory is empty".to_string()
    } else {
        files.join("\n")
    };
    Ok(ToolOutcome {
        content,
        summary: "Listed task files".to_string(),
    })
}

fn tool_read_task_file(project_id: &str, task_id: &str, file: &str) -> Result<ToolOutcome, String> {
    let content = storage::read_task_file(project_id, task_id, file)?;
    Ok(ToolOutcome {
        content,
        summary: format!("Read task file {file}"),
    })
}

/// Dispatch a single tool call by name. The raw `arguments` are the JSON string
/// accumulated from the stream. Returns the outcome on success; tool *failures*
/// are surfaced to the caller as `Err(String)` so they can be reported to both
/// the UI and the model (which may recover and retry).
fn run_tool(
    name: &str,
    arguments: &str,
    codebase_path: &str,
    project_id: &str,
    task_id: &str,
) -> Result<ToolOutcome, String> {
    let args: Value = if arguments.trim().is_empty() {
        json!({})
    } else {
        serde_json::from_str(arguments).map_err(|e| format!("invalid tool arguments: {e}"))?
    };
    let str_arg = |key: &str| -> Result<String, String> {
        args.get(key)
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| format!("missing string argument: {key}"))
    };
    match name {
        "list_dir" => tool_list_dir(codebase_path, &str_arg("path").unwrap_or_default()),
        "read_file" => tool_read_file(codebase_path, &str_arg("path")?),
        "write_task_file" => tool_write_task_file(
            project_id,
            task_id,
            &str_arg("file")?,
            &str_arg("contents")?,
        ),
        "list_task_files" => tool_list_task_files(project_id, task_id),
        "read_task_file" => tool_read_task_file(project_id, task_id, &str_arg("file")?),
        other => Err(format!("unknown tool: {other}")),
    }
}

// ---- Streaming client -------------------------------------------------------

/// A tool call being assembled from streamed deltas. The provider sends the
/// `id`/`name` once and streams `arguments` in fragments, keyed by `index`.
#[derive(Default)]
struct ToolCallAccum {
    id: String,
    name: String,
    arguments: String,
}

/// What one assistant turn produced: any streamed `content` plus the (possibly
/// empty) set of tool calls it requested.
struct AssistantTurn {
    content: String,
    tool_calls: Vec<ToolCallAccum>,
}

/// POST one chat-completions request with `stream: true`, forwarding text
/// deltas to the UI as `ai-output` events and accumulating any tool calls.
#[allow(clippy::too_many_arguments)]
fn stream_completion(
    app: &AppHandle,
    gen_id: &str,
    provider: Provider,
    token: &str,
    model: &str,
    messages: &[Value],
    tools: &Value,
    cancel: &AtomicBool,
) -> Result<AssistantTurn, String> {
    let body = json!({
        "model": model,
        "stream": true,
        "messages": messages,
        "tools": tools,
        "tool_choice": "auto",
    });

    let client = reqwest::blocking::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|e| format!("could not create HTTP client: {e}"))?;

    let resp = client
        .post(provider.chat_completions_url())
        .header("Authorization", format!("Bearer {token}"))
        .json(&body)
        .send()
        .map_err(|e| format!("request to the model provider failed: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        // A rejected key is the most common, most actionable failure — point the
        // user straight at Settings rather than dumping the raw provider error.
        if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
            return Err(
                "Your OpenAI token was rejected (it may be invalid, expired, or lacking access \
                 to this model). Update it in Settings and try again."
                    .to_string(),
            );
        }
        let detail = resp.text().unwrap_or_default();
        let detail = detail.trim();
        return Err(if detail.is_empty() {
            format!("the model provider returned {status}")
        } else {
            format!("the model provider returned {status}: {detail}")
        });
    }

    let mut content = String::new();
    let mut tool_calls: Vec<ToolCallAccum> = Vec::new();

    let reader = BufReader::new(resp);
    for line in reader.lines() {
        // Stop reading promptly when the user cancels mid-stream.
        if cancel.load(Ordering::Relaxed) {
            break;
        }
        let line = match line {
            Ok(l) => l,
            // A read error after a cancel is just the dropped connection.
            Err(_) if cancel.load(Ordering::Relaxed) => break,
            Err(e) => return Err(format!("error reading the model response stream: {e}")),
        };
        let line = line.trim();
        // SSE frames are `data: <json>` lines; everything else (comments,
        // blank separators, `event:` lines) is ignored.
        let Some(data) = line.strip_prefix("data:") else {
            continue;
        };
        let data = data.trim();
        if data == "[DONE]" {
            break;
        }
        let chunk: Value = match serde_json::from_str(data) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let Some(choice) = chunk["choices"].get(0) else {
            continue;
        };
        let delta = &choice["delta"];

        if let Some(text) = delta["content"].as_str() {
            if !text.is_empty() {
                content.push_str(text);
                let _ = app.emit(
                    OUTPUT_EVENT,
                    OutputEvent {
                        gen_id: gen_id.to_string(),
                        delta: text.to_string(),
                    },
                );
            }
        }

        if let Some(calls) = delta["tool_calls"].as_array() {
            for call in calls {
                let idx = call["index"].as_u64().unwrap_or(0) as usize;
                while tool_calls.len() <= idx {
                    tool_calls.push(ToolCallAccum::default());
                }
                let slot = &mut tool_calls[idx];
                if let Some(id) = call["id"].as_str() {
                    if !id.is_empty() {
                        slot.id = id.to_string();
                    }
                }
                let func = &call["function"];
                if let Some(name) = func["name"].as_str() {
                    slot.name.push_str(name);
                }
                if let Some(args) = func["arguments"].as_str() {
                    slot.arguments.push_str(args);
                }
            }
        }
    }

    Ok(AssistantTurn {
        content,
        tool_calls,
    })
}

// ---- Agent loop -------------------------------------------------------------

/// Start a generation. Validates configuration synchronously (so the caller can
/// surface a clear error in the UI), then runs the streaming agent loop on a
/// background thread, mirroring `docker::run_task`. All further progress is
/// reported via the `ai-output` / `ai-tool` / `ai-finished` events.
pub fn generate_task(
    app: AppHandle,
    project_id: &str,
    task_id: &str,
    gen_id: &str,
    model_id: &str,
    prompt: &str,
    history: Vec<AiMessage>,
) -> Result<(), String> {
    let token = storage::load_settings()?.openai_token.trim().to_string();
    if token.is_empty() {
        return Err("Add your OpenAI token in Settings to generate tasks.".to_string());
    }

    let project = storage::load_project(project_id)?;
    let task_name = project
        .tasks
        .iter()
        .find(|t| t.id == task_id)
        .map(|t| t.name.clone())
        .ok_or_else(|| format!("task not found: {task_id}"))?;

    let model = resolve_model(model_id);
    let system_prompt = build_system_prompt(
        &project.codebase_path,
        &project.container_working_dir,
        &task_name,
    );
    let existing_files = build_existing_files_context(project_id, task_id);

    let app_thread = app.clone();
    let project_id = project_id.to_string();
    let task_id = task_id.to_string();
    let gen_id = gen_id.to_string();
    let model_wire = model.id.to_string();
    let provider = model.provider;
    let codebase_path = project.codebase_path.clone();
    let prompt = prompt.to_string();

    let cancel = register_cancel(&gen_id);

    thread::spawn(move || {
        let result = run_agent_loop(
            &app_thread,
            &gen_id,
            provider,
            &token,
            &model_wire,
            &system_prompt,
            existing_files.as_deref(),
            &codebase_path,
            &project_id,
            &task_id,
            &prompt,
            history,
            &cancel,
        );
        unregister_cancel(&gen_id);
        let finished = match result {
            Ok(LoopEnd::Completed) => FinishedEvent {
                gen_id: gen_id.clone(),
                status: "success".to_string(),
                message: None,
            },
            Ok(LoopEnd::Cancelled) => FinishedEvent {
                gen_id: gen_id.clone(),
                status: "cancelled".to_string(),
                message: None,
            },
            Err(message) => FinishedEvent {
                gen_id: gen_id.clone(),
                status: "error".to_string(),
                message: Some(message),
            },
        };
        let _ = app_thread.emit(FINISHED_EVENT, finished);
    });

    Ok(())
}

/// How the agent loop ended: it ran to a final answer, or the user cancelled.
enum LoopEnd {
    Completed,
    Cancelled,
}

/// The streaming tool-call loop: repeatedly call the model, and whenever it asks
/// for tools, execute them and feed the results back, until it produces a final
/// answer or the iteration cap is hit.
#[allow(clippy::too_many_arguments)]
fn run_agent_loop(
    app: &AppHandle,
    gen_id: &str,
    provider: Provider,
    token: &str,
    model: &str,
    system_prompt: &str,
    existing_files: Option<&str>,
    codebase_path: &str,
    project_id: &str,
    task_id: &str,
    prompt: &str,
    history: Vec<AiMessage>,
    cancel: &AtomicBool,
) -> Result<LoopEnd, String> {
    let tools = tool_specs();

    let mut messages: Vec<Value> = Vec::with_capacity(history.len() + 3);
    messages.push(json!({ "role": "system", "content": system_prompt }));
    // Seed the conversation with the task's current files so the model edits an
    // existing task rather than regenerating it from scratch.
    if let Some(existing) = existing_files {
        messages.push(json!({ "role": "system", "content": existing }));
    }
    for turn in history {
        // Coerce anything unexpected to a user turn rather than rejecting it.
        let role = if turn.role == "assistant" {
            "assistant"
        } else {
            "user"
        };
        messages.push(json!({ "role": role, "content": turn.text }));
    }
    messages.push(json!({ "role": "user", "content": prompt }));

    for _ in 0..MAX_ITERATIONS {
        if cancel.load(Ordering::Relaxed) {
            return Ok(LoopEnd::Cancelled);
        }

        let turn = stream_completion(
            app, gen_id, provider, token, model, &messages, &tools, cancel,
        )?;

        if cancel.load(Ordering::Relaxed) {
            return Ok(LoopEnd::Cancelled);
        }

        if turn.tool_calls.is_empty() {
            // A plain answer with no tool calls means the agent is done.
            return Ok(LoopEnd::Completed);
        }

        // Record the assistant's tool-call request before answering it.
        let tool_calls_json: Vec<Value> = turn
            .tool_calls
            .iter()
            .map(|tc| {
                json!({
                    "id": tc.id,
                    "type": "function",
                    "function": { "name": tc.name, "arguments": tc.arguments },
                })
            })
            .collect();
        messages.push(json!({
            "role": "assistant",
            "content": turn.content,
            "tool_calls": tool_calls_json,
        }));

        // Execute each requested tool and append its result.
        for tc in &turn.tool_calls {
            let _ = app.emit(
                TOOL_EVENT,
                ToolEvent {
                    gen_id: gen_id.to_string(),
                    tool: tc.name.clone(),
                    summary: format!("Running {}", tc.name),
                    phase: "running".to_string(),
                },
            );

            let (content, summary, phase) =
                match run_tool(&tc.name, &tc.arguments, codebase_path, project_id, task_id) {
                    Ok(outcome) => (outcome.content, outcome.summary, "done"),
                    Err(err) => (
                        format!("Error: {err}"),
                        format!("{}: {err}", tc.name),
                        "error",
                    ),
                };

            let _ = app.emit(
                TOOL_EVENT,
                ToolEvent {
                    gen_id: gen_id.to_string(),
                    tool: tc.name.clone(),
                    summary,
                    phase: phase.to_string(),
                },
            );

            messages.push(json!({
                "role": "tool",
                "tool_call_id": tc.id,
                "content": content,
            }));
        }
    }

    Err(format!(
        "Stopped after {MAX_ITERATIONS} steps without finishing. Try a more specific request."
    ))
}
