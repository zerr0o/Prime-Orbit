use crate::{
    files::{
        attachment_artifact_root, hydrate_prompt_attachments, parse_orbit_attachment_context,
        remove_staged_attachment_context, AttachmentCache, PublicAttachmentMetadata,
    },
    paths::canonicalize,
    runtime::{detect_internal, external_command, now_millis, LaunchSpec},
    session_lease::{reclaim_stale_session_lease, session_lease_exists},
    MAX_RPC_BYTES,
};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::{
    collections::{HashMap, HashSet},
    ffi::OsString,
    fs,
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStderr, ChildStdin, ChildStdout, ExitStatus, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager};

const IDLE_RELEASE_GRACE: Duration = Duration::from_millis(350);
const MAX_EXIT_DIAGNOSTIC_BYTES: usize = 8 * 1024;
const STDERR_DRAIN_GRACE: Duration = Duration::from_millis(350);
const RESTART_GRACEFUL_EXIT_TIMEOUT: Duration = Duration::from_secs(12);
const RESTART_LEASE_RELEASE_TIMEOUT: Duration = Duration::from_secs(35);
const RESTART_RELEASE_POLL_INTERVAL: Duration = Duration::from_millis(100);
// A daemon reload normally answers within the bridge's dedicated 120-second
// request timeout. If that acknowledgement is lost, retain the native
// maintenance fence for a further bounded grace period: the daemon may still
// be completing the reload after the client stopped waiting.
const RELOAD_UNKNOWN_GRACE: Duration = Duration::from_secs(30);
const QUEUE_BRIDGE_SCRIPT: &str = include_str!("../assets/prime-agent-queue-bridge.cjs");
const SESSION_CONTROL_BRIDGE_SCRIPT: &str =
    include_str!("../assets/prime-agent-session-control-bridge.cjs");
const MAX_QUEUED_MESSAGE_TEXT: usize = 128 * 1024;

#[derive(Clone)]
pub struct AgentsState(Arc<Mutex<HashMap<String, RunningAgent>>>);

impl Default for AgentsState {
    fn default() -> Self {
        Self(Arc::new(Mutex::new(HashMap::new())))
    }
}

#[derive(Clone)]
struct RunningAgent {
    info: RunningAgentInfo,
    launch_spec: LaunchSpec,
    child: Arc<Mutex<Child>>,
    stdin: Arc<Mutex<Option<ChildStdin>>>,
    exit_emitted: Arc<AtomicBool>,
    owners: HashSet<String>,
    interactive_owner: Option<String>,
    busy: bool,
    release_when_idle: bool,
    restarting: bool,
    operations: AgentOperations,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ResourceReloadPhase {
    InFlight,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ResourceReloadMarker {
    token: u64,
    phase: ResourceReloadPhase,
}

#[derive(Debug, Clone, Default)]
struct AgentOperations {
    runtime_writes: usize,
    reloading: Option<ResourceReloadMarker>,
    next_reload_token: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ResourceReloadClaimError {
    NotOwner,
    RuntimeWrite,
    Reloading,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunningAgentInfo {
    pub conversation_id: String,
    pub pid: u32,
    pub cwd: String,
    pub session_path: Option<String>,
    pub session_id: Option<String>,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub thinking: Option<String>,
    pub started_at: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestartAgentResult {
    pub previous_pid: u32,
    pub agent: RunningAgentInfo,
}

struct SpawnedRpcAgent {
    info: RunningAgentInfo,
    child: Arc<Mutex<Child>>,
    stdin: Arc<Mutex<Option<ChildStdin>>>,
    stdout: ChildStdout,
    stderr: ChildStderr,
    exit_emitted: Arc<AtomicBool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentLineEvent {
    conversation_id: String,
    line: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentExitEvent {
    conversation_id: String,
    code: Option<i32>,
    success: bool,
    error: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct AgentResourcesReloadedEvent {
    conversation_id: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum QueuedMessageMutation {
    Delete,
    Move { direction: i8 },
    Replace { text: String, lane: String },
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueMutationResult {
    status: String,
    #[serde(skip_serializing)]
    attachment_context_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct QueueBridgeRequest {
    session_file: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    session_id: Option<String>,
    lane: String,
    index: usize,
    expected_text: String,
    mutation: QueuedMessageMutation,
}

struct QueueMutationOperation {
    owner: String,
    conversation_id: String,
    lane: String,
    index: usize,
    expected_text: String,
    mutation: QueuedMessageMutation,
    app_data_dir: PathBuf,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReloadAgentResourcesResult {
    status: String,
    supported: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionControlBridgeRequest {
    action: &'static str,
    session_file: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    session_id: Option<String>,
}

fn validated_identifier(value: String) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err("conversationId ne peut pas être vide".to_string());
    }
    if value.len() > 256 || value.chars().any(char::is_control) {
        return Err("conversationId contient des caractères invalides".to_string());
    }
    Ok(value.to_string())
}

fn validated_option(
    value: Option<String>,
    label: &str,
    max_length: usize,
) -> Result<Option<String>, String> {
    match value {
        Some(value) => {
            let value = value.trim();
            if value.is_empty() {
                return Ok(None);
            }
            if value.len() > max_length
                || value.chars().any(char::is_control)
                || (cfg!(windows) && value.contains('"'))
            {
                return Err(format!("{label} contient des caractères invalides"));
            }
            Ok(Some(value.to_string()))
        }
        None => Ok(None),
    }
}

fn is_valid_thinking_level(level: &str) -> bool {
    matches!(
        level,
        "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
    )
}

fn validated_cwd(cwd: String) -> Result<PathBuf, String> {
    let path = PathBuf::from(cwd);
    if !path.is_absolute() {
        return Err("Le dossier de projet doit être un chemin absolu".to_string());
    }
    let metadata = fs::metadata(&path)
        .map_err(|error| format!("Le dossier {} est inaccessible: {error}", path.display()))?;
    if !metadata.is_dir() {
        return Err(format!("{} n’est pas un dossier", path.display()));
    }
    canonicalize(&path)
        .map_err(|error| format!("Impossible de résoudre {}: {error}", path.display()))
}

fn validated_session_path(cwd: &Path, path: Option<String>) -> Result<Option<PathBuf>, String> {
    let Some(path) = path else {
        return Ok(None);
    };
    if path.trim().is_empty() {
        return Ok(None);
    }
    let path = PathBuf::from(path);
    let path = if path.is_absolute() {
        path
    } else {
        cwd.join(path)
    };
    let metadata = fs::metadata(&path).map_err(|error| {
        format!(
            "La session Prime Agent {} est inaccessible: {error}",
            path.display()
        )
    })?;
    if !metadata.is_file() {
        return Err(format!(
            "La session {} doit être un fichier régulier",
            path.display()
        ));
    }
    canonicalize(&path)
        .map(Some)
        .map_err(|error| format!("Impossible de résoudre {}: {error}", path.display()))
}

fn same_session_path(left: &str, right: &Path) -> bool {
    let right = right.to_string_lossy();
    #[cfg(windows)]
    {
        left.eq_ignore_ascii_case(right.as_ref())
    }
    #[cfg(not(windows))]
    {
        left == right
    }
}

fn ensure_session_is_not_open_under_another_id(
    agents: &HashMap<String, RunningAgent>,
    conversation_id: &str,
    session_path: Option<&Path>,
) -> Result<(), String> {
    let Some(session_path) = session_path else {
        return Ok(());
    };
    let conflict = conflicting_session_conversation(
        agents.values().map(|agent| &agent.info),
        conversation_id,
        session_path,
    );
    if let Some(conflict_id) = conflict {
        return Err(format!(
            "Cette session Prime Agent est déjà ouverte par la conversation {}. Ouvrez cette conversation au lieu de démarrer un second client.",
            conflict_id
        ));
    }
    Ok(())
}

fn conflicting_session_conversation<'a>(
    agents: impl Iterator<Item = &'a RunningAgentInfo>,
    conversation_id: &str,
    session_path: &Path,
) -> Option<&'a str> {
    agents
        .filter(|agent| agent.conversation_id != conversation_id)
        .find(|agent| {
            agent
                .session_path
                .as_deref()
                .is_some_and(|path| same_session_path(path, session_path))
        })
        .map(|agent| agent.conversation_id.as_str())
}

fn emit_line(app: &AppHandle, event_name: &str, conversation_id: &str, line: String) {
    let _ = app.emit(
        event_name,
        AgentLineEvent {
            conversation_id: conversation_id.to_string(),
            line,
        },
    );
}

fn is_extension_ui_request(record: &[u8]) -> bool {
    serde_json::from_slice::<Value>(record)
        .ok()
        .and_then(|event| {
            event
                .get("type")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .as_deref()
        == Some("extension_ui_request")
}

fn extension_request_target(
    agents: &AgentsState,
    conversation_id: &str,
    record: &[u8],
) -> Option<Option<String>> {
    is_extension_ui_request(record).then(|| {
        agents
            .0
            .lock()
            .get(conversation_id)
            .and_then(|agent| agent.interactive_owner.clone())
    })
}

fn emit_runtime_line(
    app: &AppHandle,
    event_name: &str,
    conversation_id: &str,
    line: String,
    target: Option<Option<String>>,
) {
    let event = AgentLineEvent {
        conversation_id: conversation_id.to_string(),
        line,
    };
    match target {
        Some(Some(owner)) => {
            let _ = app.emit_to(owner, event_name, event);
        }
        // An interactive request without a surviving owner must not be
        // broadcast to unrelated windows, where it could be answered twice.
        Some(None) => {}
        None => {
            let _ = app.emit(event_name, event);
        }
    }
}

fn metadata_value(attachments: Vec<PublicAttachmentMetadata>) -> Value {
    serde_json::to_value(attachments).unwrap_or_else(|_| Value::Array(Vec::new()))
}

fn sanitize_queue_lane(value: &mut Value) -> Vec<Value> {
    let Some(messages) = value.as_array_mut() else {
        return Vec::new();
    };
    messages
        .iter_mut()
        .map(|message| {
            let Some(raw) = message.as_str() else {
                sanitize_orbit_runtime_value(message);
                return Value::Array(Vec::new());
            };
            let Some(context) = parse_orbit_attachment_context(raw) else {
                return Value::Array(Vec::new());
            };
            *message = Value::String(context.visible_text);
            metadata_value(context.attachments)
        })
        .collect()
}

fn strip_orbit_string(text: &mut String) -> Vec<PublicAttachmentMetadata> {
    let Some(context) = parse_orbit_attachment_context(text) else {
        return Vec::new();
    };
    *text = context.visible_text;
    context.attachments
}

fn sanitize_user_text_content(value: &mut Value) -> Vec<PublicAttachmentMetadata> {
    match value {
        Value::String(text) => strip_orbit_string(text),
        Value::Array(blocks) => blocks
            .iter_mut()
            .flat_map(sanitize_user_text_block)
            .collect(),
        Value::Object(_) => sanitize_user_text_block(value),
        _ => Vec::new(),
    }
}

fn sanitize_user_text_block(value: &mut Value) -> Vec<PublicAttachmentMetadata> {
    if let Value::String(text) = value {
        return strip_orbit_string(text);
    }
    let Value::Object(block) = value else {
        sanitize_orbit_runtime_value(value);
        return Vec::new();
    };
    block.remove("primeOrbitAttachments");
    block.remove("queueAttachments");
    let is_text_block = matches!(
        block.get("type").and_then(Value::as_str),
        None | Some("text" | "input_text" | "output_text")
    );
    let text_key = is_text_block
        .then(|| {
            ["text", "content"]
                .into_iter()
                .find(|key| block.get(*key).is_some_and(Value::is_string))
        })
        .flatten();
    let attachments = text_key
        .and_then(|key| block.get_mut(key))
        .and_then(|value| match value {
            Value::String(text) => Some(text),
            _ => None,
        })
        .map(strip_orbit_string)
        .unwrap_or_default();
    let keys = block.keys().cloned().collect::<Vec<_>>();
    for key in keys {
        if text_key == Some(key.as_str()) {
            continue;
        }
        if let Some(value) = block.get_mut(&key) {
            sanitize_orbit_runtime_value(value);
        }
    }
    attachments
}

fn sanitize_session_actions(object: &mut Map<String, Value>) {
    object.remove("primeOrbitAttachments");
    object.remove("queueAttachments");
    let steering = object
        .get_mut("steering")
        .map(sanitize_queue_lane)
        .unwrap_or_default();
    let follow_ups = object
        .get_mut("followUps")
        .map(sanitize_queue_lane)
        .unwrap_or_default();
    let active = object
        .get_mut("active")
        .and_then(Value::as_object_mut)
        .and_then(|active| {
            active.remove("primeOrbitAttachments");
            active.remove("queueAttachments");
            let parsed = active.get_mut("label").and_then(|label| {
                let raw = label.as_str()?;
                let context = parse_orbit_attachment_context(raw)?;
                *label = Value::String(context.visible_text);
                Some(metadata_value(context.attachments))
            });
            for (key, value) in active.iter_mut() {
                if key != "label" {
                    sanitize_orbit_runtime_value(value);
                }
            }
            parsed
        });
    for (key, value) in object.iter_mut() {
        if !matches!(key.as_str(), "steering" | "followUps" | "active") {
            sanitize_orbit_runtime_value(value);
        }
    }
    let has_metadata = steering.iter().any(|value| {
        value
            .as_array()
            .is_some_and(|attachments| !attachments.is_empty())
    }) || follow_ups.iter().any(|value| {
        value
            .as_array()
            .is_some_and(|attachments| !attachments.is_empty())
    }) || active.as_ref().is_some_and(|value| {
        value
            .as_array()
            .is_some_and(|attachments| !attachments.is_empty())
    });
    if has_metadata {
        let mut queue_attachments = Map::new();
        queue_attachments.insert("steering".to_string(), Value::Array(steering));
        queue_attachments.insert("followUps".to_string(), Value::Array(follow_ups));
        if let Some(active) = active {
            queue_attachments.insert("active".to_string(), active);
        }
        object.insert(
            "queueAttachments".to_string(),
            Value::Object(queue_attachments),
        );
    } else {
        object.remove("queueAttachments");
    }
}

/// Removes Orbit's private prompt suffix before a daemon record can cross the
/// native/WebView boundary. Metadata is anchored next to semantic message
/// objects so the UI can reconstruct attachment cards without receiving file
/// contents, handles, or native paths.
fn sanitize_orbit_runtime_value(value: &mut Value) {
    match value {
        Value::String(text) => {
            // Outside an authenticated user-message or queue position, Orbit
            // contexts are display data only. Strip their private suffix but
            // never promote an assistant/tool-authored manifest to a trusted
            // attachment sidecar.
            let _ = strip_orbit_string(text);
        }
        Value::Array(values) => values.iter_mut().for_each(sanitize_orbit_runtime_value),
        Value::Object(object) => {
            // These names are reserved for metadata reconstructed from a
            // strictly parsed Orbit suffix. Never trust similarly named
            // fields arriving from the daemon or a session/tool payload.
            object.remove("primeOrbitAttachments");
            object.remove("queueAttachments");
            if let Some(actions) = object
                .get_mut("sessionActions")
                .and_then(Value::as_object_mut)
            {
                sanitize_session_actions(actions);
            }
            let is_user_message = object.get("role").and_then(Value::as_str) == Some("user");
            let keys = object.keys().cloned().collect::<Vec<_>>();
            let mut attachments = Vec::new();
            for key in keys {
                // `sanitize_session_actions` already recursively sanitized the
                // action payload and installed its trusted, lane-aligned
                // sidecar. Do not remove it on a second traversal.
                if key == "sessionActions" {
                    continue;
                }
                if let Some(value) = object.get_mut(&key) {
                    if is_user_message && matches!(key.as_str(), "content" | "text") {
                        attachments.extend(sanitize_user_text_content(value));
                    } else {
                        sanitize_orbit_runtime_value(value);
                    }
                }
            }
            if is_user_message && !attachments.is_empty() {
                object.insert(
                    "primeOrbitAttachments".to_string(),
                    metadata_value(attachments),
                );
            }
        }
        _ => {}
    }
}

fn public_runtime_line(record: &[u8]) -> String {
    let Ok(mut event) = serde_json::from_slice::<Value>(record) else {
        let line = String::from_utf8_lossy(record).into_owned();
        return if line.contains("<prime_orbit_attachment_context")
            || line.contains("<prime_orbit_ui_boundary")
        {
            "[Contexte privé de pièce jointe masqué par Prime Orbit]".to_string()
        } else {
            line
        };
    };
    sanitize_orbit_runtime_value(&mut event);
    serde_json::to_string(&event)
        .unwrap_or_else(|_| "{\"type\":\"orbit_sanitization_error\"}".to_string())
}

fn append_diagnostic_tail(target: &Mutex<String>, line: &str) {
    let mut target = target.lock();
    if !target.is_empty() {
        target.push('\n');
    }
    target.push_str(line);
    if target.len() <= MAX_EXIT_DIAGNOSTIC_BYTES {
        return;
    }

    let mut keep_from = target.len() - MAX_EXIT_DIAGNOSTIC_BYTES;
    while !target.is_char_boundary(keep_from) {
        keep_from += 1;
    }
    target.drain(..keep_from);
}

fn stream_records<R: Read>(
    reader: R,
    app: AppHandle,
    event_name: &'static str,
    conversation_id: String,
    runtime_identity: Option<(AgentsState, u32)>,
    apply_runtime_state: bool,
    diagnostic_tail: Option<Arc<Mutex<String>>>,
) {
    let mut reader = BufReader::new(reader);
    let mut record = Vec::new();
    loop {
        record.clear();
        match reader.read_until(b'\n', &mut record) {
            Ok(0) => break,
            Ok(_) => {
                if record.last() == Some(&b'\n') {
                    record.pop();
                }
                if record.last() == Some(&b'\r') {
                    record.pop();
                }
                if let Some((agents, pid)) = runtime_identity.as_ref() {
                    if !is_current_agent_process(agents, &conversation_id, *pid) {
                        continue;
                    }
                    if apply_runtime_state {
                        apply_runtime_record(agents, &conversation_id, *pid, &record);
                    }
                }
                let line = public_runtime_line(&record);
                if let Some(diagnostic_tail) = diagnostic_tail.as_ref() {
                    append_diagnostic_tail(diagnostic_tail, &line);
                }
                let target = runtime_identity.as_ref().and_then(|(agents, _)| {
                    extension_request_target(agents, &conversation_id, &record)
                });
                emit_runtime_line(&app, event_name, &conversation_id, line, target);
            }
            Err(error) => {
                let line = format!("Erreur de lecture du processus Prime Agent: {error}");
                if let Some(diagnostic_tail) = diagnostic_tail.as_ref() {
                    append_diagnostic_tail(diagnostic_tail, &line);
                }
                emit_line(&app, "prime-agent://stderr", &conversation_id, line);
                break;
            }
        }
    }
}

fn runtime_busy_state(record: &[u8]) -> Option<bool> {
    let event: Value = serde_json::from_slice(record).ok()?;
    match event.get("type").and_then(Value::as_str) {
        Some("agent_start" | "auto_retry_start") => Some(true),
        Some("agent_end" | "turn_error") => Some(false),
        Some("auto_retry_end") if event.get("success").and_then(Value::as_bool) == Some(false) => {
            Some(false)
        }
        Some("response")
            if event.get("command").and_then(Value::as_str) == Some("prompt")
                && event.get("success").and_then(Value::as_bool) == Some(false) =>
        {
            Some(false)
        }
        Some("response")
            if matches!(
                event.get("command").and_then(Value::as_str),
                Some("compact" | "refine")
            ) =>
        {
            Some(false)
        }
        Some("response")
            if event.get("command").and_then(Value::as_str) == Some("get_state")
                && event.get("success").and_then(Value::as_bool) != Some(false) =>
        {
            event
                .get("data")
                .and_then(|data| data.get("isStreaming"))
                .and_then(Value::as_bool)
        }
        _ => None,
    }
}

fn runtime_session_state(record: &[u8]) -> Option<(Option<String>, Option<String>)> {
    let event: Value = serde_json::from_slice(record).ok()?;
    if event.get("type").and_then(Value::as_str) != Some("response")
        || event.get("command").and_then(Value::as_str) != Some("get_state")
        || event.get("success").and_then(Value::as_bool) == Some(false)
    {
        return None;
    }
    let data = event.get("data")?;
    let path = data
        .get("sessionFile")
        .or_else(|| data.get("sessionPath"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let session_id = data
        .get("sessionId")
        .and_then(Value::as_str)
        .map(str::to_string);
    Some((path, session_id))
}

fn runtime_session_path(record: &[u8]) -> Option<String> {
    runtime_session_state(record)?.0
}

fn runtime_session_id(record: &[u8]) -> Option<String> {
    runtime_session_state(record)?.1
}

fn runtime_launch_options(
    record: &[u8],
) -> Option<(Option<String>, Option<String>, Option<String>)> {
    let event: Value = serde_json::from_slice(record).ok()?;
    if event.get("type").and_then(Value::as_str) != Some("response")
        || event.get("command").and_then(Value::as_str) != Some("get_state")
        || event.get("success").and_then(Value::as_bool) == Some(false)
    {
        return None;
    }
    let data = event.get("data")?;
    let model = data.get("model").and_then(Value::as_object);
    let provider = model
        .and_then(|model| model.get("provider"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let model_id = model
        .and_then(|model| model.get("id").or_else(|| model.get("modelId")))
        .and_then(Value::as_str)
        .map(str::to_string);
    let thinking = data
        .get("thinkingLevel")
        .and_then(Value::as_str)
        .map(str::to_string);
    Some((provider, model_id, thinking))
}

fn resolved_runtime_session_path(path: String) -> Option<PathBuf> {
    let path = PathBuf::from(path);
    if let Ok(canonical) = canonicalize(&path) {
        return Some(canonical);
    }
    let parent = canonicalize(path.parent()?).ok()?;
    let filename = path.file_name()?.to_str()?;
    if filename.is_empty()
        || filename.len() > 240
        || filename.chars().any(char::is_control)
        || Path::new(filename)
            .extension()
            .and_then(|value| value.to_str())
            != Some("jsonl")
    {
        return None;
    }
    Some(parent.join(filename))
}

fn is_current_agent_process(agents: &AgentsState, conversation_id: &str, pid: u32) -> bool {
    agents
        .0
        .lock()
        .get(conversation_id)
        .is_some_and(|agent| waiter_may_remove_slot(agent.info.pid, agent.restarting, pid))
}

fn apply_runtime_record(agents: &AgentsState, conversation_id: &str, pid: u32, record: &[u8]) {
    let busy = runtime_busy_state(record);
    let session_path = runtime_session_path(record).and_then(resolved_runtime_session_path);
    let session_id = runtime_session_id(record).filter(|id| {
        !id.is_empty()
            && id.len() <= 160
            && id.chars().all(|character| {
                character.is_ascii_alphanumeric() || matches!(character, '-' | '_')
            })
    });
    let launch_options = runtime_launch_options(record);
    if busy.is_none() && session_path.is_none() && session_id.is_none() && launch_options.is_none()
    {
        return;
    }
    let release_candidate = {
        let mut map = agents.0.lock();
        let Some(agent) = map.get_mut(conversation_id) else {
            return;
        };
        if agent.info.pid != pid {
            return;
        }
        if let Some(busy) = busy {
            agent.busy = busy;
        }
        if let Some(session_path) = session_path {
            agent.info.session_path = Some(session_path.to_string_lossy().into_owned());
        }
        if let Some(session_id) = session_id {
            agent.info.session_id = Some(session_id);
        }
        if let Some((provider, model, thinking)) = launch_options {
            if let Some(provider) = provider {
                agent.info.provider = Some(provider);
            }
            if let Some(model) = model {
                agent.info.model = Some(model);
            }
            if let Some(thinking) = thinking {
                agent.info.thinking = Some(thinking);
            }
        }
        idle_release_candidate(agent)
    };
    if let Some(pid) = release_candidate {
        schedule_idle_release(agents.clone(), conversation_id.to_string(), pid);
    }
}

fn schedule_idle_release(agents: AgentsState, conversation_id: String, pid: u32) {
    thread::spawn(move || {
        // agent_end can be followed immediately by a queued follow-up or an
        // auto-retry. Give those events time to restore `busy` before deciding
        // that this ownerless runtime is truly idle.
        thread::sleep(IDLE_RELEASE_GRACE);
        let agent = {
            let mut map = agents.0.lock();
            let should_release = map
                .get(&conversation_id)
                .map(|agent| agent.info.pid == pid && idle_release_candidate(agent).is_some())
                .unwrap_or(false);
            should_release
                .then(|| map.remove(&conversation_id))
                .flatten()
        };
        if let Some(agent) = agent {
            let _ = terminate_child(&mut agent.child.lock());
        }
    });
}

fn acquire_owner(agent: &mut RunningAgent, owner: String) {
    agent.interactive_owner = Some(owner.clone());
    acquire_owner_lease(&mut agent.owners, &mut agent.release_when_idle, owner);
}

fn agent_has_native_operation(agent: &RunningAgent) -> bool {
    agent.operations.reloading.is_some() || agent.operations.runtime_writes > 0
}

fn idle_release_candidate(agent: &RunningAgent) -> Option<u32> {
    (!agent.busy
        && !agent_has_native_operation(agent)
        && agent.release_when_idle
        && agent.owners.is_empty())
    .then_some(agent.info.pid)
}

fn restart_slot_matches(current_pid: u32, restarting: bool, expected_pid: u32) -> bool {
    current_pid == expected_pid && restarting
}

fn waiter_may_remove_slot(current_pid: u32, restarting: bool, expected_pid: u32) -> bool {
    current_pid == expected_pid && !restarting
}

fn release_owner_lease(agent: &mut RunningAgent, owner: &str) -> bool {
    let operation_busy = agent_has_native_operation(agent);
    release_owner_lease_state(
        &mut agent.owners,
        agent.busy || operation_busy,
        &mut agent.release_when_idle,
        owner,
    )
}

fn acquire_owner_lease(owners: &mut HashSet<String>, release_when_idle: &mut bool, owner: String) {
    owners.insert(owner);
    *release_when_idle = false;
}

fn release_owner_lease_state(
    owners: &mut HashSet<String>,
    busy: bool,
    release_when_idle: &mut bool,
    owner: &str,
) -> bool {
    if !owners.remove(owner) {
        return false;
    }
    if !owners.is_empty() {
        return false;
    }
    *release_when_idle = true;
    if busy {
        return false;
    }
    true
}

fn begin_runtime_write(operations: &mut AgentOperations) -> Result<(), ResourceReloadClaimError> {
    if operations.reloading.is_some() {
        return Err(ResourceReloadClaimError::Reloading);
    }
    operations.runtime_writes = operations
        .runtime_writes
        .checked_add(1)
        .expect("native Prime Agent operation counter overflow");
    Ok(())
}

fn finish_runtime_write(operations: &mut AgentOperations) {
    debug_assert!(operations.runtime_writes > 0);
    operations.runtime_writes = operations.runtime_writes.saturating_sub(1);
}

fn begin_owned_resource_reload(
    owners: &HashSet<String>,
    owner: &str,
    operations: &mut AgentOperations,
) -> Result<u64, ResourceReloadClaimError> {
    if !owners.contains(owner) {
        return Err(ResourceReloadClaimError::NotOwner);
    }
    if operations.reloading.is_some() {
        return Err(ResourceReloadClaimError::Reloading);
    }
    if operations.runtime_writes > 0 {
        return Err(ResourceReloadClaimError::RuntimeWrite);
    }
    let token = operations.next_reload_token.wrapping_add(1).max(1);
    operations.next_reload_token = token;
    operations.reloading = Some(ResourceReloadMarker {
        token,
        phase: ResourceReloadPhase::InFlight,
    });
    Ok(token)
}

fn mark_resource_reload_unknown(operations: &mut AgentOperations, token: u64) -> bool {
    let Some(marker) = operations.reloading.as_mut() else {
        return false;
    };
    if marker.token != token || marker.phase != ResourceReloadPhase::InFlight {
        return false;
    }
    marker.phase = ResourceReloadPhase::Unknown;
    true
}

fn finish_resource_reload(operations: &mut AgentOperations, token: u64) -> bool {
    if operations
        .reloading
        .is_some_and(|marker| marker.token == token)
    {
        operations.reloading = None;
        return true;
    }
    false
}

fn agent_identity_matches(agent: &RunningAgent, pid: u32, started_at: u64) -> bool {
    agent.info.pid == pid && agent.info.started_at == started_at
}

struct RuntimeWriteGuard {
    agents: AgentsState,
    conversation_id: String,
    pid: u32,
    started_at: u64,
    restore_busy_on_error: Option<bool>,
}

impl RuntimeWriteGuard {
    fn new(
        agents: AgentsState,
        conversation_id: String,
        pid: u32,
        started_at: u64,
        restore_busy_on_error: Option<bool>,
    ) -> Self {
        Self {
            agents,
            conversation_id,
            pid,
            started_at,
            restore_busy_on_error,
        }
    }

    fn commit(&mut self) {
        self.restore_busy_on_error = None;
    }
}

impl Drop for RuntimeWriteGuard {
    fn drop(&mut self) {
        let release_candidate = {
            let mut map = self.agents.0.lock();
            let Some(agent) = map
                .get_mut(&self.conversation_id)
                .filter(|agent| agent_identity_matches(agent, self.pid, self.started_at))
            else {
                return;
            };
            if let Some(previous_busy) = self.restore_busy_on_error {
                agent.busy = previous_busy;
            }
            finish_runtime_write(&mut agent.operations);
            idle_release_candidate(agent)
        };
        if let Some(pid) = release_candidate {
            schedule_idle_release(self.agents.clone(), self.conversation_id.clone(), pid);
        }
    }
}

struct ResourceReloadGuard {
    agents: AgentsState,
    conversation_id: String,
    pid: u32,
    started_at: u64,
    token: u64,
    clear_on_drop: bool,
}

impl ResourceReloadGuard {
    fn new(
        agents: AgentsState,
        conversation_id: String,
        pid: u32,
        started_at: u64,
        token: u64,
    ) -> Self {
        Self {
            agents,
            conversation_id,
            pid,
            started_at,
            token,
            clear_on_drop: true,
        }
    }

    fn complete_and_broadcast(mut self, app: &AppHandle) -> Result<(), String> {
        let release_candidate = {
            let mut map = self.agents.0.lock();
            let Some(agent) = map
                .get_mut(&self.conversation_id)
                .filter(|agent| agent_identity_matches(agent, self.pid, self.started_at))
            else {
                return Err(
                    "La conversation a été arrêtée avant la confirmation du rechargement."
                        .to_string(),
                );
            };
            let exact_claim = agent.operations.reloading.is_some_and(|marker| {
                marker.token == self.token && marker.phase == ResourceReloadPhase::InFlight
            });
            if !exact_claim {
                return Err(
                    "L’état de la conversation a changé pendant le rechargement.".to_string(),
                );
            }
            // The event and fence release are linearized under the native slot
            // lock. stop/start/restart cannot invalidate the session between a
            // successful daemon acknowledgement and this global broadcast.
            let _ = app.emit(
                "prime-agent://resources-reloaded",
                AgentResourcesReloadedEvent {
                    conversation_id: self.conversation_id.clone(),
                },
            );
            finish_resource_reload(&mut agent.operations, self.token);
            idle_release_candidate(agent)
        };
        self.clear_on_drop = false;
        if let Some(pid) = release_candidate {
            schedule_idle_release(self.agents.clone(), self.conversation_id.clone(), pid);
        }
        Ok(())
    }

    fn retain_unknown(mut self) {
        let marked = {
            let mut map = self.agents.0.lock();
            map.get_mut(&self.conversation_id)
                .filter(|agent| agent_identity_matches(agent, self.pid, self.started_at))
                .is_some_and(|agent| {
                    mark_resource_reload_unknown(&mut agent.operations, self.token)
                })
        };
        if marked {
            self.clear_on_drop = false;
            schedule_unknown_reload_release(
                self.agents.clone(),
                self.conversation_id.clone(),
                self.pid,
                self.started_at,
                self.token,
            );
        }
    }
}

impl Drop for ResourceReloadGuard {
    fn drop(&mut self) {
        if !self.clear_on_drop {
            return;
        }
        let release_candidate = {
            let mut map = self.agents.0.lock();
            let Some(agent) = map
                .get_mut(&self.conversation_id)
                .filter(|agent| agent_identity_matches(agent, self.pid, self.started_at))
            else {
                return;
            };
            finish_resource_reload(&mut agent.operations, self.token);
            idle_release_candidate(agent)
        };
        if let Some(pid) = release_candidate {
            schedule_idle_release(self.agents.clone(), self.conversation_id.clone(), pid);
        }
    }
}

fn schedule_unknown_reload_release(
    agents: AgentsState,
    conversation_id: String,
    pid: u32,
    started_at: u64,
    token: u64,
) {
    thread::spawn(move || {
        thread::sleep(RELOAD_UNKNOWN_GRACE);
        let release_candidate = {
            let mut map = agents.0.lock();
            let Some(agent) = map
                .get_mut(&conversation_id)
                .filter(|agent| agent_identity_matches(agent, pid, started_at))
            else {
                return;
            };
            let matches_unknown = agent.operations.reloading.is_some_and(|marker| {
                marker.token == token && marker.phase == ResourceReloadPhase::Unknown
            });
            if !matches_unknown {
                return;
            }
            finish_resource_reload(&mut agent.operations, token);
            idle_release_candidate(agent)
        };
        if let Some(pid) = release_candidate {
            schedule_idle_release(agents, conversation_id, pid);
        }
    });
}

fn emit_exit_once(
    app: &AppHandle,
    conversation_id: &str,
    exit_emitted: &AtomicBool,
    status: Result<ExitStatus, String>,
    diagnostic: Option<String>,
) {
    if exit_emitted.swap(true, Ordering::SeqCst) {
        return;
    }
    let event = match status {
        Ok(status) => {
            let success = status.success();
            AgentExitEvent {
                conversation_id: conversation_id.to_string(),
                code: status.code(),
                success,
                error: (!success).then_some(diagnostic).flatten(),
            }
        }
        Err(error) => AgentExitEvent {
            conversation_id: conversation_id.to_string(),
            code: None,
            success: false,
            error: Some(match diagnostic {
                Some(diagnostic) if !diagnostic.trim().is_empty() && diagnostic.trim() != error => {
                    format!("{error}\n\n{diagnostic}")
                }
                _ => error,
            }),
        },
    };
    let _ = app.emit("prime-agent://exit", event);
}

fn terminate_child(child: &mut Child) -> Result<ExitStatus, String> {
    if let Some(status) = child
        .try_wait()
        .map_err(|error| format!("Impossible d’inspecter Prime Agent: {error}"))?
    {
        return Ok(status);
    }

    #[cfg(windows)]
    {
        use crate::runtime::{capture_command_output, external_command, find_program};
        use std::ffi::OsString;

        if let Some(taskkill) = find_program("taskkill") {
            let arguments = [
                OsString::from("/PID"),
                OsString::from(child.id().to_string()),
                OsString::from("/T"),
                OsString::from("/F"),
            ];
            let mut command = external_command(&taskkill, &arguments);
            if let Ok(output) = capture_command_output(&mut command) {
                if output.status.success() {
                    return child.wait().map_err(|error| {
                        format!("Impossible de finaliser l’arrêt de Prime Agent: {error}")
                    });
                }
            }
        }
    }

    child
        .kill()
        .map_err(|error| format!("Impossible d’arrêter Prime Agent: {error}"))?;
    child
        .wait()
        .map_err(|error| format!("Impossible de finaliser l’arrêt: {error}"))
}

/// Emergency restart first kills only Orbit's RPC client. Prime Agent's
/// daemon can be shared by other conversations, so a process-tree kill is a
/// last resort rather than the default. `terminate_child` supplies that
/// Windows `/T /F` fallback when the direct termination cannot be performed.
fn terminate_rpc_client_for_restart(child: &mut Child) -> Result<ExitStatus, String> {
    if let Some(status) = child
        .try_wait()
        .map_err(|error| format!("Impossible d’inspecter Prime Agent: {error}"))?
    {
        return Ok(status);
    }
    match child.kill() {
        Ok(()) => child.wait().map_err(|error| {
            format!("Impossible de finaliser l’arrêt du client Prime Agent: {error}")
        }),
        Err(_) => terminate_child(child),
    }
}

fn wait_for_child_until(
    child: &Arc<Mutex<Child>>,
    timeout: Duration,
) -> Result<Option<ExitStatus>, String> {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(status) = child
            .lock()
            .try_wait()
            .map_err(|error| format!("Impossible d’attendre la fin de Prime Agent: {error}"))?
        {
            return Ok(Some(status));
        }
        if Instant::now() >= deadline {
            return Ok(None);
        }
        thread::sleep(Duration::from_millis(25));
    }
}

fn close_rpc_stdin_for_restart(stdin: &Arc<Mutex<Option<ChildStdin>>>) -> Result<(), String> {
    let Some(mut stdin) = stdin.lock().take() else {
        return Ok(());
    };
    // Ask all independently abortable work to stop before EOF. RPC mode
    // drains these input handlers, waits for idle, then dispose() sends the
    // daemon's complete_owned_session command before the process exits.
    let commands = concat!(
        "{\"id\":\"prime-orbit-restart-abort\",\"type\":\"abort\"}\n",
        "{\"id\":\"prime-orbit-restart-abort-bash\",\"type\":\"abort_bash\"}\n",
        "{\"id\":\"prime-orbit-restart-abort-retry\",\"type\":\"abort_retry\"}\n"
    );
    let write_result = stdin
        .write_all(commands.as_bytes())
        .and_then(|_| stdin.flush())
        .map_err(|error| {
            format!("Impossible de demander l’arrêt gracieux de Prime Agent: {error}")
        });
    // Dropping the only retained ChildStdin is the protocol's graceful EOF.
    drop(stdin);
    write_result
}

fn wait_for_forced_session_release(
    app: &AppHandle,
    session_path: &Path,
    cwd: &Path,
) -> Result<(), String> {
    let deadline = Instant::now() + RESTART_LEASE_RELEASE_TIMEOUT;
    let mut last_inspection_error = None;
    loop {
        // Reclaim only after the lease implementation proves its recorded
        // process owner is dead. A live daemon worker is always left intact.
        let reclaim_inspection_succeeded = match reclaim_stale_session_lease(app, session_path, cwd)
        {
            Ok(_) => true,
            // A live `.guard` is expected while the daemon is completing an
            // owned session. Treat inspection failures as uncertainty and
            // keep waiting; never turn them into permission to relaunch.
            Err(error) => {
                last_inspection_error = Some(error);
                false
            }
        };
        // A missing lock is authoritative only while holding/proving the same
        // lease guard in this iteration. If guard acquisition failed, another
        // process may be between guard acquisition and lock publication.
        if reclaim_inspection_succeeded {
            match session_lease_exists(app, session_path, cwd) {
                Ok(lease_exists)
                    if lease_absence_attests_release(
                        reclaim_inspection_succeeded,
                        lease_exists,
                    ) =>
                {
                    return Ok(())
                }
                Ok(_) => {}
                Err(error) => last_inspection_error = Some(error),
            }
        }
        if Instant::now() >= deadline {
            let details = last_inspection_error
                .map(|error| format!(" Dernière vérification: {error}"))
                .unwrap_or_default();
            return Err(format!(
                "Le worker Prime Agent n’a pas libéré la session {} dans le délai de {} secondes. Aucun second client n’a été lancé.{details}",
                session_path.display(),
                RESTART_LEASE_RELEASE_TIMEOUT.as_secs()
            ));
        }
        thread::sleep(RESTART_RELEASE_POLL_INTERVAL);
    }
}

fn lease_absence_attests_release(reclaim_inspection_succeeded: bool, lease_exists: bool) -> bool {
    reclaim_inspection_succeeded && !lease_exists
}

fn stop_rpc_client_for_restart(
    app: &AppHandle,
    child: &Arc<Mutex<Child>>,
    stdin: &Arc<Mutex<Option<ChildStdin>>>,
    session_path: Option<&Path>,
    cwd: &Path,
) -> Result<(), String> {
    let session_path = session_path.ok_or_else(|| {
        "Prime Agent n’a pas encore publié son fichier de session. Le client reste actif car sa libération ne pourrait pas être attestée; resynchronisez son état puis réessayez."
            .to_string()
    })?;
    let graceful_request_error = close_rpc_stdin_for_restart(stdin).err();
    if wait_for_child_until(child, RESTART_GRACEFUL_EXIT_TIMEOUT)?.is_some() {
        // RPC shutdown intentionally catches a failed
        // `complete_owned_session` request before exiting. Even exit code 0
        // is therefore not sufficient proof by itself: the exact lease must
        // be gone (or safely reclaimable from a dead owner) before resume.
    } else {
        terminate_rpc_client_for_restart(&mut child.lock())?;
    }

    wait_for_forced_session_release(app, session_path, cwd).map_err(|error| {
        graceful_request_error
            .map(|graceful| format!("{graceful}\n\n{error}"))
            .unwrap_or(error)
    })
}

fn request_runtime_state_after_restart(
    stdin: &Arc<Mutex<Option<ChildStdin>>>,
    pid: u32,
) -> Result<(), String> {
    let request = serde_json::to_vec(&serde_json::json!({
        "id": format!("prime-orbit-native-restart-state-{pid}"),
        "type": "get_state",
    }))
    .map_err(|error| format!("Impossible de préparer l’état post-redémarrage: {error}"))?;
    let mut guard = stdin.lock();
    let stdin = guard.as_mut().ok_or_else(|| {
        "Le nouveau client Prime Agent a fermé son canal RPC avant sa vérification.".to_string()
    })?;
    stdin
        .write_all(&request)
        .and_then(|_| stdin.write_all(b"\n"))
        .and_then(|_| stdin.flush())
        .map_err(|error| format!("Impossible de vérifier le nouveau client Prime Agent: {error}"))
}

fn wait_for_child(child: &Arc<Mutex<Child>>) -> Result<ExitStatus, String> {
    loop {
        let status = child
            .lock()
            .try_wait()
            .map_err(|error| format!("Impossible d’attendre la fin de Prime Agent: {error}"))?;
        if let Some(status) = status {
            return Ok(status);
        }
        // Never keep the child mutex while waiting. `stop_agent` and app
        // shutdown must be able to acquire it promptly to terminate the
        // process, even if the agent closes stdout before it exits.
        thread::sleep(Duration::from_millis(25));
    }
}

fn rpc_launch_arguments(
    session_path: Option<&Path>,
    provider: Option<&str>,
    model: Option<&str>,
    thinking: Option<&str>,
) -> Vec<OsString> {
    let mut arguments = vec![OsString::from("--mode"), OsString::from("rpc")];
    if let Some(path) = session_path {
        arguments.push(OsString::from("--resume"));
        arguments.push(path.as_os_str().to_owned());
    }
    if let Some(value) = provider {
        arguments.push(OsString::from("--provider"));
        arguments.push(OsString::from(value));
    }
    if let Some(value) = model {
        arguments.push(OsString::from("--model"));
        arguments.push(OsString::from(value));
    }
    if let Some(value) = thinking {
        arguments.push(OsString::from("--thinking"));
        arguments.push(OsString::from(value));
    }
    arguments
}

#[allow(clippy::too_many_arguments)]
fn spawn_rpc_agent(
    app: &AppHandle,
    conversation_id: &str,
    cwd: &Path,
    session_path: Option<&Path>,
    session_id: Option<String>,
    provider: Option<String>,
    model: Option<String>,
    thinking: Option<String>,
    launch_spec: &LaunchSpec,
) -> Result<SpawnedRpcAgent, String> {
    let arguments = rpc_launch_arguments(
        session_path,
        provider.as_deref(),
        model.as_deref(),
        thinking.as_deref(),
    );

    let mut command = launch_spec.command(&arguments);
    #[cfg(windows)]
    if matches!(launch_spec, LaunchSpec::Source { .. }) {
        crate::node_compat::configure_source_rpc(app, &mut command)?;
    }
    command
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = command
        .spawn()
        .map_err(|error| format!("Impossible de démarrer Prime Agent: {error}"))?;
    let pid = child.id();
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Prime Agent n’a pas fourni de canal stdin".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Prime Agent n’a pas fourni de canal stdout".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Prime Agent n’a pas fourni de canal stderr".to_string())?;

    Ok(SpawnedRpcAgent {
        info: RunningAgentInfo {
            conversation_id: conversation_id.to_string(),
            pid,
            cwd: cwd.to_string_lossy().into_owned(),
            session_path: session_path.map(|path| path.to_string_lossy().into_owned()),
            session_id,
            provider,
            model,
            thinking,
            started_at: now_millis(),
        },
        child: Arc::new(Mutex::new(child)),
        stdin: Arc::new(Mutex::new(Some(stdin))),
        stdout,
        stderr,
        exit_emitted: Arc::new(AtomicBool::new(false)),
    })
}

fn spawn_agent_io_threads(
    app: AppHandle,
    agents: AgentsState,
    conversation_id: String,
    spawned: SpawnedRpcAgent,
) {
    let pid = spawned.info.pid;
    let child = Arc::clone(&spawned.child);
    let exit_emitted = Arc::clone(&spawned.exit_emitted);

    let stdout_app = app.clone();
    let stdout_conversation_id = conversation_id.clone();
    let stdout_agents = agents.clone();
    thread::spawn(move || {
        stream_records(
            spawned.stdout,
            stdout_app,
            "prime-agent://event",
            stdout_conversation_id,
            Some((stdout_agents, pid)),
            true,
            None,
        );
    });

    let exit_diagnostic = Arc::new(Mutex::new(String::new()));
    let (stderr_done_tx, stderr_done_rx) = mpsc::sync_channel(1);
    let stderr_app = app.clone();
    let stderr_conversation_id = conversation_id.clone();
    let stderr_exit_diagnostic = Arc::clone(&exit_diagnostic);
    let stderr_agents = agents.clone();
    thread::spawn(move || {
        stream_records(
            spawned.stderr,
            stderr_app,
            "prime-agent://stderr",
            stderr_conversation_id,
            Some((stderr_agents, pid)),
            false,
            Some(stderr_exit_diagnostic),
        );
        let _ = stderr_done_tx.send(());
    });

    let wait_app = app.clone();
    let wait_conversation_id = conversation_id;
    thread::spawn(move || {
        let status = wait_for_child(&child);
        let _ = stderr_done_rx.recv_timeout(STDERR_DRAIN_GRACE);
        let diagnostic = {
            let diagnostic = exit_diagnostic.lock();
            (!diagnostic.trim().is_empty()).then(|| diagnostic.clone())
        };
        {
            let wait_state = wait_app.state::<AgentsState>();
            let mut map = wait_state.0.lock();
            if map
                .get(&wait_conversation_id)
                .map(|agent| waiter_may_remove_slot(agent.info.pid, agent.restarting, pid))
                .unwrap_or(false)
            {
                map.remove(&wait_conversation_id);
            }
        }
        emit_exit_once(
            &wait_app,
            &wait_conversation_id,
            &exit_emitted,
            status,
            diagnostic,
        );
    });
}

#[allow(clippy::too_many_arguments)]
fn start_agent_blocking(
    app: AppHandle,
    agents: AgentsState,
    owner: String,
    conversation_id: String,
    cwd: String,
    session_path: Option<String>,
    provider: Option<String>,
    model: Option<String>,
    thinking: Option<String>,
) -> Result<RunningAgentInfo, String> {
    let conversation_id = validated_identifier(conversation_id)?;
    if let Some(existing) = agents.0.lock().get_mut(&conversation_id) {
        if existing.restarting {
            return Err("Le redémarrage de cette conversation est déjà en cours.".to_string());
        }
        if existing.operations.reloading.is_some() {
            return Err(
                "Les ressources de cette conversation sont en cours de rechargement. Réessayez après la fin de l’opération."
                    .to_string(),
            );
        }
        acquire_owner(existing, owner);
        return Ok(existing.info.clone());
    }
    let cwd = validated_cwd(cwd)?;
    let session_path = validated_session_path(&cwd, session_path)?;
    {
        let map = agents.0.lock();
        ensure_session_is_not_open_under_another_id(
            &map,
            &conversation_id,
            session_path.as_deref(),
        )?;
    }
    if let Some(session_path) = session_path.as_deref() {
        reclaim_stale_session_lease(&app, session_path, &cwd)?;
    }
    let provider = validated_option(provider, "provider", 256)?;
    let model = validated_option(model, "model", 512)?;
    let thinking = validated_option(thinking, "thinking", 32)?;
    if let Some(level) = thinking.as_deref() {
        if !is_valid_thinking_level(level) {
            return Err(format!(
                "Niveau de réflexion inconnu: {level}. Valeurs: off, minimal, low, medium, high, xhigh, max"
            ));
        }
    }

    let (detection, launch_spec) = detect_internal(&app)?;
    let launch_spec = launch_spec.ok_or_else(|| {
        let details = if detection.warnings.is_empty() {
            String::new()
        } else {
            format!(" ({})", detection.warnings.join("; "))
        };
        format!(
            "Prime Agent est introuvable. Lancez l’installation rapide ou configurez son runtime{details}"
        )
    })?;

    let mut map = agents.0.lock();
    if let Some(existing) = map.get_mut(&conversation_id) {
        if existing.restarting {
            return Err("Le redémarrage de cette conversation est déjà en cours.".to_string());
        }
        if existing.operations.reloading.is_some() {
            return Err(
                "Les ressources de cette conversation sont en cours de rechargement. Réessayez après la fin de l’opération."
                    .to_string(),
            );
        }
        acquire_owner(existing, owner);
        return Ok(existing.info.clone());
    }
    ensure_session_is_not_open_under_another_id(&map, &conversation_id, session_path.as_deref())?;
    let spawned = spawn_rpc_agent(
        &app,
        &conversation_id,
        &cwd,
        session_path.as_deref(),
        None,
        provider,
        model,
        thinking,
        &launch_spec,
    )?;
    let info = spawned.info.clone();
    map.insert(
        conversation_id.clone(),
        RunningAgent {
            info: info.clone(),
            launch_spec,
            child: Arc::clone(&spawned.child),
            stdin: Arc::clone(&spawned.stdin),
            exit_emitted: Arc::clone(&spawned.exit_emitted),
            owners: HashSet::from([owner.clone()]),
            interactive_owner: Some(owner),
            // A resumed daemon session may already be working. Treat startup
            // as busy until get_state proves otherwise, so a fast navigation
            // cannot accidentally terminate live work.
            busy: true,
            release_when_idle: false,
            restarting: false,
            operations: AgentOperations::default(),
        },
    );
    drop(map);
    spawn_agent_io_threads(app, agents, conversation_id, spawned);

    Ok(info)
}

fn release_agent_blocking(
    agents: AgentsState,
    owner: String,
    conversation_id: String,
) -> Result<bool, String> {
    let conversation_id = validated_identifier(conversation_id)?;
    let release_candidate = {
        let mut map = agents.0.lock();
        map.get_mut(&conversation_id).and_then(|agent| {
            let release = release_owner_lease(agent, &owner);
            if agent.interactive_owner.as_deref() == Some(owner.as_str())
                && !agent.owners.is_empty()
            {
                agent.interactive_owner = agent.owners.iter().min().cloned();
            }
            release.then_some(agent.info.pid)
        })
    };
    if let Some(pid) = release_candidate {
        schedule_idle_release(agents, conversation_id, pid);
        return Ok(true);
    }
    Ok(false)
}

fn release_owner_blocking(agents: AgentsState, owner: &str) {
    let release_candidates = {
        let mut map = agents.0.lock();
        map.iter_mut()
            .filter_map(|(conversation_id, agent)| {
                let release = release_owner_lease(agent, owner);
                if agent.interactive_owner.as_deref() == Some(owner) {
                    agent.interactive_owner = agent.owners.iter().min().cloned();
                }
                release.then(|| (conversation_id.clone(), agent.info.pid))
            })
            .collect::<Vec<_>>()
    };
    for (conversation_id, pid) in release_candidates {
        schedule_idle_release(agents.clone(), conversation_id, pid);
    }
}

fn owner_may_send(
    owners: &HashSet<String>,
    interactive_owner: Option<&str>,
    owner: &str,
    payload_type: Option<&str>,
) -> bool {
    owners.contains(owner)
        || (payload_type == Some("extension_ui_response") && interactive_owner == Some(owner))
}

enum LaunchOptionUpdate {
    Model { provider: String, model: String },
    Thinking(String),
}

fn requested_launch_option_update(payload: &Value) -> Option<LaunchOptionUpdate> {
    match payload.get("type").and_then(Value::as_str)? {
        "set_model" => Some(LaunchOptionUpdate::Model {
            provider: validated_option(
                payload.get("provider")?.as_str().map(str::to_string),
                "provider",
                256,
            )
            .ok()??,
            model: validated_option(
                payload.get("modelId")?.as_str().map(str::to_string),
                "model",
                512,
            )
            .ok()??,
        }),
        "set_thinking_level" => {
            let thinking = validated_option(
                payload.get("level")?.as_str().map(str::to_string),
                "thinking",
                32,
            )
            .ok()??;
            is_valid_thinking_level(&thinking).then_some(LaunchOptionUpdate::Thinking(thinking))
        }
        _ => None,
    }
}

fn apply_launch_option_update(agent: &mut RunningAgentInfo, update: LaunchOptionUpdate) {
    match update {
        LaunchOptionUpdate::Model { provider, model } => {
            agent.provider = Some(provider);
            agent.model = Some(model);
        }
        LaunchOptionUpdate::Thinking(thinking) => agent.thinking = Some(thinking),
    }
}

fn rpc_starts_busy_operation(payload_type: Option<&str>) -> bool {
    matches!(payload_type, Some("prompt" | "compact" | "refine"))
}

fn send_rpc_blocking(
    agents: AgentsState,
    attachments: AttachmentCache,
    owner: String,
    conversation_id: String,
    app_data_dir: PathBuf,
    mut payload: Value,
) -> Result<(), String> {
    let conversation_id = validated_identifier(conversation_id)?;
    if !payload.is_object() {
        return Err("Le payload RPC doit être un objet JSON".to_string());
    }
    let option_update = requested_launch_option_update(&payload);
    let payload_type = payload.get("type").and_then(Value::as_str);
    let (stdin, session_path, session_id, pid, started_at, previous_busy) = {
        let mut map = agents.0.lock();
        let agent = map
            .get_mut(&conversation_id)
            .ok_or_else(|| format!("Aucun Prime Agent actif pour {conversation_id}"))?;
        if agent.restarting {
            return Err(
                "Prime Agent redémarre pour cette conversation. Réessayez dans un instant."
                    .to_string(),
            );
        }
        if !owner_may_send(
            &agent.owners,
            agent.interactive_owner.as_deref(),
            &owner,
            payload_type,
        ) {
            return Err(
                "Cette fenêtre ne possède pas la conversation Prime Agent demandée.".to_string(),
            );
        }
        if agent.owners.contains(&owner) {
            agent.interactive_owner = Some(owner.clone());
        }
        begin_runtime_write(&mut agent.operations).map_err(|_| {
            "Les ressources Prime Agent sont en cours de rechargement. Aucun message ou réglage ne peut être envoyé pendant cette opération."
                .to_string()
        })?;
        let previous_busy = rpc_starts_busy_operation(payload_type).then_some(agent.busy);
        if previous_busy.is_some() {
            // Close the stdin-flush -> daemon-admission gap. A reload claim
            // sees this under the same lock even before agent_start arrives.
            agent.busy = true;
        }
        (
            Arc::clone(&agent.stdin),
            agent.info.session_path.clone(),
            agent.info.session_id.clone(),
            agent.info.pid,
            agent.info.started_at,
            previous_busy,
        )
    };
    let mut runtime_write = RuntimeWriteGuard::new(
        agents.clone(),
        conversation_id.clone(),
        pid,
        started_at,
        previous_busy,
    );
    // Attachment handles are owner-scoped and expanded only in native memory
    // at the last possible moment. Dropping the reservation on any
    // serialization or write error makes the same handles available for an
    // explicit retry and removes any binary staging created for that attempt.
    let artifact_root = attachment_artifact_root(
        session_path.as_deref(),
        session_id.as_deref(),
        &app_data_dir,
        &conversation_id,
    );
    let attachment_reservation =
        hydrate_prompt_attachments(attachments, &owner, &mut payload, &artifact_root)?;
    let mut bytes = serde_json::to_vec(&payload)
        .map_err(|error| format!("Impossible de sérialiser le payload RPC: {error}"))?;
    if bytes.len() > MAX_RPC_BYTES {
        return Err(format!(
            "Le payload RPC dépasse la limite de {} octets",
            MAX_RPC_BYTES
        ));
    }
    bytes.push(b'\n');

    let mut stdin_guard = stdin.lock();
    let stdin = stdin_guard.as_mut().ok_or_else(|| {
        "Le canal RPC de cette conversation est en cours de fermeture.".to_string()
    })?;
    let write_result = stdin
        .write_all(&bytes)
        .and_then(|_| stdin.flush())
        .map_err(|error| format!("Impossible d’envoyer la commande RPC: {error}"));
    if write_result.is_ok() {
        runtime_write.commit();
        if let Some(reservation) = attachment_reservation {
            reservation.commit();
        }
        if let Some(update) = option_update {
            let mut map = agents.0.lock();
            if let Some(agent) = map
                .get_mut(&conversation_id)
                .filter(|agent| agent.info.pid == pid && !agent.restarting)
            {
                apply_launch_option_update(&mut agent.info, update);
            }
        }
    }
    write_result
}

fn validate_queue_lane(lane: &str) -> Result<(), String> {
    if matches!(lane, "steering" | "followUp") {
        Ok(())
    } else {
        Err("File Prime Agent inconnue.".to_string())
    }
}

fn validate_queued_message_text(value: &str, label: &str, allow_empty: bool) -> Result<(), String> {
    if !allow_empty && value.trim().is_empty() {
        return Err(format!("{label} ne peut pas être vide."));
    }
    if value.len() > MAX_QUEUED_MESSAGE_TEXT {
        return Err(format!("{label} dépasse la taille autorisée."));
    }
    Ok(())
}

fn validate_queue_mutation(mutation: &QueuedMessageMutation) -> Result<(), String> {
    match mutation {
        QueuedMessageMutation::Delete => Ok(()),
        QueuedMessageMutation::Move { direction: -1 | 1 } => Ok(()),
        QueuedMessageMutation::Move { .. } => {
            Err("La direction de déplacement doit être -1 ou 1.".to_string())
        }
        QueuedMessageMutation::Replace { text, lane } => {
            validate_queue_lane(lane)?;
            validate_queued_message_text(text, "Le message modifié", false)
        }
    }
}

fn mutate_agent_queue_blocking(
    agents: AgentsState,
    operation: QueueMutationOperation,
) -> Result<QueueMutationResult, String> {
    let QueueMutationOperation {
        owner,
        conversation_id,
        lane,
        index,
        expected_text,
        mutation,
        app_data_dir,
    } = operation;
    let conversation_id = validated_identifier(conversation_id)?;
    validate_queue_lane(&lane)?;
    validate_queued_message_text(&expected_text, "Le message attendu", true)?;
    validate_queue_mutation(&mutation)?;

    let (launch_spec, session_file, session_id, pid, started_at) = {
        let mut map = agents.0.lock();
        let agent = map
            .get_mut(&conversation_id)
            .ok_or_else(|| format!("Aucun Prime Agent actif pour {conversation_id}"))?;
        if agent.restarting {
            return Err(
                "Prime Agent redémarre pour cette conversation. Réessayez dans un instant."
                    .to_string(),
            );
        }
        if !agent.owners.contains(&owner) {
            return Err(
                "Cette fenêtre ne possède pas la conversation Prime Agent demandée.".to_string(),
            );
        }
        let session_file = agent.info.session_path.clone().ok_or_else(|| {
            "Prime Agent n’a pas encore publié le chemin de cette session.".to_string()
        })?;
        begin_runtime_write(&mut agent.operations).map_err(|_| {
            "Les ressources Prime Agent sont en cours de rechargement. La file d’attente ne peut pas être modifiée pendant cette opération."
                .to_string()
        })?;
        (
            agent.launch_spec.clone(),
            session_file,
            agent.info.session_id.clone(),
            agent.info.pid,
            agent.info.started_at,
        )
    };
    let _runtime_write = RuntimeWriteGuard::new(
        agents.clone(),
        conversation_id.clone(),
        pid,
        started_at,
        None,
    );

    let LaunchSpec::Source { node, cli, .. } = launch_spec else {
        return Ok(QueueMutationResult {
            status: "unsupported".to_string(),
            attachment_context_id: None,
        });
    };
    let deletes_attachment_context = matches!(mutation, QueuedMessageMutation::Delete);
    let request = QueueBridgeRequest {
        session_file,
        session_id: session_id.clone(),
        lane,
        index,
        expected_text,
        mutation,
    };
    let request_json = serde_json::to_string(&request)
        .map_err(|error| format!("Impossible de préparer la mutation de file: {error}"))?;
    let arguments = [OsString::from("-e"), OsString::from(QUEUE_BRIDGE_SCRIPT)];
    let mut command = external_command(&node, &arguments);
    command
        .env("PRIME_ORBIT_CLI_PATH", cli)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|error| format!("Impossible de lancer la mutation de file: {error}"))?;
    let write_result = child
        .stdin
        .take()
        .ok_or_else(|| "Impossible d’ouvrir l’entrée de la mutation de file.".to_string())
        .and_then(|mut stdin| {
            stdin.write_all(request_json.as_bytes()).map_err(|error| {
                format!("Impossible d’envoyer la mutation de file à Prime Agent: {error}")
            })
        });
    if let Err(error) = write_result {
        let _ = child.kill();
        let _ = child.wait();
        return Err(error);
    }
    let output = child
        .wait_with_output()
        .map_err(|error| format!("Impossible d’attendre la mutation de file: {error}"))?;
    if !output.status.success() {
        let details = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if details.is_empty() {
            "Prime Agent n’a pas pu modifier cette instruction en attente.".to_string()
        } else {
            details
        });
    }
    let result: QueueMutationResult = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("Réponse de mutation de file invalide: {error}"))?;
    if !matches!(
        result.status.as_str(),
        "applied" | "rejected" | "invalid" | "unsupported"
    ) {
        return Err("Statut de mutation de file inconnu.".to_string());
    }
    if result.status == "applied" && deletes_attachment_context {
        if let Some(context_id) = result.attachment_context_id.as_deref() {
            let artifact_root = attachment_artifact_root(
                Some(&request.session_file),
                session_id.as_deref(),
                &app_data_dir,
                &conversation_id,
            );
            // The daemon mutation is already committed. Cleanup is best
            // effort and constrained to the exact Orbit-owned context UUID;
            // never turn a successful delete into a misleading UI failure.
            let _ = remove_staged_attachment_context(&artifact_root, context_id);
            // A prompt queued before get_state published sessionFile was
            // intentionally staged in Orbit's durable app-data fallback.
            // Probe that independently derived owner root as well; deletion
            // remains constrained to the same validated context UUID.
            let fallback_root =
                attachment_artifact_root(None, None, &app_data_dir, &conversation_id);
            if fallback_root != artifact_root {
                let _ = remove_staged_attachment_context(&fallback_root, context_id);
            }
        }
    }
    Ok(result)
}

fn unsupported_reload(reason: &str) -> ReloadAgentResourcesResult {
    ReloadAgentResourcesResult {
        status: "unsupported".to_string(),
        supported: false,
        reason: Some(reason.to_string()),
    }
}

fn pending_reload() -> ReloadAgentResourcesResult {
    ReloadAgentResourcesResult {
        status: "pending".to_string(),
        supported: true,
        reason: Some("timeout".to_string()),
    }
}

fn is_reload_acknowledgement_timeout(details: &str) -> bool {
    details.contains("n’a pas répondu au rechargement après")
        || (details.starts_with("Timed out after ")
            && details.contains("Prime Agent daemon response")
            && details.contains("reload"))
}

fn should_emit_resources_reloaded(result: &ReloadAgentResourcesResult) -> bool {
    result.status == "reloaded" && result.supported
}

fn validate_reload_result(
    result: ReloadAgentResourcesResult,
) -> Result<ReloadAgentResourcesResult, String> {
    let valid = matches!(
        (
            result.status.as_str(),
            result.supported,
            result.reason.as_deref(),
        ),
        ("reloaded", true, None)
            | ("pending", true, Some("timeout"))
            | (
                "busy",
                true,
                Some("streaming" | "compacting" | "bash" | "session_action")
            )
            | ("unavailable", true, Some("inactive_session"))
            | (
                "unsupported",
                false,
                Some("runtime_kind" | "daemon_protocol" | "daemon_command")
            )
    );
    valid
        .then_some(result)
        .ok_or_else(|| "Réponse de rechargement Prime Agent invalide.".to_string())
}

fn reload_agent_resources_blocking(
    app: AppHandle,
    agents: AgentsState,
    owner: String,
    conversation_id: String,
) -> Result<ReloadAgentResourcesResult, String> {
    let conversation_id = validated_identifier(conversation_id)?;
    let (node, cli, session_file, session_id, pid, started_at, token) = {
        let mut map = agents.0.lock();
        let agent = map
            .get_mut(&conversation_id)
            .ok_or_else(|| format!("Aucun Prime Agent actif pour {conversation_id}"))?;
        if agent.restarting {
            return Ok(ReloadAgentResourcesResult {
                status: "busy".to_string(),
                supported: true,
                reason: Some("session_action".to_string()),
            });
        }
        if agent.busy {
            return Ok(ReloadAgentResourcesResult {
                status: "busy".to_string(),
                supported: true,
                reason: Some("streaming".to_string()),
            });
        }
        let Some(session_file) = agent.info.session_path.clone() else {
            return Ok(ReloadAgentResourcesResult {
                status: "unavailable".to_string(),
                supported: true,
                reason: Some("inactive_session".to_string()),
            });
        };
        let LaunchSpec::Source { node, cli, .. } = agent.launch_spec.clone() else {
            return Ok(unsupported_reload("runtime_kind"));
        };
        let token = match begin_owned_resource_reload(&agent.owners, &owner, &mut agent.operations)
        {
            Ok(token) => token,
            Err(ResourceReloadClaimError::NotOwner) => {
                return Err(
                    "Cette fenêtre ne possède pas la conversation Prime Agent demandée."
                        .to_string(),
                );
            }
            Err(ResourceReloadClaimError::RuntimeWrite | ResourceReloadClaimError::Reloading) => {
                return Ok(ReloadAgentResourcesResult {
                    status: "busy".to_string(),
                    supported: true,
                    reason: Some("session_action".to_string()),
                });
            }
        };
        (
            node,
            cli,
            session_file,
            agent.info.session_id.clone(),
            agent.info.pid,
            agent.info.started_at,
            token,
        )
    };
    let reload_guard = ResourceReloadGuard::new(agents, conversation_id, pid, started_at, token);
    let request = SessionControlBridgeRequest {
        action: "reload",
        session_file,
        session_id,
    };
    let request_json = serde_json::to_string(&request)
        .map_err(|error| format!("Impossible de préparer le rechargement Prime Agent: {error}"))?;
    let arguments = [
        OsString::from("-e"),
        OsString::from(SESSION_CONTROL_BRIDGE_SCRIPT),
    ];
    let mut command = external_command(&node, &arguments);
    command
        .env("PRIME_ORBIT_CLI_PATH", cli)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|error| format!("Impossible de lancer le rechargement Prime Agent: {error}"))?;
    let write_result = child
        .stdin
        .take()
        .ok_or_else(|| "Impossible d’ouvrir l’entrée du rechargement Prime Agent.".to_string())
        .and_then(|mut stdin| {
            stdin.write_all(request_json.as_bytes()).map_err(|error| {
                format!("Impossible d’envoyer le rechargement à Prime Agent: {error}")
            })
        });
    if let Err(error) = write_result {
        let _ = child.kill();
        let _ = child.wait();
        return Err(error);
    }
    let output = child
        .wait_with_output()
        .map_err(|error| format!("Impossible d’attendre le rechargement Prime Agent: {error}"))?;
    if !output.status.success() {
        let details = String::from_utf8_lossy(&output.stderr).trim().to_string();
        if is_reload_acknowledgement_timeout(&details) {
            reload_guard.retain_unknown();
            return Ok(pending_reload());
        }
        return Err(if details.is_empty() {
            "Prime Agent n’a pas pu recharger les ressources de cette session.".to_string()
        } else {
            details
        });
    }
    let result: ReloadAgentResourcesResult = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("Réponse de rechargement Prime Agent invalide: {error}"))?;
    let result = validate_reload_result(result)?;
    if should_emit_resources_reloaded(&result) {
        reload_guard.complete_and_broadcast(&app)?;
    } else if result.status == "pending" {
        reload_guard.retain_unknown();
    } else {
        drop(reload_guard);
    }
    Ok(result)
}

struct RestartSnapshot {
    previous_pid: u32,
    busy: bool,
    cwd: PathBuf,
    session_path: Option<PathBuf>,
    session_id: Option<String>,
    provider: Option<String>,
    model: Option<String>,
    thinking: Option<String>,
    launch_spec: LaunchSpec,
    child: Arc<Mutex<Child>>,
    stdin: Arc<Mutex<Option<ChildStdin>>>,
    exit_emitted: Arc<AtomicBool>,
}

fn restart_agent_blocking(
    app: AppHandle,
    agents: AgentsState,
    owner: String,
    conversation_id: String,
) -> Result<RestartAgentResult, String> {
    let conversation_id = validated_identifier(conversation_id)?;
    let snapshot = {
        let mut map = agents.0.lock();
        let agent = map
            .get_mut(&conversation_id)
            .ok_or_else(|| format!("Aucun Prime Agent actif pour {conversation_id}"))?;
        if agent.restarting {
            return Err("Le redémarrage de cette conversation est déjà en cours.".to_string());
        }
        if agent.operations.reloading.is_some() {
            return Err(
                "Les ressources Prime Agent sont encore en cours de rechargement. Attendez leur confirmation avant de redémarrer la connexion."
                    .to_string(),
            );
        }
        if agent.operations.runtime_writes > 0 {
            return Err(
                "Une commande Prime Agent est en cours d’envoi. Réessayez le redémarrage dans un instant."
                    .to_string(),
            );
        }

        // Keep every surviving window lease on the replacement. The window
        // that requested the emergency action becomes the interactive owner,
        // but no other window loses observation of the same conversation.
        acquire_owner(agent, owner);
        let busy = agent.busy;
        agent.restarting = true;
        agent.busy = true;
        // The old waiter must not publish a normal process-exit event after a
        // successful replacement; that would race the UI back to "offline".
        agent.exit_emitted.store(true, Ordering::SeqCst);

        RestartSnapshot {
            previous_pid: agent.info.pid,
            busy,
            cwd: PathBuf::from(&agent.info.cwd),
            session_path: agent.info.session_path.as_deref().map(PathBuf::from),
            session_id: agent.info.session_id.clone(),
            provider: agent.info.provider.clone(),
            model: agent.info.model.clone(),
            thinking: agent.info.thinking.clone(),
            launch_spec: agent.launch_spec.clone(),
            child: Arc::clone(&agent.child),
            stdin: Arc::clone(&agent.stdin),
            exit_emitted: Arc::clone(&agent.exit_emitted),
        }
    };

    if let Err(error) = stop_rpc_client_for_restart(
        &app,
        &snapshot.child,
        &snapshot.stdin,
        snapshot.session_path.as_deref(),
        &snapshot.cwd,
    ) {
        let process_stopped = snapshot.child.lock().try_wait().ok().flatten().is_some();
        let mut map = agents.0.lock();
        let slot_matches = map.get(&conversation_id).is_some_and(|agent| {
            restart_slot_matches(agent.info.pid, agent.restarting, snapshot.previous_pid)
        });
        if slot_matches && process_stopped {
            map.remove(&conversation_id);
        } else if let Some(agent) = map.get_mut(&conversation_id) {
            if restart_slot_matches(agent.info.pid, agent.restarting, snapshot.previous_pid) {
                agent.restarting = false;
                agent.busy = snapshot.busy;
                snapshot.exit_emitted.store(false, Ordering::SeqCst);
            }
        }
        drop(map);
        if process_stopped {
            let _ = app.emit(
                "prime-agent://exit",
                AgentExitEvent {
                    conversation_id: conversation_id.clone(),
                    code: None,
                    success: false,
                    error: Some(format!("Redémarrage d’urgence interrompu: {error}")),
                },
            );
        }
        return Err(format!(
            "Prime Agent n’a pas pu être relancé en toute sécurité; aucun remplacement n’a été lancé: {error}"
        ));
    }

    // Launch and slot replacement share one map critical section. This is the
    // restart/stop linearization point: a stop that removed the old slot while
    // EOF/lease release was pending prevents any spawn; a stop arriving after
    // this section observes and stops the installed replacement.
    let (spawned, install_result) = {
        let mut map = agents.0.lock();
        let Some(previous) = map.get(&conversation_id) else {
            return Err(
                "Le redémarrage a été annulé car la conversation a été arrêtée entre-temps."
                    .to_string(),
            );
        };
        if !restart_slot_matches(
            previous.info.pid,
            previous.restarting,
            snapshot.previous_pid,
        ) {
            return Err("L’état de la conversation a changé pendant son redémarrage.".to_string());
        }

        let owners = previous.owners.clone();
        let interactive_owner = previous.interactive_owner.clone();
        let release_when_idle = previous.release_when_idle;
        let spawned = match spawn_rpc_agent(
            &app,
            &conversation_id,
            &snapshot.cwd,
            snapshot.session_path.as_deref(),
            snapshot.session_id.clone(),
            snapshot.provider.clone(),
            snapshot.model.clone(),
            snapshot.thinking.clone(),
            &snapshot.launch_spec,
        ) {
            Ok(spawned) => spawned,
            Err(error) => {
                map.remove(&conversation_id);
                drop(map);
                let _ = app.emit(
                    "prime-agent://exit",
                    AgentExitEvent {
                        conversation_id: conversation_id.clone(),
                        code: None,
                        success: false,
                        error: Some(format!("Redémarrage d’urgence impossible: {error}")),
                    },
                );
                return Err(error);
            }
        };
        let info = spawned.info.clone();
        map.insert(
            conversation_id.clone(),
            RunningAgent {
                info: info.clone(),
                launch_spec: snapshot.launch_spec,
                child: Arc::clone(&spawned.child),
                stdin: Arc::clone(&spawned.stdin),
                exit_emitted: Arc::clone(&spawned.exit_emitted),
                owners,
                interactive_owner,
                busy: true,
                release_when_idle,
                restarting: false,
                operations: AgentOperations::default(),
            },
        );
        (spawned, info)
    };
    let replacement_pid = install_result.pid;

    // Native state tracking must not depend on the initiating window still
    // displaying this conversation. The response is selection-scoped in the
    // renderer and may be ignored there, but `apply_runtime_record` consumes
    // it first to restore busy/session/model state and release ownerless idle
    // replacements after fast navigation or window closure.
    if let Err(error) = request_runtime_state_after_restart(&spawned.stdin, replacement_pid) {
        let mut map = agents.0.lock();
        let owns_slot = map
            .get(&conversation_id)
            .is_some_and(|agent| agent.info.pid == replacement_pid);
        if owns_slot {
            map.remove(&conversation_id);
        }
        drop(map);
        if !owns_slot {
            return Err(
                "Le redémarrage a été annulé car la conversation a été arrêtée entre-temps."
                    .to_string(),
            );
        }
        let cleanup_error = stop_rpc_client_for_restart(
            &app,
            &spawned.child,
            &spawned.stdin,
            snapshot.session_path.as_deref(),
            &snapshot.cwd,
        )
        .err();
        let diagnostic = cleanup_error
            .as_ref()
            .map(|cleanup| format!("{error}\n\nNettoyage du remplacement: {cleanup}"))
            .unwrap_or_else(|| error.clone());
        let _ = app.emit(
            "prime-agent://exit",
            AgentExitEvent {
                conversation_id: conversation_id.clone(),
                code: None,
                success: false,
                error: Some(format!("Redémarrage d’urgence incomplet: {diagnostic}")),
            },
        );
        return Err(diagnostic);
    }

    spawn_agent_io_threads(
        app.clone(),
        agents.clone(),
        conversation_id.clone(),
        spawned,
    );
    let result = RestartAgentResult {
        previous_pid: snapshot.previous_pid,
        agent: install_result,
    };
    // Revalidate and broadcast under the same map lock. A stop that wins after
    // installation therefore produces either `restarted` then `exit`, or only
    // `exit`; it can never be followed by a stale restart event that revives
    // the explicitly stopped conversation in another window.
    {
        let map = agents.0.lock();
        if !map
            .get(&conversation_id)
            .is_some_and(|agent| agent.info.pid == replacement_pid && !agent.restarting)
        {
            return Err(
                "Le redémarrage a été annulé car la conversation a été arrêtée entre-temps."
                    .to_string(),
            );
        }
        let _ = app.emit("prime-agent://restarted", result.clone());
    }
    debug_assert_eq!(result.agent.pid, replacement_pid);
    Ok(result)
}

fn stop_agent_blocking(
    app: AppHandle,
    agents: AgentsState,
    conversation_id: String,
) -> Result<bool, String> {
    let conversation_id = validated_identifier(conversation_id)?;
    let agent = {
        let mut map = agents.0.lock();
        let Some(agent) = map.get(&conversation_id) else {
            return Ok(false);
        };
        if agent.operations.reloading.is_some() {
            return Err(
                "Les ressources Prime Agent sont en cours de rechargement. Attendez leur confirmation avant d’arrêter cette connexion."
                    .to_string(),
            );
        }
        map.remove(&conversation_id)
            .expect("agent slot checked under the same lock")
    };

    let status = terminate_child(&mut agent.child.lock());
    if agent.restarting {
        // A concurrent explicit stop wins over emergency restart. Restart had
        // suppressed the old waiter's exit, so publish the stop result here.
        let event = match status {
            Ok(status) => AgentExitEvent {
                conversation_id: conversation_id.clone(),
                code: status.code(),
                success: status.success(),
                error: None,
            },
            Err(error) => AgentExitEvent {
                conversation_id: conversation_id.clone(),
                code: None,
                success: false,
                error: Some(error),
            },
        };
        let _ = app.emit("prime-agent://exit", event);
    } else {
        emit_exit_once(&app, &conversation_id, &agent.exit_emitted, status, None);
    }
    Ok(true)
}

fn list_running_agents_blocking(agents: AgentsState) -> Result<Vec<RunningAgentInfo>, String> {
    let mut running: Vec<_> = agents
        .0
        .lock()
        .values()
        .map(|agent| agent.info.clone())
        .collect();
    running.sort_by_key(|agent| agent.started_at);
    Ok(running)
}

#[tauri::command(rename_all = "camelCase")]
#[allow(clippy::too_many_arguments)]
pub async fn start_agent(
    app: AppHandle,
    window: tauri::WebviewWindow,
    agents: tauri::State<'_, AgentsState>,
    conversation_id: String,
    cwd: String,
    session_path: Option<String>,
    provider: Option<String>,
    model: Option<String>,
    thinking: Option<String>,
) -> Result<RunningAgentInfo, String> {
    let agents = AgentsState(Arc::clone(&agents.0));
    let owner = window.label().to_string();
    crate::run_blocking(move || {
        start_agent_blocking(
            app,
            agents,
            owner,
            conversation_id,
            cwd,
            session_path,
            provider,
            model,
            thinking,
        )
    })
    .await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn release_agent(
    window: tauri::WebviewWindow,
    agents: tauri::State<'_, AgentsState>,
    conversation_id: String,
) -> Result<bool, String> {
    let agents = AgentsState(Arc::clone(&agents.0));
    let owner = window.label().to_string();
    crate::run_blocking(move || release_agent_blocking(agents, owner, conversation_id)).await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn send_rpc(
    window: tauri::WebviewWindow,
    agents: tauri::State<'_, AgentsState>,
    attachments: tauri::State<'_, AttachmentCache>,
    exports: tauri::State<'_, crate::exports::HtmlExportState>,
    conversation_id: String,
    payload: Value,
) -> Result<(), String> {
    let agents = AgentsState(Arc::clone(&agents.0));
    let attachments = attachments.inner().clone();
    let owner = window.label().to_string();
    let app_data_dir = window
        .app_handle()
        .path()
        .app_data_dir()
        .map_err(|error| format!("Impossible de résoudre le stockage Prime Orbit: {error}"))?;
    crate::exports::validate_export_rpc_payload(
        exports.inner(),
        &owner,
        &conversation_id,
        &payload,
    )?;
    crate::run_blocking(move || {
        send_rpc_blocking(
            agents,
            attachments,
            owner,
            conversation_id,
            app_data_dir,
            payload,
        )
    })
    .await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn mutate_agent_queue(
    window: tauri::WebviewWindow,
    agents: tauri::State<'_, AgentsState>,
    conversation_id: String,
    lane: String,
    index: usize,
    expected_text: String,
    mutation: QueuedMessageMutation,
) -> Result<QueueMutationResult, String> {
    let agents = AgentsState(Arc::clone(&agents.0));
    let owner = window.label().to_string();
    let app_data_dir = window
        .app_handle()
        .path()
        .app_data_dir()
        .map_err(|error| format!("Impossible de résoudre le stockage Prime Orbit: {error}"))?;
    crate::run_blocking(move || {
        mutate_agent_queue_blocking(
            agents,
            QueueMutationOperation {
                owner,
                conversation_id,
                lane,
                index,
                expected_text,
                mutation,
                app_data_dir,
            },
        )
    })
    .await
}

/// Reloads Prime Agent's session resources through its daemon protocol. This
/// never sends `/reload` as model input and never restarts the RPC process.
#[tauri::command(rename_all = "camelCase")]
pub async fn reload_agent_resources(
    window: tauri::WebviewWindow,
    agents: tauri::State<'_, AgentsState>,
    conversation_id: String,
) -> Result<ReloadAgentResourcesResult, String> {
    let agents = AgentsState(Arc::clone(&agents.0));
    let owner = window.label().to_string();
    let app = window.app_handle().clone();
    crate::run_blocking(move || {
        reload_agent_resources_blocking(app, agents, owner, conversation_id)
    })
    .await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn stop_agent(
    app: AppHandle,
    agents: tauri::State<'_, AgentsState>,
    conversation_id: String,
) -> Result<bool, String> {
    let agents = AgentsState(Arc::clone(&agents.0));
    crate::run_blocking(move || stop_agent_blocking(app, agents, conversation_id)).await
}

/// Emergency-restarts only the RPC client associated with one conversation.
/// This is deliberately distinct from get_state/resynchronization, waits for
/// the exact owned-session lease to be released, and never shuts down Prime
/// Agent's shared daemon or deletes session data.
#[tauri::command(rename_all = "camelCase")]
pub async fn restart_agent(
    app: AppHandle,
    window: tauri::WebviewWindow,
    agents: tauri::State<'_, AgentsState>,
    conversation_id: String,
) -> Result<RestartAgentResult, String> {
    let agents = AgentsState(Arc::clone(&agents.0));
    let owner = window.label().to_string();
    crate::run_blocking(move || restart_agent_blocking(app, agents, owner, conversation_id)).await
}

#[tauri::command]
pub async fn list_running_agents(
    agents: tauri::State<'_, AgentsState>,
) -> Result<Vec<RunningAgentInfo>, String> {
    let agents = AgentsState(Arc::clone(&agents.0));
    crate::run_blocking(move || list_running_agents_blocking(agents)).await
}

pub fn shutdown_all_agents(app: &AppHandle, agents: &AgentsState) {
    let running: Vec<_> = agents.0.lock().drain().collect();
    for (conversation_id, agent) in running {
        let status = terminate_child(&mut agent.child.lock());
        emit_exit_once(app, &conversation_id, &agent.exit_emitted, status, None);
    }
}

pub fn release_window_agents(agents: AgentsState, owner: String) {
    release_owner_blocking(agents, &owner);
}

#[cfg(test)]
mod tests {
    use super::{
        acquire_owner_lease, append_diagnostic_tail, apply_launch_option_update,
        begin_owned_resource_reload, begin_runtime_write, close_rpc_stdin_for_restart,
        conflicting_session_conversation, finish_resource_reload, finish_runtime_write,
        is_extension_ui_request, is_reload_acknowledgement_timeout, lease_absence_attests_release,
        mark_resource_reload_unknown, owner_may_send, public_runtime_line,
        release_owner_lease_state, requested_launch_option_update, restart_slot_matches,
        rpc_launch_arguments, rpc_starts_busy_operation, runtime_busy_state,
        runtime_launch_options, runtime_session_id, runtime_session_path,
        should_emit_resources_reloaded, validate_queue_lane, validate_queue_mutation,
        validate_reload_result, wait_for_child_until, waiter_may_remove_slot, AgentOperations,
        AgentResourcesReloadedEvent, LaunchOptionUpdate, QueuedMessageMutation,
        ReloadAgentResourcesResult, ResourceReloadClaimError, ResourceReloadPhase,
        RestartAgentResult, RunningAgentInfo, MAX_EXIT_DIAGNOSTIC_BYTES,
    };
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
    use parking_lot::Mutex;
    use serde_json::{json, Value};
    use std::{
        collections::HashSet,
        path::Path,
        process::Stdio,
        sync::{Arc, Barrier},
        thread,
        time::Duration,
    };

    fn info(conversation_id: &str, session_path: Option<&str>) -> RunningAgentInfo {
        RunningAgentInfo {
            conversation_id: conversation_id.to_string(),
            pid: 1,
            cwd: "C:\\project".to_string(),
            session_path: session_path.map(str::to_string),
            session_id: None,
            provider: None,
            model: None,
            thinking: None,
            started_at: 0,
        }
    }

    fn wrapped_attachment_message(visible: &str, private_fragment: &str) -> String {
        let context_id = "550e8400-e29b-41d4-a716-446655440000";
        let manifest = serde_json::to_vec(&json!([{
            "name": "notes.txt",
            "mimeType": "text/plain",
            "size": 12,
            "isImage": false,
        }]))
        .expect("manifest");
        let encoded = URL_SAFE_NO_PAD.encode(manifest);
        let separator = if visible.is_empty() { "" } else { "\n\n" };
        let content_utf16 = private_fragment.encode_utf16().count();
        format!(
            "{visible}{separator}<prime_orbit_attachment_context v=\"1\" id=\"{context_id}\">\n<prime_orbit_manifest encoding=\"base64url\">{encoded}</prime_orbit_manifest>\n<file name=\"notes.txt\" content_utf16=\"{content_utf16}\">\n{private_fragment}\n</file>\n</prime_orbit_attachment_context>\n<prime_orbit_ui_boundary v=\"1\" id=\"{context_id}\" visible_utf16=\"{}\"/>",
            visible.encode_utf16().count()
        )
    }

    #[test]
    fn keeps_a_runtime_while_another_window_owns_it() {
        let mut owners = HashSet::from(["main".to_string(), "workspace-2".to_string()]);
        let mut release_when_idle = false;

        assert!(!release_owner_lease_state(
            &mut owners,
            false,
            &mut release_when_idle,
            "main",
        ));
        assert_eq!(owners, HashSet::from(["workspace-2".to_string()]));
        assert!(!release_when_idle);
    }

    #[test]
    fn defers_the_last_release_until_busy_work_finishes() {
        let mut owners = HashSet::from(["main".to_string()]);
        let mut release_when_idle = false;

        assert!(!release_owner_lease_state(
            &mut owners,
            true,
            &mut release_when_idle,
            "main",
        ));
        assert!(owners.is_empty());
        assert!(release_when_idle);
        assert!(release_when_idle && owners.is_empty());
    }

    #[test]
    fn a_new_owner_cancels_deferred_release() {
        let mut owners = HashSet::new();
        let mut release_when_idle = true;

        acquire_owner_lease(
            &mut owners,
            &mut release_when_idle,
            "workspace-2".to_string(),
        );
        assert_eq!(owners, HashSet::from(["workspace-2".to_string()]));
        assert!(!release_when_idle);
    }

    #[test]
    fn interactive_requests_are_recognized_before_window_routing() {
        assert!(is_extension_ui_request(
            br#"{"type":"extension_ui_request","id":"request-1","method":"confirm"}"#
        ));
        assert!(!is_extension_ui_request(br#"{"type":"agent_start"}"#));
    }

    #[test]
    fn runtime_records_remove_attachment_contents_and_paths_before_ipc() {
        let private = r#"PRIVATE_FILE_BODY C:\Users\example\session-attachments\secret\prime-orbit-attachments\id\attachment.txt"#;
        let queued = wrapped_attachment_message("queued visible", private);
        let active = wrapped_attachment_message("active visible", private);
        let state = json!({
            "type": "response",
            "command": "get_state",
            "success": true,
            "data": {
                "sessionActions": {
                    "queuedCount": 2,
                    "steering": [queued],
                    "followUps": [],
                    "active": {"kind":"turn", "phase":"running", "label":active},
                    "queueAttachments": {"path":"FORGED_QUEUE_PATH", "bytes":"FORGED_QUEUE_BYTES"}
                },
                "primeOrbitAttachments": [{"attachmentHandle":"FORGED_HANDLE", "path":"FORGED_PATH"}]
            }
        });
        let line = public_runtime_line(state.to_string().as_bytes());
        assert!(!line.contains("PRIVATE_FILE_BODY"));
        assert!(!line.contains("session-attachments"));
        assert!(!line.contains("prime_orbit_attachment_context"));
        assert!(!line.contains("FORGED_QUEUE_PATH"));
        assert!(!line.contains("FORGED_QUEUE_BYTES"));
        assert!(!line.contains("FORGED_HANDLE"));
        assert!(!line.contains("FORGED_PATH"));
        let public: Value = serde_json::from_str(&line).expect("public state JSON");
        let actions = &public["data"]["sessionActions"];
        assert_eq!(actions["steering"][0], "queued visible");
        assert_eq!(actions["active"]["label"], "active visible");
        assert_eq!(
            actions["queueAttachments"]["steering"][0][0]["name"],
            "notes.txt"
        );
        assert_eq!(
            actions["queueAttachments"]["active"][0]["mimeType"],
            "text/plain"
        );

        let message = json!({
            "type":"response",
            "command":"get_messages",
            "success":true,
            "data":{"messages":[
                {"role":"user","content":wrapped_attachment_message("message visible", private)},
                {"role":"assistant","content":wrapped_attachment_message("assistant visible", private)},
                {"role":"toolResult","content":[{"type":"text","text":wrapped_attachment_message("tool visible", private)}]}
            ]}
        });
        let line = public_runtime_line(message.to_string().as_bytes());
        assert!(!line.contains("PRIVATE_FILE_BODY"));
        assert!(!line.contains("prime-orbit-attachments"));
        let public: Value = serde_json::from_str(&line).expect("public messages JSON");
        assert_eq!(public["data"]["messages"][0]["content"], "message visible");
        assert_eq!(
            public["data"]["messages"][0]["primeOrbitAttachments"][0]["name"],
            "notes.txt"
        );
        assert_eq!(
            public["data"]["messages"][1]["content"],
            "assistant visible"
        );
        assert!(public["data"]["messages"][1]
            .get("primeOrbitAttachments")
            .is_none());
        assert_eq!(
            public["data"]["messages"][2]["content"][0]["text"],
            "tool visible"
        );
        assert!(public["data"]["messages"][2]
            .get("primeOrbitAttachments")
            .is_none());
    }

    #[test]
    fn only_an_owner_or_the_interactive_responder_can_write_rpc() {
        let owners = HashSet::from(["workspace-2".to_string()]);
        assert!(owner_may_send(
            &owners,
            Some("workspace-2"),
            "workspace-2",
            Some("prompt"),
        ));
        assert!(!owner_may_send(
            &owners,
            Some("main"),
            "main",
            Some("prompt"),
        ));
        assert!(owner_may_send(
            &owners,
            Some("main"),
            "main",
            Some("extension_ui_response"),
        ));
    }

    #[test]
    fn releasing_an_idle_last_owner_schedules_stop() {
        let mut owners = HashSet::from(["main".to_string()]);
        let mut release_when_idle = false;

        assert!(release_owner_lease_state(
            &mut owners,
            false,
            &mut release_when_idle,
            "main",
        ));
        assert!(owners.is_empty());
        assert!(release_when_idle);
    }

    #[test]
    fn releasing_the_same_owner_twice_is_idempotent() {
        let mut owners = HashSet::from(["main".to_string()]);
        let mut release_when_idle = false;

        assert!(!release_owner_lease_state(
            &mut owners,
            true,
            &mut release_when_idle,
            "main",
        ));
        assert!(!release_owner_lease_state(
            &mut owners,
            false,
            &mut release_when_idle,
            "main",
        ));
        assert!(owners.is_empty());
        assert!(release_when_idle);
    }

    #[test]
    fn detects_busy_state_from_agent_and_state_records() {
        assert_eq!(runtime_busy_state(br#"{"type":"agent_start"}"#), Some(true));
        assert_eq!(
            runtime_busy_state(br#"{"type":"auto_retry_start"}"#),
            Some(true),
        );
        assert_eq!(runtime_busy_state(br#"{"type":"agent_end"}"#), Some(false));
        assert_eq!(runtime_busy_state(br#"{"type":"turn_error"}"#), Some(false));
        assert_eq!(
            runtime_busy_state(br#"{"type":"auto_retry_end","success":false}"#),
            Some(false),
        );
        assert_eq!(
            runtime_busy_state(br#"{"type":"auto_retry_end","success":true}"#),
            None,
        );
        assert_eq!(
            runtime_busy_state(
                br#"{"type":"response","command":"get_state","success":true,"data":{"isStreaming":false}}"#,
            ),
            Some(false),
        );
        assert_eq!(runtime_busy_state(br#"{"type":"message_update"}"#), None);
        assert_eq!(
            runtime_busy_state(br#"{"type":"response","command":"prompt","success":false}"#,),
            Some(false),
        );
        assert_eq!(
            runtime_busy_state(br#"{"type":"response","command":"compact","success":true}"#,),
            Some(false),
        );
        assert!(rpc_starts_busy_operation(Some("prompt")));
        assert!(rpc_starts_busy_operation(Some("compact")));
        assert!(!rpc_starts_busy_operation(Some("get_state")));
    }

    #[test]
    fn missing_lease_requires_a_successful_guarded_inspection_in_the_same_iteration() {
        assert!(lease_absence_attests_release(true, false));
        assert!(!lease_absence_attests_release(false, false));
        assert!(!lease_absence_attests_release(true, true));
    }

    #[test]
    fn records_the_canonical_session_returned_by_get_state() {
        assert_eq!(
            runtime_session_id(
                br#"{"type":"response","command":"get_state","success":true,"data":{"sessionId":"exact-id","sessionFile":"C:\\sessions\\one.jsonl"}}"#,
            )
            .as_deref(),
            Some("exact-id"),
        );
        assert_eq!(
            runtime_session_path(
                br#"{"type":"response","command":"get_state","success":true,"data":{"sessionFile":"C:\\sessions\\one.jsonl"}}"#,
            )
            .as_deref(),
            Some("C:\\sessions\\one.jsonl"),
        );
        assert_eq!(
            runtime_session_path(
                br#"{"type":"response","command":"get_state","success":false,"data":{"sessionFile":"C:\\sessions\\one.jsonl"}}"#,
            ),
            None,
        );
        assert_eq!(
            runtime_launch_options(
                br#"{"type":"response","command":"get_state","success":true,"data":{"model":{"provider":"openai","id":"gpt-5.6-sol"},"thinkingLevel":"xhigh"}}"#,
            ),
            Some((
                Some("openai".to_string()),
                Some("gpt-5.6-sol".to_string()),
                Some("xhigh".to_string()),
            )),
        );
    }

    #[test]
    fn accepted_runtime_option_changes_are_retained_for_restart() {
        let mut running = info("conversation-a", Some("C:\\sessions\\one.jsonl"));
        let model = requested_launch_option_update(&json!({
            "type": "set_model",
            "provider": "ollama",
            "modelId": "qwen3"
        }))
        .expect("model update");
        apply_launch_option_update(&mut running, model);
        let thinking = requested_launch_option_update(&json!({
            "type": "set_thinking_level",
            "level": "high"
        }))
        .expect("thinking update");
        apply_launch_option_update(&mut running, thinking);
        assert_eq!(running.provider.as_deref(), Some("ollama"));
        assert_eq!(running.model.as_deref(), Some("qwen3"));
        assert_eq!(running.thinking.as_deref(), Some("high"));
        assert!(requested_launch_option_update(&json!({
            "type": "set_thinking_level",
            "level": "invented"
        }))
        .is_none());
        assert!(matches!(
            requested_launch_option_update(&json!({
                "type": "set_model",
                "provider": "openai",
                "modelId": "gpt-5.6-sol"
            })),
            Some(LaunchOptionUpdate::Model { .. })
        ));
    }

    #[test]
    fn rejects_a_second_conversation_for_the_same_session() {
        let agents = [
            info("conversation-a", Some("C:\\sessions\\one.jsonl")),
            info("conversation-b", Some("C:\\sessions\\two.jsonl")),
        ];
        assert_eq!(
            conflicting_session_conversation(
                agents.iter(),
                "conversation-new",
                Path::new("C:\\sessions\\one.jsonl"),
            ),
            Some("conversation-a"),
        );
        assert_eq!(
            conflicting_session_conversation(
                agents.iter(),
                "conversation-a",
                Path::new("C:\\sessions\\one.jsonl"),
            ),
            None,
        );
    }

    #[test]
    fn bounds_exit_diagnostics_without_splitting_utf8() {
        let diagnostic = Mutex::new(String::new());
        append_diagnostic_tail(&diagnostic, "ancienne erreur");
        append_diagnostic_tail(
            &diagnostic,
            &format!("{}MARQUEUR", "é".repeat(MAX_EXIT_DIAGNOSTIC_BYTES)),
        );

        let diagnostic = diagnostic.lock();
        assert!(diagnostic.len() <= MAX_EXIT_DIAGNOSTIC_BYTES);
        assert!(diagnostic.ends_with("MARQUEUR"));
        assert!(!diagnostic.contains("ancienne erreur"));
        assert!(std::str::from_utf8(diagnostic.as_bytes()).is_ok());
    }

    #[test]
    fn validates_queue_mutations_before_contacting_the_daemon() {
        assert!(validate_queue_lane("steering").is_ok());
        assert!(validate_queue_lane("followUp").is_ok());
        assert!(validate_queue_lane("follow_up").is_err());
        assert!(validate_queue_mutation(&QueuedMessageMutation::Delete).is_ok());
        assert!(validate_queue_mutation(&QueuedMessageMutation::Move { direction: -1 }).is_ok());
        assert!(validate_queue_mutation(&QueuedMessageMutation::Move { direction: 2 }).is_err());
        assert!(validate_queue_mutation(&QueuedMessageMutation::Replace {
            text: "Message corrigé".to_string(),
            lane: "followUp".to_string(),
        })
        .is_ok());
        assert!(validate_queue_mutation(&QueuedMessageMutation::Replace {
            text: "   ".to_string(),
            lane: "followUp".to_string(),
        })
        .is_err());
    }

    #[test]
    fn validates_the_reload_bridge_capability_contract() {
        assert!(validate_reload_result(ReloadAgentResourcesResult {
            status: "reloaded".to_string(),
            supported: true,
            reason: None,
        })
        .is_ok());
        assert!(validate_reload_result(ReloadAgentResourcesResult {
            status: "busy".to_string(),
            supported: true,
            reason: Some("streaming".to_string()),
        })
        .is_ok());
        assert!(validate_reload_result(ReloadAgentResourcesResult {
            status: "pending".to_string(),
            supported: true,
            reason: Some("timeout".to_string()),
        })
        .is_ok());
        assert!(validate_reload_result(ReloadAgentResourcesResult {
            status: "unsupported".to_string(),
            supported: false,
            reason: Some("daemon_protocol".to_string()),
        })
        .is_ok());
        assert!(validate_reload_result(ReloadAgentResourcesResult {
            status: "reloaded".to_string(),
            supported: false,
            reason: Some("daemon_command".to_string()),
        })
        .is_err());
        assert!(validate_reload_result(ReloadAgentResourcesResult {
            status: "busy".to_string(),
            supported: true,
            reason: Some("unknown".to_string()),
        })
        .is_err());
    }

    #[test]
    fn runtime_writes_and_resource_reload_are_atomically_exclusive() {
        let operations = Arc::new(Mutex::new(AgentOperations::default()));
        let barrier = Arc::new(Barrier::new(3));
        let write_operations = Arc::clone(&operations);
        let write_barrier = Arc::clone(&barrier);
        let write = thread::spawn(move || {
            write_barrier.wait();
            begin_runtime_write(&mut write_operations.lock()).is_ok()
        });
        let reload_operations = Arc::clone(&operations);
        let reload_barrier = Arc::clone(&barrier);
        let reload = thread::spawn(move || {
            let owners = HashSet::from(["main".to_string()]);
            reload_barrier.wait();
            begin_owned_resource_reload(&owners, "main", &mut reload_operations.lock()).is_ok()
        });

        barrier.wait();
        let write_won = write.join().expect("write contender");
        let reload_won = reload.join().expect("reload contender");
        assert_ne!(
            write_won, reload_won,
            "exactly one native operation may win"
        );

        let operations = operations.lock();
        assert!(!(operations.runtime_writes > 0 && operations.reloading.is_some()));
    }

    #[test]
    fn resource_reload_is_shared_by_owners_but_can_only_be_claimed_once() {
        let owners = HashSet::from(["main".to_string(), "workspace-2".to_string()]);
        let mut operations = AgentOperations::default();
        let token = begin_owned_resource_reload(&owners, "main", &mut operations)
            .expect("first owner claims reload");
        assert_eq!(
            begin_owned_resource_reload(&owners, "workspace-2", &mut operations),
            Err(ResourceReloadClaimError::Reloading)
        );
        assert_eq!(
            owners.len(),
            2,
            "claiming maintenance must not steal window leases"
        );
        assert!(finish_resource_reload(&mut operations, token));
        assert!(begin_owned_resource_reload(&owners, "workspace-2", &mut operations).is_ok());

        let outsider = begin_owned_resource_reload(
            &HashSet::from(["main".to_string()]),
            "other-window",
            &mut AgentOperations::default(),
        );
        assert_eq!(outsider, Err(ResourceReloadClaimError::NotOwner));
    }

    #[test]
    fn pending_reload_keeps_its_fence_until_the_exact_unknown_claim_is_released() {
        let owners = HashSet::from(["main".to_string()]);
        let mut operations = AgentOperations::default();
        let token =
            begin_owned_resource_reload(&owners, "main", &mut operations).expect("reload claim");
        assert!(mark_resource_reload_unknown(&mut operations, token));
        assert_eq!(
            operations.reloading.map(|marker| marker.phase),
            Some(ResourceReloadPhase::Unknown)
        );
        assert_eq!(
            begin_runtime_write(&mut operations),
            Err(ResourceReloadClaimError::Reloading)
        );
        assert!(!finish_resource_reload(
            &mut operations,
            token.wrapping_add(1)
        ));
        assert!(
            operations.reloading.is_some(),
            "a stale cleanup cannot lift the fence"
        );
        assert!(finish_resource_reload(&mut operations, token));
        assert!(begin_runtime_write(&mut operations).is_ok());
        finish_runtime_write(&mut operations);
    }

    #[test]
    fn resource_reload_broadcast_is_success_only_and_contains_no_runtime_secrets() {
        let success = ReloadAgentResourcesResult {
            status: "reloaded".to_string(),
            supported: true,
            reason: None,
        };
        let pending = ReloadAgentResourcesResult {
            status: "pending".to_string(),
            supported: true,
            reason: Some("timeout".to_string()),
        };
        assert!(should_emit_resources_reloaded(&success));
        assert!(!should_emit_resources_reloaded(&pending));
        assert_eq!(
            serde_json::to_value(AgentResourcesReloadedEvent {
                conversation_id: "conversation-a".to_string(),
            })
            .expect("event payload"),
            json!({ "conversationId": "conversation-a" })
        );
    }

    #[test]
    fn hard_reload_acknowledgement_timeout_is_treated_as_unknown_not_failure() {
        assert!(is_reload_acknowledgement_timeout(
            "Le daemon Prime Agent n’a pas répondu au rechargement après 135 secondes."
        ));
        assert!(is_reload_acknowledgement_timeout(
            "Timed out after 120000ms waiting for the Prime Agent daemon response to \"reload\""
        ));
        assert!(!is_reload_acknowledgement_timeout(
            "Prime Agent a refusé de recharger les ressources."
        ));
    }

    #[test]
    fn restart_reuses_the_exact_resume_and_model_arguments() {
        let arguments = rpc_launch_arguments(
            Some(Path::new("C:\\sessions\\one.jsonl")),
            Some("openai"),
            Some("gpt-5.6-sol"),
            Some("xhigh"),
        )
        .into_iter()
        .map(|value| value.to_string_lossy().into_owned())
        .collect::<Vec<_>>();
        assert_eq!(
            arguments,
            [
                "--mode",
                "rpc",
                "--resume",
                "C:\\sessions\\one.jsonl",
                "--provider",
                "openai",
                "--model",
                "gpt-5.6-sol",
                "--thinking",
                "xhigh",
            ]
        );
    }

    #[test]
    fn stale_processes_cannot_replace_a_new_restart_slot() {
        assert!(restart_slot_matches(42, true, 42));
        assert!(!restart_slot_matches(43, true, 42));
        assert!(!restart_slot_matches(42, false, 42));
        assert!(!waiter_may_remove_slot(42, true, 42));
        assert!(waiter_may_remove_slot(42, false, 42));
        assert!(!waiter_may_remove_slot(41, false, 42));
    }

    #[test]
    fn restart_result_exposes_both_process_identities() {
        let result = RestartAgentResult {
            previous_pid: 41,
            agent: RunningAgentInfo {
                pid: 42,
                session_id: Some("session-one".to_string()),
                ..info("conversation-a", Some("C:\\sessions\\one.jsonl"))
            },
        };
        let value = serde_json::to_value(result).expect("restart result JSON");
        assert_eq!(value["previousPid"], 41);
        assert_eq!(value["agent"]["pid"], 42);
        assert_eq!(value["agent"]["sessionId"], "session-one");
    }

    #[test]
    fn restart_eof_releases_the_retained_rpc_stdin_and_child() {
        let mut command = {
            #[cfg(windows)]
            {
                let mut command = std::process::Command::new(
                    std::env::var_os("COMSPEC").unwrap_or_else(|| "cmd.exe".into()),
                );
                command.args(["/D", "/Q", "/C", "more >NUL"]);
                crate::runtime::hide_secondary_console(&mut command);
                command
            }
            #[cfg(not(windows))]
            {
                let mut command = std::process::Command::new("sh");
                command.args(["-c", "cat >/dev/null"]);
                command
            }
        };
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn EOF fixture");
        let stdin = Arc::new(Mutex::new(child.stdin.take()));
        let child = Arc::new(Mutex::new(child));

        close_rpc_stdin_for_restart(&stdin).expect("close retained RPC stdin");
        assert!(stdin.lock().is_none(), "the retained pipe must be consumed");
        let status = wait_for_child_until(&child, Duration::from_secs(5))
            .expect("wait for EOF fixture")
            .expect("EOF fixture should exit promptly");
        assert!(status.success(), "EOF fixture exited with {status}");
    }
}
