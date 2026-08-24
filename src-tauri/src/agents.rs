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
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
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
const PLAN_RUNTIME_TOOLS: &str =
    "prime_orbit_plan_inspect,prime_orbit_plan_question,prime_orbit_plan_submit";
const PLAN_UI_TITLE_PREFIX: &str = "prime-orbit-plan-ui:v1:";
const MAX_PENDING_EXTENSION_UI_REQUESTS: usize = 32;
const MAX_PENDING_EXTENSION_UI_REQUEST_BYTES: usize = 512 * 1024;
const MAX_PUBLIC_AGENT_MESSAGE_ID_SUFFIX_CHARS: usize = 200;
const MAX_PUBLIC_AGENT_MESSAGE_TEXT_CHARS: usize = 16_000;
const MAX_PUBLIC_AGENT_NAME_CHARS: usize = 160;
const INVALID_AGENT_MESSAGE_PLACEHOLDER: &str =
    "[Message inter-agent invalide masqué par Prime Orbit]";
const MAX_PUBLIC_REFINEMENT_ID_CHARS: usize = 200;
const MAX_PUBLIC_REFINEMENT_SUMMARY_CHARS: usize = 480;
const MAX_PUBLIC_REFINEMENT_DETAIL_CHARS: usize = 1_200;
const MAX_PUBLIC_REFINEMENT_EDITS: usize = 64;
const INVALID_REFINEMENT_OUTCOME_PLACEHOLDER: &str =
    "[Résultat de refinement invalide masqué par Prime Orbit]";
const LEGACY_MANAGED_SOURCE_DIR_NAME: &str = "prime-agent";
const VERSIONED_MANAGED_SOURCE_DIR_PREFIX: &str = "prime-agent-v";
const MAX_MANAGED_GENERATION_NAME_BYTES: usize = 80;
const PRIME_ORBIT_DAEMON_SOCKET_ENV: &str = "PRIME_ORBIT_DAEMON_SOCKET";
#[cfg(windows)]
const MAX_GENERATION_DAEMON_SOCKET_BYTES: usize = 240;
#[cfg(not(windows))]
const MAX_GENERATION_DAEMON_SOCKET_BYTES: usize = 100;

#[derive(Clone)]
pub struct AgentsState(
    Arc<Mutex<HashMap<String, RunningAgent>>>,
    Arc<AtomicBool>,
    Arc<Mutex<HashMap<PathBuf, ManagedDaemonShutdownTarget>>>,
);

impl Default for AgentsState {
    fn default() -> Self {
        Self(
            Arc::new(Mutex::new(HashMap::new())),
            Arc::new(AtomicBool::new(false)),
            Arc::new(Mutex::new(HashMap::new())),
        )
    }
}

/// Process-wide maintenance fence held from the final pre-install agent count
/// until the updater either fails or terminates the application. New agent
/// launches and emergency restarts fail closed while the fence is held.
pub struct UpdateInstallationGuard(AgentsState);

impl Drop for UpdateInstallationGuard {
    fn drop(&mut self) {
        self.0 .1.store(false, Ordering::SeqCst);
    }
}

pub fn begin_update_installation(agents: &AgentsState) -> Result<UpdateInstallationGuard, String> {
    agents
        .1
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .map_err(|_| "Une installation de mise à jour est déjà en cours.".to_string())?;
    Ok(UpdateInstallationGuard(agents.clone()))
}

fn ensure_update_installation_is_idle(agents: &AgentsState) -> Result<(), String> {
    if agents.1.load(Ordering::SeqCst) {
        return Err(
            "Prime Orbit prépare une mise à jour. Attendez la fin de l’installation avant de démarrer ou redémarrer une session."
                .to_string(),
        );
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentRuntimeMode {
    #[default]
    Normal,
    Plan,
}

#[derive(Clone)]
struct PendingExtensionUiRecord {
    id: String,
    line: String,
}

#[derive(Clone)]
struct RunningAgent {
    info: RunningAgentInfo,
    append_system_prompt: Option<String>,
    pending_extension_ui_requests: Vec<PendingExtensionUiRecord>,
    _plan_extension_guard: Option<Arc<fs::File>>,
    daemon_socket: Option<PathBuf>,
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

#[derive(Clone)]
struct ManagedDaemonShutdownTarget {
    node: PathBuf,
    cli: PathBuf,
    socket: PathBuf,
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
    direct_session_operation: Option<DirectSessionOperationMarker>,
    next_direct_session_operation_token: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DirectSessionOperationKind {
    Compact,
    Refine,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct DirectSessionOperationMarker {
    token: u64,
    kind: DirectSessionOperationKind,
    acknowledgement_timed_out: bool,
    terminal_event_seen: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct RpcAdmissionClaim {
    previous_busy: Option<bool>,
    direct_session_operation_token: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RpcAdmissionError {
    Busy,
    Reloading,
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
    pub runtime_mode: AgentRuntimeMode,
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
    _plan_extension_guard: Option<Arc<fs::File>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentLineEvent {
    conversation_id: String,
    line: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExtensionUiResolvedEvent {
    conversation_id: String,
    request_id: String,
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
    expected_lane: Vec<String>,
    mutation: QueuedMessageMutation,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueMutationGuard {
    expected_text: String,
    expected_lane: Vec<String>,
}

struct QueueMutationOperation {
    owner: String,
    conversation_id: String,
    lane: String,
    index: usize,
    expected_text: String,
    expected_lane: Vec<String>,
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

#[derive(Serialize)]
struct DaemonShutdownBridgeRequest {
    action: &'static str,
}

#[derive(Deserialize)]
struct DaemonShutdownBridgeResult {
    status: String,
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

fn parsed_extension_ui_request(record: &[u8]) -> Option<(String, bool, bool)> {
    let event: Value = serde_json::from_slice(record).ok()?;
    if event.get("type").and_then(Value::as_str) != Some("extension_ui_request") {
        return None;
    }
    let id = event.get("id").and_then(Value::as_str)?;
    if id.is_empty() || id.len() > 256 {
        return None;
    }
    let method = event
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let awaits_response = matches!(method, "select" | "confirm" | "input" | "editor");
    let claimed_plan_request = event
        .get("title")
        .and_then(Value::as_str)
        .is_some_and(|title| title.starts_with(PLAN_UI_TITLE_PREFIX));
    Some((id.to_string(), awaits_response, claimed_plan_request))
}

fn is_plan_review_request(event: &Value) -> bool {
    if event.get("type").and_then(Value::as_str) != Some("extension_ui_request")
        || event.get("method").and_then(Value::as_str) != Some("select")
    {
        return false;
    }
    let Some(title) = event.get("title").and_then(Value::as_str) else {
        return false;
    };
    let Some(token) = title
        .split_once('\n')
        .map(|(marker, _)| marker)
        .and_then(|marker| marker.strip_prefix(PLAN_UI_TITLE_PREFIX))
    else {
        return false;
    };
    if token.is_empty() || token.len() > 65_536 {
        return false;
    }
    let Ok(bytes) = URL_SAFE_NO_PAD.decode(token) else {
        return false;
    };
    if bytes.len() > 49_152 {
        return false;
    }
    let Ok(payload) = serde_json::from_slice::<Value>(&bytes) else {
        return false;
    };
    payload.get("v").and_then(Value::as_u64) == Some(1)
        && payload.get("kind").and_then(Value::as_str) == Some("review")
        && payload
            .get("planId")
            .and_then(Value::as_str)
            .is_some_and(|value| !value.is_empty() && value.len() <= 200)
        && payload
            .get("title")
            .and_then(Value::as_str)
            .is_some_and(|value| !value.is_empty() && value.chars().count() <= 512)
}

#[cfg(test)]
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

fn cache_pending_extension_ui_request(
    pending: &mut Vec<PendingExtensionUiRecord>,
    id: String,
    line: String,
) -> bool {
    if line.len() > MAX_PENDING_EXTENSION_UI_REQUEST_BYTES {
        return false;
    }
    if let Some(existing) = pending.iter_mut().find(|request| request.id == id) {
        existing.line = line;
        return true;
    }
    if pending.len() >= MAX_PENDING_EXTENSION_UI_REQUESTS {
        pending.remove(0);
    }
    pending.push(PendingExtensionUiRecord { id, line });
    true
}

struct ExtensionRequestRoute {
    owner: Option<String>,
    plan_attention_request_id: Option<String>,
}

fn extension_request_target(
    agents: &AgentsState,
    conversation_id: &str,
    pid: u32,
    record: &[u8],
    public_line: &str,
) -> Option<ExtensionRequestRoute> {
    let (id, awaits_response, claimed_plan_request) = parsed_extension_ui_request(record)?;
    let mut map = agents.0.lock();
    let agent = map
        .get_mut(conversation_id)
        .filter(|agent| agent.info.pid == pid && !agent.restarting)?;
    if awaits_response {
        cache_pending_extension_ui_request(
            &mut agent.pending_extension_ui_requests,
            id.clone(),
            public_line.to_string(),
        );
    }
    let plan_attention_request_id = (awaits_response
        && claimed_plan_request
        && agent.info.runtime_mode == AgentRuntimeMode::Plan)
        .then_some(id);
    Some(ExtensionRequestRoute {
        owner: agent.interactive_owner.clone(),
        plan_attention_request_id,
    })
}

fn emit_runtime_line(
    app: &AppHandle,
    event_name: &str,
    conversation_id: &str,
    line: String,
    target: Option<ExtensionRequestRoute>,
) {
    let event = AgentLineEvent {
        conversation_id: conversation_id.to_string(),
        line,
    };
    match target {
        Some(route) => {
            // Delivery acknowledgement from Tauri does not prove that a live
            // renderer listener received the event. Always invoke the native
            // notifier for blocking Plan requests; its own all-WebView focus
            // check and process-wide request-key dedupe suppress duplicates.
            if let Some(request_id) = route.plan_attention_request_id.as_deref() {
                let _ = crate::notifications::notify_plan_attention_from_runtime(
                    app,
                    conversation_id,
                    request_id,
                );
            }
            if let Some(owner) = route.owner.as_deref() {
                let _ = app.emit_to(owner, event_name, event);
            }
        }
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

fn canonical_public_agent_message_id(value: &Value) -> Option<String> {
    let id = value.as_str()?.trim();
    let suffix = id.strip_prefix("agentmsg_")?;
    if suffix.is_empty()
        || suffix.chars().count() > MAX_PUBLIC_AGENT_MESSAGE_ID_SUFFIX_CHARS
        || !suffix
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-')
    {
        return None;
    }
    Some(id.to_string())
}

fn bounded_public_agent_message_text(value: &str) -> String {
    let mut text = value.to_string();
    let _ = strip_orbit_string(&mut text);
    if text.chars().count() <= MAX_PUBLIC_AGENT_MESSAGE_TEXT_CHARS {
        return text;
    }
    const SUFFIX: &str = "\n… [message inter-agent tronqué]";
    let keep = MAX_PUBLIC_AGENT_MESSAGE_TEXT_CHARS.saturating_sub(SUFFIX.chars().count());
    let mut bounded = text.chars().take(keep).collect::<String>();
    bounded.push_str(SUFFIX);
    bounded
}

fn bounded_public_agent_name(value: &Value) -> Option<String> {
    let raw_name = value.get("sessionName")?.as_str()?;
    let mut name = String::new();
    let mut written = 0_usize;
    let mut truncated = false;
    'words: for word in raw_name.split_whitespace() {
        if !name.is_empty() {
            if written >= MAX_PUBLIC_AGENT_NAME_CHARS {
                truncated = true;
                break;
            }
            name.push(' ');
            written += 1;
        }
        for character in word.chars() {
            if written >= MAX_PUBLIC_AGENT_NAME_CHARS {
                truncated = true;
                break 'words;
            }
            name.push(character);
            written += 1;
        }
    }
    if name.is_empty() {
        return None;
    }
    if truncated && written == MAX_PUBLIC_AGENT_NAME_CHARS {
        name.pop();
        name.push('…');
    }
    Some(name)
}

fn public_agent_message_timestamp(object: &Map<String, Value>) -> Option<Value> {
    match object.get("timestamp")? {
        value @ Value::Number(_) => Some(value.clone()),
        Value::String(value)
            if value.chars().count() <= 64 && !value.chars().any(char::is_control) =>
        {
            Some(Value::String(value.clone()))
        }
        _ => None,
    }
}

fn public_agent_message_details(value: &Value) -> Option<(Value, String)> {
    let details = value.as_object()?;
    let id = canonical_public_agent_message_id(details.get("id")?)?;
    let raw_message = details.get("message")?.as_str()?;
    if raw_message.trim().is_empty() {
        return None;
    }
    let message = bounded_public_agent_message_text(raw_message);
    let mut public = Map::new();
    public.insert("id".to_string(), Value::String(id));
    public.insert("message".to_string(), Value::String(message.clone()));
    if let Some(from) = details.get("from").and_then(|value| {
        bounded_public_agent_name(value).map(|session_name| {
            Value::Object(Map::from_iter([(
                "sessionName".to_string(),
                Value::String(session_name),
            )]))
        })
    }) {
        public.insert("from".to_string(), from);
    }
    if let Some(relationship @ ("parent" | "sibling" | "child")) =
        details.get("fromRelationship").and_then(Value::as_str)
    {
        public.insert(
            "fromRelationship".to_string(),
            Value::String(relationship.to_string()),
        );
    }
    if let Some(target) = details.get("target").and_then(|value| {
        bounded_public_agent_name(value).map(|session_name| {
            Value::Object(Map::from_iter([(
                "sessionName".to_string(),
                Value::String(session_name),
            )]))
        })
    }) {
        public.insert("target".to_string(), target);
    }
    Some((Value::Object(public), message))
}

fn sanitize_agent_message_runtime_object(object: &mut Map<String, Value>) -> bool {
    if object.get("customType").and_then(Value::as_str) != Some("agent_message") {
        return false;
    }
    let timestamp = public_agent_message_timestamp(object);
    let details = (object.get("role").and_then(Value::as_str) == Some("custom")
        && object.get("display").and_then(Value::as_bool) == Some(true))
    .then(|| object.get("details").and_then(public_agent_message_details))
    .flatten();

    object.clear();
    object.insert("role".to_string(), Value::String("custom".to_string()));
    object.insert(
        "customType".to_string(),
        Value::String("agent_message".to_string()),
    );
    if let Some((details, message)) = details {
        object.insert("display".to_string(), Value::Bool(true));
        object.insert("content".to_string(), Value::String(message));
        object.insert("details".to_string(), details);
    } else {
        object.insert("display".to_string(), Value::Bool(false));
        object.insert(
            "content".to_string(),
            Value::String(INVALID_AGENT_MESSAGE_PLACEHOLDER.to_string()),
        );
    }
    if let Some(timestamp) = timestamp {
        object.insert("timestamp".to_string(), timestamp);
    }
    true
}

fn bounded_public_refinement_id(value: &Value) -> Option<String> {
    let raw = value.as_str()?.trim();
    if raw.is_empty()
        || raw.chars().count() > MAX_PUBLIC_REFINEMENT_ID_CHARS
        || raw.chars().any(char::is_control)
    {
        return None;
    }
    Some(raw.to_string())
}

fn bounded_public_refinement_text(value: &Value, limit: usize) -> Option<String> {
    let normalized = value
        .as_str()?
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if normalized.is_empty() {
        return None;
    }
    if normalized.chars().count() <= limit {
        return Some(normalized);
    }
    let mut bounded = normalized
        .chars()
        .take(limit.saturating_sub(1))
        .collect::<String>();
    bounded.push('…');
    Some(bounded)
}

fn public_refinement_outcome_edit(value: &Value) -> Option<Value> {
    let edit = value.as_object()?;
    let action = edit
        .get("action")
        .and_then(Value::as_str)
        .filter(|value| matches!(*value, "create" | "update" | "delete"))?;
    let kind = edit
        .get("kind")
        .and_then(Value::as_str)
        .filter(|value| matches!(*value, "prompt" | "memory" | "skill" | "subagent"))?;
    let id = bounded_public_refinement_id(edit.get("id")?)?;
    let applied = edit.get("applied").and_then(Value::as_bool)?;
    let mut public = Map::new();
    public.insert("action".to_string(), Value::String(action.to_string()));
    public.insert("kind".to_string(), Value::String(kind.to_string()));
    public.insert("id".to_string(), Value::String(id));
    public.insert("applied".to_string(), Value::Bool(applied));
    if let Some(title) = edit.get("title").and_then(|value| {
        bounded_public_refinement_text(value, MAX_PUBLIC_REFINEMENT_SUMMARY_CHARS)
    }) {
        public.insert("title".to_string(), Value::String(title));
    }
    if let Some(error) = edit
        .get("error")
        .and_then(|value| bounded_public_refinement_text(value, MAX_PUBLIC_REFINEMENT_DETAIL_CHARS))
    {
        public.insert("error".to_string(), Value::String(error));
    }
    Some(Value::Object(public))
}

fn public_refinement_outcome_details(value: &Value) -> Option<(Value, String)> {
    let details = value.as_object()?;
    let refinement_id = bounded_public_refinement_id(details.get("refinementId")?)?;
    let summary = bounded_public_refinement_text(
        details.get("summary")?,
        MAX_PUBLIC_REFINEMENT_SUMMARY_CHARS,
    )?;
    let scope = details
        .get("scope")
        .and_then(Value::as_str)
        .filter(|value| matches!(*value, "local" | "global"))?;
    let raw_edits = details.get("edits").and_then(Value::as_array)?;
    let edits = raw_edits
        .iter()
        .take(MAX_PUBLIC_REFINEMENT_EDITS)
        .map(public_refinement_outcome_edit)
        .collect::<Option<Vec<_>>>()?;
    let mut public = Map::new();
    public.insert("refinementId".to_string(), Value::String(refinement_id));
    public.insert("summary".to_string(), Value::String(summary.clone()));
    public.insert("scope".to_string(), Value::String(scope.to_string()));
    public.insert("edits".to_string(), Value::Array(edits));
    if let Some(rollback_of) = details
        .get("rollbackOf")
        .and_then(bounded_public_refinement_id)
    {
        public.insert("rollbackOf".to_string(), Value::String(rollback_of));
    }
    Some((Value::Object(public), summary))
}

fn sanitize_refinement_outcome_runtime_object(object: &mut Map<String, Value>) -> bool {
    if object.get("customType").and_then(Value::as_str) != Some("refinement_outcome") {
        return false;
    }
    let timestamp = public_agent_message_timestamp(object);
    let details = (object.get("role").and_then(Value::as_str) == Some("custom")
        && object.get("display").and_then(Value::as_bool) == Some(true))
    .then(|| {
        object
            .get("details")
            .and_then(public_refinement_outcome_details)
    })
    .flatten();

    object.clear();
    object.insert("role".to_string(), Value::String("custom".to_string()));
    object.insert(
        "customType".to_string(),
        Value::String("refinement_outcome".to_string()),
    );
    if let Some((details, summary)) = details {
        object.insert("display".to_string(), Value::Bool(true));
        object.insert("content".to_string(), Value::String(summary));
        object.insert("details".to_string(), details);
    } else {
        object.insert("display".to_string(), Value::Bool(false));
        object.insert(
            "content".to_string(),
            Value::String(INVALID_REFINEMENT_OUTCOME_PLACEHOLDER.to_string()),
        );
    }
    if let Some(timestamp) = timestamp {
        object.insert("timestamp".to_string(), timestamp);
    }
    true
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
            if sanitize_agent_message_runtime_object(object) {
                return;
            }
            if sanitize_refinement_outcome_runtime_object(object) {
                return;
            }
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
                let target = runtime_identity.as_ref().and_then(|(agents, pid)| {
                    extension_request_target(agents, &conversation_id, *pid, &record, &line)
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

fn is_daemon_response_acknowledgement_timeout(event: &Value, command: &str) -> bool {
    let Some(error) = event.get("error").and_then(Value::as_str) else {
        return false;
    };
    error.starts_with("Timed out after ")
        && error.contains("waiting for the Prime Agent daemon response")
        && error.contains(&format!("\"{command}\""))
}

fn runtime_busy_state(record: &[u8]) -> Option<bool> {
    let event: Value = serde_json::from_slice(record).ok()?;
    match event.get("type").and_then(Value::as_str) {
        Some("agent_start" | "auto_retry_start" | "compaction_start") => Some(true),
        Some("agent_end" | "turn_error") => Some(false),
        Some("compaction_end") => Some(
            event
                .get("willRetry")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        ),
        Some("auto_retry_end") if event.get("success").and_then(Value::as_bool) == Some(false) => {
            Some(false)
        }
        Some("response")
            if event.get("command").and_then(Value::as_str) == Some("prompt")
                && event.get("success").and_then(Value::as_bool) == Some(false) =>
        {
            Some(false)
        }
        Some("response") if event.get("command").and_then(Value::as_str) == Some("compact") => {
            if event.get("success").and_then(Value::as_bool) == Some(false)
                && is_daemon_response_acknowledgement_timeout(&event, "compact")
            {
                None
            } else {
                Some(false)
            }
        }
        Some("response") if event.get("command").and_then(Value::as_str) == Some("refine") => {
            if event.get("success").and_then(Value::as_bool) == Some(false)
                && is_daemon_response_acknowledgement_timeout(&event, "refine")
            {
                None
            } else {
                Some(false)
            }
        }
        Some("response")
            if event.get("command").and_then(Value::as_str) == Some("get_state")
                && event.get("success").and_then(Value::as_bool) != Some(false) =>
        {
            let data = event.get("data")?;
            let is_streaming = data.get("isStreaming").and_then(Value::as_bool);
            let is_compacting = data.get("isCompacting").and_then(Value::as_bool);
            match (is_streaming, is_compacting) {
                (None, None) => None,
                (is_streaming, is_compacting) => {
                    Some(is_streaming.unwrap_or(false) || is_compacting.unwrap_or(false))
                }
            }
        }
        _ => None,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DirectSessionOperationRuntimeEvent {
    Terminal {
        kind: DirectSessionOperationKind,
    },
    Response {
        kind: DirectSessionOperationKind,
        acknowledgement_timed_out: bool,
    },
}

fn terminal_clears_pending_extension_ui(record: &[u8]) -> bool {
    serde_json::from_slice::<Value>(record)
        .ok()
        .and_then(|event| {
            event
                .get("type")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .is_some_and(|event_type| matches!(event_type.as_str(), "agent_end" | "turn_error"))
}

fn direct_session_operation_runtime_event(
    record: &[u8],
) -> Option<DirectSessionOperationRuntimeEvent> {
    let event: Value = serde_json::from_slice(record).ok()?;
    match event.get("type").and_then(Value::as_str) {
        Some("compaction_end") => Some(DirectSessionOperationRuntimeEvent::Terminal {
            kind: DirectSessionOperationKind::Compact,
        }),
        Some("response") => {
            let kind = match event.get("command").and_then(Value::as_str) {
                Some("compact") => DirectSessionOperationKind::Compact,
                Some("refine") => DirectSessionOperationKind::Refine,
                _ => return None,
            };
            Some(DirectSessionOperationRuntimeEvent::Response {
                kind,
                acknowledgement_timed_out: event.get("success").and_then(Value::as_bool)
                    == Some(false)
                    && is_daemon_response_acknowledgement_timeout(
                        &event,
                        match kind {
                            DirectSessionOperationKind::Compact => "compact",
                            DirectSessionOperationKind::Refine => "refine",
                        },
                    ),
            })
        }
        _ => None,
    }
}

fn apply_direct_session_operation_runtime_event(
    operations: &mut AgentOperations,
    event: DirectSessionOperationRuntimeEvent,
) {
    let Some(marker) = operations.direct_session_operation.as_mut() else {
        return;
    };
    match event {
        DirectSessionOperationRuntimeEvent::Terminal { kind } if marker.kind == kind => {
            marker.terminal_event_seen = true;
            if marker.acknowledgement_timed_out {
                operations.direct_session_operation = None;
            }
        }
        DirectSessionOperationRuntimeEvent::Response {
            kind,
            acknowledgement_timed_out,
        } if marker.kind == kind => {
            if acknowledgement_timed_out && !marker.terminal_event_seen {
                marker.acknowledgement_timed_out = true;
            } else {
                operations.direct_session_operation = None;
            }
        }
        _ => {}
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
    let clear_pending_extension_ui = terminal_clears_pending_extension_ui(record);
    let direct_session_operation_event = direct_session_operation_runtime_event(record);
    let session_path = runtime_session_path(record).and_then(resolved_runtime_session_path);
    let session_id = runtime_session_id(record).filter(|id| {
        !id.is_empty()
            && id.len() <= 160
            && id.chars().all(|character| {
                character.is_ascii_alphanumeric() || matches!(character, '-' | '_')
            })
    });
    let launch_options = runtime_launch_options(record);
    if busy.is_none()
        && !clear_pending_extension_ui
        && direct_session_operation_event.is_none()
        && session_path.is_none()
        && session_id.is_none()
        && launch_options.is_none()
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
        if clear_pending_extension_ui {
            agent.pending_extension_ui_requests.clear();
        }
        if let Some(event) = direct_session_operation_event {
            apply_direct_session_operation_runtime_event(&mut agent.operations, event);
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
    agent.operations.reloading.is_some()
        || agent.operations.runtime_writes > 0
        || agent.operations.direct_session_operation.is_some()
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

fn direct_session_operation_kind(payload_type: Option<&str>) -> Option<DirectSessionOperationKind> {
    match payload_type {
        Some("compact") => Some(DirectSessionOperationKind::Compact),
        Some("refine") => Some(DirectSessionOperationKind::Refine),
        _ => None,
    }
}

fn begin_rpc_admission(
    busy: &mut bool,
    operations: &mut AgentOperations,
    payload_type: Option<&str>,
) -> Result<RpcAdmissionClaim, RpcAdmissionError> {
    let direct_kind = direct_session_operation_kind(payload_type);
    if direct_kind.is_some() && (*busy || operations.direct_session_operation.is_some()) {
        return Err(RpcAdmissionError::Busy);
    }
    begin_runtime_write(operations).map_err(|_| RpcAdmissionError::Reloading)?;

    let previous_busy = rpc_starts_busy_operation(payload_type).then_some(*busy);
    if previous_busy.is_some() {
        // This mutation happens under the process-wide agent map lock. It
        // closes admission before the first byte reaches stdin, so another
        // window cannot start another direct compact/refine in the write gap.
        *busy = true;
    }
    let direct_session_operation_token = direct_kind.map(|kind| {
        let token = operations
            .next_direct_session_operation_token
            .wrapping_add(1)
            .max(1);
        operations.next_direct_session_operation_token = token;
        operations.direct_session_operation = Some(DirectSessionOperationMarker {
            token,
            kind,
            acknowledgement_timed_out: false,
            terminal_event_seen: false,
        });
        token
    });
    Ok(RpcAdmissionClaim {
        previous_busy,
        direct_session_operation_token,
    })
}

fn finish_direct_session_operation(operations: &mut AgentOperations, token: u64) -> bool {
    if operations
        .direct_session_operation
        .is_some_and(|marker| marker.token == token)
    {
        operations.direct_session_operation = None;
        return true;
    }
    false
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
    if operations.runtime_writes > 0 || operations.direct_session_operation.is_some() {
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
    direct_session_operation_token: Option<u64>,
    pending_extension_ui_claim: Option<PendingExtensionUiRecord>,
}

impl RuntimeWriteGuard {
    fn new(
        agents: AgentsState,
        conversation_id: String,
        pid: u32,
        started_at: u64,
        restore_busy_on_error: Option<bool>,
        direct_session_operation_token: Option<u64>,
        pending_extension_ui_claim: Option<PendingExtensionUiRecord>,
    ) -> Self {
        Self {
            agents,
            conversation_id,
            pid,
            started_at,
            restore_busy_on_error,
            direct_session_operation_token,
            pending_extension_ui_claim,
        }
    }

    fn commit(&mut self) {
        self.restore_busy_on_error = None;
        self.direct_session_operation_token = None;
        self.pending_extension_ui_claim = None;
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
            if let Some(token) = self.direct_session_operation_token {
                finish_direct_session_operation(&mut agent.operations, token);
            }
            if let Some(request) = self.pending_extension_ui_claim.take() {
                if !agent
                    .pending_extension_ui_requests
                    .iter()
                    .any(|pending| pending.id == request.id)
                {
                    agent.pending_extension_ui_requests.push(request);
                }
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

fn is_versioned_managed_generation_name(name: &str) -> bool {
    if name.len() > MAX_MANAGED_GENERATION_NAME_BYTES {
        return false;
    }
    let Some(generation) = name.strip_prefix(VERSIONED_MANAGED_SOURCE_DIR_PREFIX) else {
        return false;
    };
    let Some((version, identifier)) = generation.rsplit_once('-') else {
        return false;
    };
    let mut version_parts = version.split('.');
    let valid_version = (0..3).all(|_| {
        version_parts.next().is_some_and(|part| {
            !part.is_empty() && part.len() <= 10 && part.bytes().all(|byte| byte.is_ascii_digit())
        })
    }) && version_parts.next().is_none();
    let valid_identifier = identifier.len() == 32
        && identifier
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte));
    valid_version && valid_identifier
}

/// Assigns an immutable managed runtime generation its own daemon endpoint.
/// The value is derived only from the strictly validated generation directory,
/// so separate Orbit windows that use the same generation converge on the same
/// daemon while a side-by-side update cannot collide with the old generation.
fn managed_generation_daemon_socket(launch_spec: &LaunchSpec) -> Result<Option<PathBuf>, String> {
    let LaunchSpec::Source {
        source_dir,
        managed,
        ..
    } = launch_spec
    else {
        return Ok(None);
    };
    if !managed {
        return Ok(None);
    }
    let generation = source_dir
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "Le nom de la génération Prime Agent gérée est invalide.".to_string())?;
    if generation == LEGACY_MANAGED_SOURCE_DIR_NAME {
        return Ok(None);
    }
    if !is_versioned_managed_generation_name(generation) {
        return Err(format!(
            "La génération Prime Agent gérée {generation:?} n’a pas un identifiant versionné valide."
        ));
    }

    #[cfg(windows)]
    let socket = PathBuf::from(format!(r"\\.\pipe\prime-orbit-daemon-{generation}"));
    #[cfg(not(windows))]
    let socket = PathBuf::from(format!("/tmp/prime-orbit-daemon-{generation}.sock"));

    let socket_text = socket.to_str().ok_or_else(|| {
        "Le socket de daemon Prime Agent calculé n’est pas représentable en UTF-8.".to_string()
    })?;
    if socket_text.is_empty()
        || socket_text.len() > MAX_GENERATION_DAEMON_SOCKET_BYTES
        || socket_text.bytes().any(|byte| byte.is_ascii_control())
    {
        return Err(
            "Le socket de daemon Prime Agent calculé est invalide ou trop long.".to_string(),
        );
    }
    Ok(Some(socket))
}

fn managed_daemon_shutdown_target(
    launch_spec: &LaunchSpec,
    daemon_socket: Option<&Path>,
) -> Option<ManagedDaemonShutdownTarget> {
    let LaunchSpec::Source {
        node,
        cli,
        managed: true,
        ..
    } = launch_spec
    else {
        return None;
    };
    Some(ManagedDaemonShutdownTarget {
        node: node.clone(),
        cli: cli.clone(),
        socket: daemon_socket?.to_path_buf(),
    })
}

fn configure_bridge_daemon_socket(command: &mut std::process::Command, socket: Option<&Path>) {
    // A user-defined parent environment must never redirect Orbit's private
    // bridges. Only the endpoint selected and retained by the native runtime is
    // allowed to cross this process boundary.
    command.env_remove(PRIME_ORBIT_DAEMON_SOCKET_ENV);
    if let Some(socket) = socket {
        command.env(PRIME_ORBIT_DAEMON_SOCKET_ENV, socket);
    }
}

#[allow(clippy::too_many_arguments)]
fn rpc_launch_arguments(
    session_path: Option<&Path>,
    provider: Option<&str>,
    model: Option<&str>,
    thinking: Option<&str>,
    append_system_prompt: Option<&str>,
    runtime_mode: AgentRuntimeMode,
    plan_extension: Option<&Path>,
    daemon_socket: Option<&Path>,
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
    if runtime_mode == AgentRuntimeMode::Normal {
        if let Some(value) = append_system_prompt {
            arguments.push(OsString::from("--append-system-prompt"));
            arguments.push(OsString::from(value));
        }
    }
    if runtime_mode == AgentRuntimeMode::Plan {
        // Prime Agent treats --tools as both the initial active set and the
        // registry allowlist. --no-extensions still admits the one explicit
        // CLI extension, while project/global extensions and skills disappear.
        arguments.push(OsString::from("--no-extensions"));
        arguments.push(OsString::from("--no-skills"));
        arguments.push(OsString::from("--no-prompt-templates"));
        arguments.push(OsString::from("--tools"));
        arguments.push(OsString::from(PLAN_RUNTIME_TOOLS));
        if let Some(path) = plan_extension {
            arguments.push(OsString::from("--extension"));
            arguments.push(path.as_os_str().to_owned());
        }
    }
    if let Some(path) = daemon_socket {
        arguments.push(OsString::from("--daemon-socket"));
        arguments.push(path.as_os_str().to_owned());
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
    append_system_prompt: Option<String>,
    runtime_mode: AgentRuntimeMode,
    daemon_socket: Option<&Path>,
    launch_spec: &LaunchSpec,
) -> Result<SpawnedRpcAgent, String> {
    let (plan_extension, plan_extension_guard) = if runtime_mode == AgentRuntimeMode::Plan {
        let path = crate::plan_mode::ensure_plan_extension(app)?;
        let guard = crate::plan_mode::lock_plan_extension_for_launch(&path)?;
        (Some(path), Some(guard))
    } else {
        (None, None)
    };
    let arguments = rpc_launch_arguments(
        session_path,
        provider.as_deref(),
        model.as_deref(),
        thinking.as_deref(),
        append_system_prompt.as_deref(),
        runtime_mode,
        plan_extension.as_deref(),
        daemon_socket,
    );

    let mut command = launch_spec.command(&arguments);
    #[cfg(windows)]
    if let LaunchSpec::Source { source_dir, .. } = launch_spec {
        crate::node_compat::configure_source_rpc(app, &mut command, Some(source_dir))?;
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
            runtime_mode,
            started_at: now_millis(),
        },
        child: Arc::new(Mutex::new(child)),
        stdin: Arc::new(Mutex::new(Some(stdin))),
        stdout,
        stderr,
        exit_emitted: Arc::new(AtomicBool::new(false)),
        _plan_extension_guard: plan_extension_guard,
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
    append_system_prompt: Option<String>,
    runtime_mode: AgentRuntimeMode,
) -> Result<RunningAgentInfo, String> {
    ensure_update_installation_is_idle(&agents)?;
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
    let append_system_prompt =
        validated_option(append_system_prompt, "appendSystemPrompt", 4 * 1024)?;

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
    let daemon_socket = managed_generation_daemon_socket(&launch_spec)?;

    let mut map = agents.0.lock();
    ensure_update_installation_is_idle(&agents)?;
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
        append_system_prompt.clone(),
        runtime_mode,
        daemon_socket.as_deref(),
        &launch_spec,
    )?;
    if let Some(target) = managed_daemon_shutdown_target(&launch_spec, daemon_socket.as_deref()) {
        agents.2.lock().insert(target.socket.clone(), target);
    }
    let info = spawned.info.clone();
    map.insert(
        conversation_id.clone(),
        RunningAgent {
            info: info.clone(),
            append_system_prompt,
            pending_extension_ui_requests: Vec::new(),
            _plan_extension_guard: spawned._plan_extension_guard.clone(),
            daemon_socket,
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
        && (payload_type != Some("extension_ui_response") || interactive_owner == Some(owner))
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

fn runtime_mode_matches_expected(
    actual: AgentRuntimeMode,
    expected: Option<AgentRuntimeMode>,
) -> bool {
    expected.is_none_or(|expected| actual == expected)
}

fn send_rpc_blocking(
    agents: AgentsState,
    attachments: AttachmentCache,
    owner: String,
    conversation_id: String,
    app_data_dir: PathBuf,
    mut payload: Value,
    expected_runtime_mode: Option<AgentRuntimeMode>,
) -> Result<(), String> {
    let conversation_id = validated_identifier(conversation_id)?;
    if !payload.is_object() {
        return Err("Le payload RPC doit être un objet JSON".to_string());
    }
    let option_update = requested_launch_option_update(&payload);
    let payload_type = payload.get("type").and_then(Value::as_str);
    let extension_ui_response_id = (payload_type == Some("extension_ui_response"))
        .then(|| {
            payload
                .get("id")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .flatten();
    let (stdin, session_path, session_id, pid, started_at, admission_claim, pending_ui_claim) = {
        let mut map = agents.0.lock();
        let agent = map
            .get_mut(&conversation_id)
            .ok_or_else(|| format!("Aucun Prime Agent actif pour {conversation_id}"))?;
        if !runtime_mode_matches_expected(agent.info.runtime_mode, expected_runtime_mode) {
            return Err(
                "Le runtime Prime Agent actif ne correspond plus au mode attendu de la conversation."
                    .to_string(),
            );
        }
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
        let pending_ui_position = if payload_type == Some("extension_ui_response") {
            let response_id = extension_ui_response_id.as_deref().ok_or_else(|| {
                "La réponse UI Prime Agent ne contient aucun identifiant valide.".to_string()
            })?;
            Some(
                agent
                    .pending_extension_ui_requests
                    .iter()
                    .position(|request| request.id == response_id)
                    .ok_or_else(|| {
                        "Cette requête UI Prime Agent est absente ou a déjà reçu une réponse."
                            .to_string()
                    })?,
            )
        } else {
            if agent.owners.contains(&owner) {
                agent.interactive_owner = Some(owner.clone());
            }
            None
        };
        let admission_claim = begin_rpc_admission(
            &mut agent.busy,
            &mut agent.operations,
            payload_type,
        )
        .map_err(|error| match error {
            RpcAdmissionError::Busy if payload_type == Some("refine") =>
                "Prime Agent est déjà occupé. Attendez la fin du tour ou du raffinement avant de lancer un nouveau raffinement."
                    .to_string(),
            RpcAdmissionError::Busy =>
                "Prime Agent est déjà occupé. Attendez la fin du tour ou du compactage avant de lancer un nouveau compactage."
                    .to_string(),
            RpcAdmissionError::Reloading => {
                "Les ressources Prime Agent sont en cours de rechargement. Aucun message ou réglage ne peut être envoyé pendant cette opération."
                    .to_string()
            }
        })?;
        let pending_ui_claim = pending_ui_position
            .map(|position| agent.pending_extension_ui_requests.remove(position));
        (
            Arc::clone(&agent.stdin),
            agent.info.session_path.clone(),
            agent.info.session_id.clone(),
            agent.info.pid,
            agent.info.started_at,
            admission_claim,
            pending_ui_claim,
        )
    };
    let mut runtime_write = RuntimeWriteGuard::new(
        agents.clone(),
        conversation_id.clone(),
        pid,
        started_at,
        admission_claim.previous_busy,
        admission_claim.direct_session_operation_token,
        pending_ui_claim,
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
        if option_update.is_some() {
            let mut map = agents.0.lock();
            if let Some(agent) = map
                .get_mut(&conversation_id)
                .filter(|agent| agent.info.pid == pid && !agent.restarting)
            {
                if let Some(update) = option_update {
                    apply_launch_option_update(&mut agent.info, update);
                }
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
        expected_lane,
        mutation,
        app_data_dir,
    } = operation;
    let conversation_id = validated_identifier(conversation_id)?;
    validate_queue_lane(&lane)?;
    validate_queued_message_text(&expected_text, "Le message attendu", true)?;
    if expected_lane.len() > 1_024 {
        return Err("La file attendue dépasse la taille autorisée.".to_string());
    }
    for text in &expected_lane {
        validate_queued_message_text(text, "Un message de la file attendue", true)?;
    }
    validate_queue_mutation(&mutation)?;

    let (launch_spec, daemon_socket, session_file, session_id, pid, started_at) = {
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
            agent.daemon_socket.clone(),
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
        None,
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
        expected_lane,
        mutation,
    };
    let request_json = serde_json::to_string(&request)
        .map_err(|error| format!("Impossible de préparer la mutation de file: {error}"))?;
    let arguments = [OsString::from("-e"), OsString::from(QUEUE_BRIDGE_SCRIPT)];
    let mut command = external_command(&node, &arguments);
    configure_bridge_daemon_socket(&mut command, daemon_socket.as_deref());
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
        "applied" | "rejected" | "invalid" | "unsupported" | "inactive"
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
    let (node, cli, daemon_socket, session_file, session_id, pid, started_at, token) = {
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
            agent.daemon_socket.clone(),
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
    configure_bridge_daemon_socket(&mut command, daemon_socket.as_deref());
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
    append_system_prompt: Option<String>,
    runtime_mode: AgentRuntimeMode,
    daemon_socket: Option<PathBuf>,
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
    requested_runtime_mode: Option<AgentRuntimeMode>,
) -> Result<RestartAgentResult, String> {
    ensure_update_installation_is_idle(&agents)?;
    let conversation_id = validated_identifier(conversation_id)?;
    let snapshot = {
        let mut map = agents.0.lock();
        let agent = map
            .get_mut(&conversation_id)
            .ok_or_else(|| format!("Aucun Prime Agent actif pour {conversation_id}"))?;
        if !agent.owners.contains(&owner) {
            return Err(
                "Cette fenêtre ne possède pas la conversation Prime Agent demandée.".to_string(),
            );
        }
        if requested_runtime_mode.is_some() && agent.interactive_owner.as_deref() != Some(&owner) {
            return Err(
                "Seule la fenêtre interactive peut changer le mode de cette conversation."
                    .to_string(),
            );
        }
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
        if requested_runtime_mode.is_some() && agent.busy {
            return Err(
                "Le mode de cette conversation ne peut changer que lorsque Prime Agent est au repos."
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
            append_system_prompt: agent.append_system_prompt.clone(),
            runtime_mode: requested_runtime_mode.unwrap_or(agent.info.runtime_mode),
            daemon_socket: agent.daemon_socket.clone(),
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
        if let Err(error) = ensure_update_installation_is_idle(&agents) {
            let removed = map.remove(&conversation_id);
            drop(map);
            if removed.is_some() {
                let _ = app.emit(
                    "prime-agent://exit",
                    AgentExitEvent {
                        conversation_id: conversation_id.clone(),
                        code: None,
                        success: false,
                        error: Some(
                            "Le redémarrage de Prime Agent a été annulé pour installer une mise à jour."
                                .to_string(),
                        ),
                    },
                );
            }
            return Err(error);
        }
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
            snapshot.append_system_prompt.clone(),
            snapshot.runtime_mode,
            snapshot.daemon_socket.as_deref(),
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
                append_system_prompt: snapshot.append_system_prompt,
                pending_extension_ui_requests: Vec::new(),
                _plan_extension_guard: spawned._plan_extension_guard.clone(),
                daemon_socket: snapshot.daemon_socket,
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

struct StopAgentSnapshot {
    child: Arc<Mutex<Child>>,
    exit_emitted: Arc<AtomicBool>,
    pid: u32,
    restarting: bool,
}

fn stop_agent_blocking(
    app: AppHandle,
    agents: AgentsState,
    owner: String,
    conversation_id: String,
) -> Result<bool, String> {
    let conversation_id = validated_identifier(conversation_id)?;
    // Snapshot the handles without removing the slot. The slot is only dropped
    // after the child is proven terminated, so a failed kill can never orphan a
    // running RPC client behind a freed conversation id.
    let snapshot = {
        let mut map = agents.0.lock();
        let Some(agent) = map.get_mut(&conversation_id) else {
            return Ok(false);
        };
        if agent.operations.reloading.is_some() {
            return Err(
                "Les ressources Prime Agent sont en cours de rechargement. Attendez leur confirmation avant d’arrêter cette connexion."
                    .to_string(),
            );
        }
        // Ownership mirrors restart_agent. An agent whose owners have all been
        // released (idle release still pending) remains stoppable by any window.
        if !agent.owners.contains(&owner) && !agent.owners.is_empty() {
            return Err(
                "Cette fenêtre ne possède pas la conversation Prime Agent demandée.".to_string(),
            );
        }
        StopAgentSnapshot {
            child: Arc::clone(&agent.child),
            exit_emitted: Arc::clone(&agent.exit_emitted),
            pid: agent.info.pid,
            restarting: agent.restarting,
        }
    };

    let status = terminate_child(&mut snapshot.child.lock())?;

    {
        let mut map = agents.0.lock();
        // Drop the slot only while it still refers to the exact process this
        // call terminated. A concurrent restart keeps ownership of the slot
        // until its replacement takes over under a new pid.
        let same_process = map
            .get(&conversation_id)
            .is_some_and(|agent| agent.info.pid == snapshot.pid && !agent.restarting);
        if same_process {
            map.remove(&conversation_id)
                .expect("agent slot checked under the same lock");
        }
    }

    if snapshot.restarting {
        // A concurrent explicit stop wins over emergency restart. Restart had
        // suppressed the old waiter's exit, so publish the stop result here.
        let _ = app.emit(
            "prime-agent://exit",
            AgentExitEvent {
                conversation_id: conversation_id.clone(),
                code: status.code(),
                success: status.success(),
                error: None,
            },
        );
    } else {
        emit_exit_once(
            &app,
            &conversation_id,
            &snapshot.exit_emitted,
            Ok(status),
            None,
        );
    }
    Ok(true)
}

fn pending_extension_ui_requests_blocking(
    agents: AgentsState,
    owner: String,
    conversation_id: String,
) -> Result<Vec<AgentLineEvent>, String> {
    let conversation_id = validated_identifier(conversation_id)?;
    let map = agents.0.lock();
    let Some(agent) = map.get(&conversation_id) else {
        return Ok(Vec::new());
    };
    if agent.interactive_owner.as_deref() != Some(owner.as_str()) {
        return Err(
            "Cette fenêtre n’est pas propriétaire des demandes interactives de cette conversation."
                .to_string(),
        );
    }
    Ok(agent
        .pending_extension_ui_requests
        .iter()
        .map(|request| AgentLineEvent {
            conversation_id: conversation_id.clone(),
            line: request.line.clone(),
        })
        .collect())
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
    append_system_prompt: Option<String>,
    runtime_mode: Option<AgentRuntimeMode>,
) -> Result<RunningAgentInfo, String> {
    let agents = agents.inner().clone();
    let owner = window.label().to_string();
    let runtime_mode = runtime_mode.unwrap_or_default();
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
            append_system_prompt,
            runtime_mode,
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
    let agents = agents.inner().clone();
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
    expected_runtime_mode: Option<AgentRuntimeMode>,
) -> Result<(), String> {
    let agents = agents.inner().clone();
    let attachments = attachments.inner().clone();
    let owner = window.label().to_string();
    let app = window.app_handle().clone();
    let resolved_request_id = (payload.get("type").and_then(Value::as_str)
        == Some("extension_ui_response"))
    .then(|| {
        payload
            .get("id")
            .and_then(Value::as_str)
            .map(str::to_string)
    })
    .flatten();
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Impossible de résoudre le stockage Prime Orbit: {error}"))?;
    crate::exports::validate_export_rpc_payload(
        exports.inner(),
        &owner,
        &conversation_id,
        &payload,
    )?;
    let resolved_conversation_id = conversation_id.clone();
    crate::run_blocking(move || {
        send_rpc_blocking(
            agents,
            attachments,
            owner,
            conversation_id,
            app_data_dir,
            payload,
            expected_runtime_mode,
        )
    })
    .await?;
    if let Some(request_id) = resolved_request_id {
        let _ = app.emit(
            "prime-agent://extension-ui-resolved",
            ExtensionUiResolvedEvent {
                conversation_id: resolved_conversation_id,
                request_id,
            },
        );
    }
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn mutate_agent_queue(
    window: tauri::WebviewWindow,
    agents: tauri::State<'_, AgentsState>,
    conversation_id: String,
    lane: String,
    index: usize,
    guard: QueueMutationGuard,
    mutation: QueuedMessageMutation,
) -> Result<QueueMutationResult, String> {
    let agents = agents.inner().clone();
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
                expected_text: guard.expected_text,
                expected_lane: guard.expected_lane,
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
    let agents = agents.inner().clone();
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
    window: tauri::WebviewWindow,
    agents: tauri::State<'_, AgentsState>,
    conversation_id: String,
) -> Result<bool, String> {
    let agents = agents.inner().clone();
    let owner = window.label().to_string();
    crate::run_blocking(move || stop_agent_blocking(app, agents, owner, conversation_id)).await
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
    runtime_mode: Option<AgentRuntimeMode>,
) -> Result<RestartAgentResult, String> {
    let agents = agents.inner().clone();
    let owner = window.label().to_string();
    crate::run_blocking(move || {
        restart_agent_blocking(app, agents, owner, conversation_id, runtime_mode)
    })
    .await
}

pub(crate) fn attest_plan_document_write(
    agents: &AgentsState,
    owner: &str,
    conversation_id: &str,
    request_id: &str,
    project_path: &Path,
) -> Result<(), String> {
    let conversation_id = validated_identifier(conversation_id.to_string())?;
    let request_id = validated_identifier(request_id.to_string())?;
    let map = agents.0.lock();
    let agent = map
        .get(&conversation_id)
        .ok_or_else(|| format!("Aucun Prime Agent actif pour {conversation_id}"))?;
    if agent.info.runtime_mode != AgentRuntimeMode::Plan {
        return Err("L’écriture d’un document Plan exige le runtime Plan isolé.".to_string());
    }
    let active_project = validated_cwd(agent.info.cwd.clone())?;
    let requested_project = validated_cwd(project_path.to_string_lossy().into_owned())?;
    if active_project != requested_project {
        return Err("Le document Plan ne cible pas le projet du runtime actif.".to_string());
    }
    if !agent.owners.contains(owner) || agent.interactive_owner.as_deref() != Some(owner) {
        return Err(
            "Seule la fenêtre interactive du runtime Plan peut enregistrer ce document."
                .to_string(),
        );
    }
    let pending = agent
        .pending_extension_ui_requests
        .iter()
        .find(|request| request.id == request_id)
        .ok_or_else(|| "La demande de validation Plan est absente ou déjà résolue.".to_string())?;
    let event: Value = serde_json::from_str(&pending.line)
        .map_err(|_| "La demande de validation Plan native est invalide.".to_string())?;
    if !is_plan_review_request(&event) {
        return Err("La demande native n’autorise pas l’écriture d’un document Plan.".to_string());
    }
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn list_pending_extension_ui_requests(
    window: tauri::WebviewWindow,
    agents: tauri::State<'_, AgentsState>,
    conversation_id: String,
) -> Result<Vec<AgentLineEvent>, String> {
    let agents = agents.inner().clone();
    let owner = window.label().to_string();
    crate::run_blocking(move || {
        pending_extension_ui_requests_blocking(agents, owner, conversation_id)
    })
    .await
}

#[tauri::command]
pub async fn list_running_agents(
    agents: tauri::State<'_, AgentsState>,
) -> Result<Vec<RunningAgentInfo>, String> {
    let agents = agents.inner().clone();
    crate::run_blocking(move || list_running_agents_blocking(agents)).await
}

pub fn running_agent_count(agents: &AgentsState) -> usize {
    agents.0.lock().len()
}

pub fn shutdown_all_agents(app: &AppHandle, agents: &AgentsState) {
    let running: Vec<_> = agents.0.lock().drain().collect();
    for (conversation_id, agent) in running {
        let status = terminate_child(&mut agent.child.lock());
        emit_exit_once(app, &conversation_id, &agent.exit_emitted, status, None);
    }
}

fn shutdown_managed_daemon_for_update(target: &ManagedDaemonShutdownTarget) -> Result<(), String> {
    let request = serde_json::to_vec(&DaemonShutdownBridgeRequest { action: "shutdown" }).map_err(
        |error| format!("Impossible de préparer l’arrêt du daemon Prime Agent: {error}"),
    )?;
    let arguments = [
        OsString::from("-e"),
        OsString::from(SESSION_CONTROL_BRIDGE_SCRIPT),
    ];
    let mut command = external_command(&target.node, &arguments);
    configure_bridge_daemon_socket(&mut command, Some(&target.socket));
    command
        .env("PRIME_ORBIT_CLI_PATH", &target.cli)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|error| format!("Impossible de lancer l’arrêt du daemon Prime Agent: {error}"))?;
    let write_result = child
        .stdin
        .take()
        .ok_or_else(|| {
            "Impossible d’ouvrir l’entrée de contrôle du daemon Prime Agent.".to_string()
        })
        .and_then(|mut stdin| {
            stdin.write_all(&request).map_err(|error| {
                format!("Impossible d’envoyer l’arrêt au daemon Prime Agent: {error}")
            })
        });
    if let Err(error) = write_result {
        let _ = child.kill();
        let _ = child.wait();
        return Err(error);
    }
    let output = child
        .wait_with_output()
        .map_err(|error| format!("Impossible d’attendre l’arrêt du daemon Prime Agent: {error}"))?;
    if !output.status.success() {
        let details = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if details.is_empty() {
            format!(
                "Le contrôle d’arrêt du daemon Prime Agent a quitté avec le statut {}.",
                output.status
            )
        } else {
            details
        });
    }
    let result: DaemonShutdownBridgeResult = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("Réponse d’arrêt du daemon Prime Agent invalide: {error}"))?;
    if result.status != "stopped" {
        return Err("Prime Agent n’a pas confirmé l’arrêt de son daemon.".to_string());
    }
    Ok(())
}

/// Stops every Prime Agent before installing an application update and fails
/// closed until both every RPC client and every private managed daemon have
/// been confirmed stopped. Failed child entries are restored to the registry
/// so the UI can retry or stop them explicitly after the installation fence is
/// released.
pub fn shutdown_all_agents_for_update(app: &AppHandle, agents: &AgentsState) -> Result<(), String> {
    let running: Vec<_> = agents.0.lock().drain().collect();
    let mut failed = Vec::new();

    for (conversation_id, agent) in running {
        let status = {
            let mut child = agent.child.lock();
            terminate_child(&mut child)
        };
        match status {
            Ok(status) => {
                emit_exit_once(app, &conversation_id, &agent.exit_emitted, Ok(status), None)
            }
            Err(error) => failed.push((conversation_id, agent, error)),
        }
    }

    if !failed.is_empty() {
        let mut failures = Vec::with_capacity(failed.len());
        let mut map = agents.0.lock();
        for (conversation_id, agent, error) in failed {
            failures.push(format!("{conversation_id}: {error}"));
            map.entry(conversation_id).or_insert(agent);
        }
        drop(map);

        return Err(format!(
            "La mise à jour a été annulée car Prime Orbit n’a pas pu confirmer l’arrêt de toutes les sessions Prime Agent: {}",
            failures.join("; ")
        ));
    }

    let targets: Vec<_> = agents.2.lock().values().cloned().collect();
    for target in targets {
        shutdown_managed_daemon_for_update(&target).map_err(|error| {
            format!(
                "La mise à jour a été annulée car le daemon Prime Agent n’a pas pu être arrêté proprement: {error}"
            )
        })?;
        agents.2.lock().remove(&target.socket);
    }
    Ok(())
}

pub fn release_window_agents(agents: AgentsState, owner: String) {
    release_owner_blocking(agents, &owner);
}

#[cfg(test)]
mod tests {
    use super::{
        acquire_owner_lease, append_diagnostic_tail, apply_direct_session_operation_runtime_event,
        apply_launch_option_update, begin_owned_resource_reload, begin_rpc_admission,
        begin_runtime_write, begin_update_installation, cache_pending_extension_ui_request,
        close_rpc_stdin_for_restart, conflicting_session_conversation,
        direct_session_operation_runtime_event, ensure_update_installation_is_idle,
        finish_resource_reload, finish_runtime_write, is_extension_ui_request,
        is_plan_review_request, is_reload_acknowledgement_timeout, lease_absence_attests_release,
        managed_daemon_shutdown_target, managed_generation_daemon_socket,
        mark_resource_reload_unknown, owner_may_send, parsed_extension_ui_request,
        public_runtime_line, release_owner_lease_state, requested_launch_option_update,
        restart_slot_matches, rpc_launch_arguments, rpc_starts_busy_operation, runtime_busy_state,
        runtime_launch_options, runtime_mode_matches_expected, runtime_session_id,
        runtime_session_path, should_emit_resources_reloaded, terminal_clears_pending_extension_ui,
        validate_queue_lane, validate_queue_mutation, validate_reload_result, wait_for_child_until,
        waiter_may_remove_slot, AgentOperations, AgentResourcesReloadedEvent, AgentRuntimeMode,
        AgentsState, DirectSessionOperationKind, DirectSessionOperationRuntimeEvent,
        LaunchOptionUpdate, LaunchSpec, QueuedMessageMutation, ReloadAgentResourcesResult,
        ResourceReloadClaimError, ResourceReloadPhase, RestartAgentResult, RpcAdmissionError,
        RunningAgentInfo, INVALID_AGENT_MESSAGE_PLACEHOLDER, MAX_EXIT_DIAGNOSTIC_BYTES,
        MAX_PENDING_EXTENSION_UI_REQUESTS, MAX_PENDING_EXTENSION_UI_REQUEST_BYTES,
    };
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
    use parking_lot::Mutex;
    use serde_json::{json, Value};
    use std::{
        collections::HashSet,
        path::{Path, PathBuf},
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
            runtime_mode: AgentRuntimeMode::Normal,
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
    fn pending_extension_dialogs_are_bounded_replaced_and_terminally_cleared() {
        let select = br#"{"type":"extension_ui_request","id":"request-1","method":"select"}"#;
        assert_eq!(
            parsed_extension_ui_request(select),
            Some(("request-1".to_string(), true, false))
        );
        let notify = br#"{"type":"extension_ui_request","id":"notice-1","method":"notify"}"#;
        assert_eq!(
            parsed_extension_ui_request(notify),
            Some(("notice-1".to_string(), false, false))
        );

        let plan = br#"{"type":"extension_ui_request","id":"plan-1","method":"select","title":"prime-orbit-plan-ui:v1:eyJ2IjoxLCJraW5kIjoicmV2aWV3IiwicGxhbklkIjoidG9vbC0xIiwidGl0bGUiOiJQbGFuIn0\nPlan"}"#;
        assert_eq!(
            parsed_extension_ui_request(plan),
            Some(("plan-1".to_string(), true, true))
        );
        assert!(is_plan_review_request(
            &serde_json::from_slice::<Value>(plan).unwrap()
        ));

        let mut pending = Vec::new();
        cache_pending_extension_ui_request(
            &mut pending,
            "request-1".to_string(),
            "first".to_string(),
        );
        cache_pending_extension_ui_request(
            &mut pending,
            "request-1".to_string(),
            "replacement".to_string(),
        );
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].line, "replacement");
        assert!(!cache_pending_extension_ui_request(
            &mut pending,
            "oversized".to_string(),
            "x".repeat(MAX_PENDING_EXTENSION_UI_REQUEST_BYTES + 1),
        ));
        assert_eq!(pending.len(), 1);
        for index in 0..=MAX_PENDING_EXTENSION_UI_REQUESTS {
            cache_pending_extension_ui_request(
                &mut pending,
                format!("request-{index}"),
                format!("line-{index}"),
            );
        }
        assert_eq!(pending.len(), MAX_PENDING_EXTENSION_UI_REQUESTS);
        assert_eq!(
            pending.last().map(|request| request.id.as_str()),
            Some("request-32")
        );
        assert!(terminal_clears_pending_extension_ui(
            br#"{"type":"agent_end"}"#
        ));
        assert!(terminal_clears_pending_extension_ui(
            br#"{"type":"turn_error"}"#
        ));
        assert!(!terminal_clears_pending_extension_ui(
            br#"{"type":"message_end"}"#
        ));
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
    fn runtime_records_whitelist_valid_agent_messages_before_ipc() {
        let record = json!({
            "type":"response",
            "command":"get_messages",
            "success":true,
            "data":{"messages":[{
                "role":"custom",
                "customType":"agent_message",
                "display":true,
                "timestamp":1_777_777,
                "content":"[from child:audit-security]\nAgent-to-agent message received.\nFrom: audit-security, active ACTIVE_SECRET, session SESSION_SECRET, client CLIENT_SECRET\nTo: main, active TARGET_ACTIVE_SECRET, session TARGET_SESSION_SECRET\nMessage id: agentmsg_test-123\n\nAudit terminé.",
                "details":{
                    "id":"agentmsg_test-123",
                    "message":"Audit terminé.",
                    "from":{
                        "sessionName":"  audit-security  ",
                        "activeSessionId":"ACTIVE_SECRET",
                        "sessionId":"SESSION_SECRET",
                        "runtimeKind":"subagent",
                        "clientId":"CLIENT_SECRET"
                    },
                    "fromRelationship":"child",
                    "target":{
                        "sessionName":"main",
                        "activeSessionId":"TARGET_ACTIVE_SECRET",
                        "sessionId":"TARGET_SESSION_SECRET",
                        "runtimeKind":"top-level"
                    },
                    "authorization":"Bearer AUTH_SECRET",
                    "arbitrary":{"private":"ARBITRARY_SECRET"}
                },
                "forgedTopLevel":"TOP_LEVEL_SECRET"
            }]}
        });

        let line = public_runtime_line(record.to_string().as_bytes());
        let public: Value = serde_json::from_str(&line).expect("public agent message JSON");
        assert_eq!(
            public["data"]["messages"][0],
            json!({
                "role":"custom",
                "customType":"agent_message",
                "display":true,
                "timestamp":1_777_777,
                "content":"Audit terminé.",
                "details":{
                    "id":"agentmsg_test-123",
                    "message":"Audit terminé.",
                    "from":{"sessionName":"audit-security"},
                    "fromRelationship":"child",
                    "target":{"sessionName":"main"}
                }
            })
        );
        for private_value in [
            "ACTIVE_SECRET",
            "SESSION_SECRET",
            "CLIENT_SECRET",
            "TARGET_ACTIVE_SECRET",
            "TARGET_SESSION_SECRET",
            "AUTH_SECRET",
            "ARBITRARY_SECRET",
            "TOP_LEVEL_SECRET",
            "activeSessionId",
            "sessionId",
            "clientId",
            "runtimeKind",
            "authorization",
            "arbitrary",
            "forgedTopLevel",
        ] {
            assert!(!line.contains(private_value), "leaked {private_value}");
        }
    }

    #[test]
    fn runtime_records_mask_invalid_or_forged_agent_messages_before_ipc() {
        let record = json!({
            "type":"response",
            "command":"get_messages",
            "success":true,
            "data":{"messages":[
                {
                    "role":"custom",
                    "customType":"agent_message",
                    "display":true,
                    "content":"RAW_PROTOCOL_SECRET",
                    "details":{
                        "id":"forged-id",
                        "message":"INVALID_MESSAGE_SECRET",
                        "from":{"sessionName":"audit", "sessionId":"INVALID_SESSION_SECRET"},
                        "fromRelationship":"child",
                        "target":{"sessionName":"main"},
                        "arbitrary":"INVALID_DETAIL_SECRET"
                    }
                },
                {
                    "role":"assistant",
                    "customType":"agent_message",
                    "display":true,
                    "content":"FORGED_ROLE_PROTOCOL_SECRET",
                    "details":{
                        "id":"agentmsg_forged-role",
                        "message":"FORGED_ROLE_MESSAGE_SECRET"
                    }
                }
            ]}
        });

        let line = public_runtime_line(record.to_string().as_bytes());
        let public: Value = serde_json::from_str(&line).expect("masked agent message JSON");
        for message in public["data"]["messages"]
            .as_array()
            .expect("message array")
        {
            assert_eq!(message["role"], "custom");
            assert_eq!(message["customType"], "agent_message");
            assert_eq!(message["display"], false);
            assert_eq!(message["content"], INVALID_AGENT_MESSAGE_PLACEHOLDER);
            assert!(message.get("details").is_none());
        }
        for private_value in [
            "RAW_PROTOCOL_SECRET",
            "INVALID_MESSAGE_SECRET",
            "INVALID_SESSION_SECRET",
            "INVALID_DETAIL_SECRET",
            "FORGED_ROLE_PROTOCOL_SECRET",
            "FORGED_ROLE_MESSAGE_SECRET",
            "forged-id",
            "agentmsg_forged-role",
            "sessionId",
            "arbitrary",
        ] {
            assert!(!line.contains(private_value), "leaked {private_value}");
        }
    }

    #[test]
    fn runtime_records_whitelist_refinement_outcomes_before_ipc() {
        let record = json!({
            "type":"message_start",
            "message":{
                "role":"custom",
                "customType":"refinement_outcome",
                "display":true,
                "timestamp":1_777_777,
                "content":"Refinement complete: RAW_FALLBACK",
                "details":{
                    "refinementId":"refine_runtime",
                    "summary":"Persist the verified runtime migration.",
                    "scope":"local",
                    "edits":[{
                        "action":"create","kind":"memory","id":"runtime-v080","title":"Prime Agent 0.8","applied":true,
                        "before":{"content":"PRIVATE_BEFORE"},"after":{"content":"PRIVATE_AFTER"},"metadata":{"token":"PRIVATE_TOKEN"}
                    }],
                    "harnessStatePath":"C:\\PRIVATE\\harness_state.json",
                    "rationale":"PRIVATE_RATIONALE"
                },
                "forgedTopLevel":"TOP_LEVEL_SECRET"
            }
        });

        let line = public_runtime_line(record.to_string().as_bytes());
        let public: Value = serde_json::from_str(&line).expect("public refinement outcome JSON");
        assert_eq!(
            public["message"],
            json!({
                "role":"custom",
                "customType":"refinement_outcome",
                "display":true,
                "timestamp":1_777_777,
                "content":"Persist the verified runtime migration.",
                "details":{
                    "refinementId":"refine_runtime",
                    "summary":"Persist the verified runtime migration.",
                    "scope":"local",
                    "edits":[{"action":"create","kind":"memory","id":"runtime-v080","title":"Prime Agent 0.8","applied":true}]
                }
            })
        );
        for private_value in [
            "RAW_FALLBACK",
            "PRIVATE_BEFORE",
            "PRIVATE_AFTER",
            "PRIVATE_TOKEN",
            "PRIVATE_RATIONALE",
            "TOP_LEVEL_SECRET",
            "harnessStatePath",
            "before",
            "after",
            "metadata",
        ] {
            assert!(!line.contains(private_value), "leaked {private_value}");
        }
    }

    #[test]
    fn prompt_runtime_expectation_fails_closed_on_mode_races() {
        assert!(runtime_mode_matches_expected(AgentRuntimeMode::Plan, None));
        assert!(runtime_mode_matches_expected(
            AgentRuntimeMode::Plan,
            Some(AgentRuntimeMode::Plan)
        ));
        assert!(!runtime_mode_matches_expected(
            AgentRuntimeMode::Normal,
            Some(AgentRuntimeMode::Plan)
        ));
        assert!(!runtime_mode_matches_expected(
            AgentRuntimeMode::Plan,
            Some(AgentRuntimeMode::Normal)
        ));
    }

    #[test]
    fn only_the_interactive_owner_can_answer_extension_ui() {
        let owners = HashSet::from(["workspace-2".to_string(), "main".to_string()]);
        assert!(owner_may_send(
            &owners,
            Some("workspace-2"),
            "workspace-2",
            Some("prompt"),
        ));
        assert!(!owner_may_send(
            &owners,
            Some("main"),
            "foreign",
            Some("prompt"),
        ));
        assert!(owner_may_send(
            &owners,
            Some("main"),
            "main",
            Some("extension_ui_response"),
        ));
        assert!(!owner_may_send(
            &owners,
            Some("main"),
            "workspace-2",
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
            runtime_busy_state(br#"{"type":"compaction_start","reason":"manual"}"#),
            Some(true),
        );
        assert_eq!(
            runtime_busy_state(br#"{"type":"compaction_end","reason":"manual","willRetry":false}"#,),
            Some(false),
        );
        assert_eq!(
            runtime_busy_state(br#"{"type":"compaction_end","reason":"manual"}"#),
            Some(false),
        );
        assert_eq!(
            runtime_busy_state(
                br#"{"type":"compaction_end","reason":"overflow","willRetry":true}"#,
            ),
            Some(true),
        );
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
        assert_eq!(
            runtime_busy_state(
                br#"{"type":"response","command":"get_state","success":true,"data":{"isStreaming":false,"isCompacting":true}}"#,
            ),
            Some(true),
        );
        assert_eq!(
            runtime_busy_state(
                br#"{"type":"response","command":"get_state","success":true,"data":{"isStreaming":true,"isCompacting":false}}"#,
            ),
            Some(true),
        );
        assert_eq!(
            runtime_busy_state(
                br#"{"type":"response","command":"compact","success":false,"error":"Timed out after 30000ms waiting for the Prime Agent daemon response to \"compact\". Socket: \\\\.\\pipe\\prime-agent-daemon."}"#,
            ),
            None,
        );
        assert_eq!(
            runtime_busy_state(
                br#"{"type":"response","command":"compact","success":false,"error":"Compaction refused"}"#,
            ),
            Some(false),
        );
        assert_eq!(
            runtime_busy_state(
                br#"{"type":"response","command":"refine","success":false,"error":"Timed out after 600000ms waiting for the Prime Agent daemon response to \"refine\"."}"#,
            ),
            None,
        );
        assert_eq!(
            runtime_busy_state(
                br#"{"type":"response","command":"refine","success":false,"error":"Refinement refused"}"#,
            ),
            Some(false),
        );
        assert!(rpc_starts_busy_operation(Some("prompt")));
        assert!(rpc_starts_busy_operation(Some("compact")));
        assert!(!rpc_starts_busy_operation(Some("get_state")));
    }

    #[test]
    fn concurrent_direct_compaction_admission_grants_exactly_one_writer() {
        let state = Arc::new(Mutex::new((false, AgentOperations::default())));
        let barrier = Arc::new(Barrier::new(2));
        let handles = (0..2)
            .map(|_| {
                let state = Arc::clone(&state);
                let barrier = Arc::clone(&barrier);
                thread::spawn(move || {
                    barrier.wait();
                    let mut state = state.lock();
                    let (busy, operations) = &mut *state;
                    begin_rpc_admission(busy, operations, Some("compact"))
                })
            })
            .collect::<Vec<_>>();
        let results = handles
            .into_iter()
            .map(|handle| handle.join().expect("admission worker"))
            .collect::<Vec<_>>();

        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(
            results
                .iter()
                .filter(|result| matches!(result, Err(RpcAdmissionError::Busy)))
                .count(),
            1,
        );
        let state = state.lock();
        assert!(state.0);
        assert_eq!(state.1.runtime_writes, 1);
        assert_eq!(
            state.1.direct_session_operation.map(|marker| marker.kind),
            Some(DirectSessionOperationKind::Compact),
        );
    }

    #[test]
    fn concurrent_direct_refine_admission_grants_exactly_one_writer() {
        let state = Arc::new(Mutex::new((false, AgentOperations::default())));
        let barrier = Arc::new(Barrier::new(2));
        let handles = (0..2)
            .map(|_| {
                let state = Arc::clone(&state);
                let barrier = Arc::clone(&barrier);
                thread::spawn(move || {
                    barrier.wait();
                    let mut state = state.lock();
                    let (busy, operations) = &mut *state;
                    begin_rpc_admission(busy, operations, Some("refine"))
                })
            })
            .collect::<Vec<_>>();
        let results = handles
            .into_iter()
            .map(|handle| handle.join().expect("admission worker"))
            .collect::<Vec<_>>();

        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(
            results
                .iter()
                .filter(|result| matches!(result, Err(RpcAdmissionError::Busy)))
                .count(),
            1,
        );
        let state = state.lock();
        assert!(state.0);
        assert_eq!(state.1.runtime_writes, 1);
        assert_eq!(
            state.1.direct_session_operation.map(|marker| marker.kind),
            Some(DirectSessionOperationKind::Refine),
        );
    }

    #[test]
    fn compact_fence_keeps_prompts_and_state_reads_available() {
        let mut busy = false;
        let mut operations = AgentOperations::default();
        let compact = begin_rpc_admission(&mut busy, &mut operations, Some("compact"))
            .expect("initial compact admission");
        assert_eq!(compact.previous_busy, Some(false));
        finish_runtime_write(&mut operations);

        let prompt = begin_rpc_admission(&mut busy, &mut operations, Some("prompt"))
            .expect("queued prompt remains admissible");
        assert_eq!(prompt.previous_busy, Some(true));
        finish_runtime_write(&mut operations);
        let state = begin_rpc_admission(&mut busy, &mut operations, Some("get_state"))
            .expect("state read remains admissible");
        assert_eq!(state.previous_busy, None);
        finish_runtime_write(&mut operations);

        assert_eq!(
            begin_owned_resource_reload(
                &HashSet::from(["main".to_string()]),
                "main",
                &mut operations,
            ),
            Err(ResourceReloadClaimError::RuntimeWrite),
        );
    }

    #[test]
    fn compact_timeout_retains_the_fence_until_compaction_end() {
        let timeout = br#"{"type":"response","command":"compact","success":false,"error":"Timed out after 30000ms waiting for the Prime Agent daemon response to \"compact\"."}"#;
        let ended = br#"{"type":"compaction_end","reason":"manual","willRetry":false}"#;
        let mut busy = false;
        let mut operations = AgentOperations::default();
        begin_rpc_admission(&mut busy, &mut operations, Some("compact"))
            .expect("compact admission");
        finish_runtime_write(&mut operations);

        assert_eq!(runtime_busy_state(timeout), None);
        apply_direct_session_operation_runtime_event(
            &mut operations,
            direct_session_operation_runtime_event(timeout).expect("timeout transition"),
        );
        assert!(operations.direct_session_operation.is_some());
        assert!(busy);
        assert_eq!(
            begin_rpc_admission(&mut busy, &mut operations, Some("compact")),
            Err(RpcAdmissionError::Busy),
        );

        busy = runtime_busy_state(ended).expect("terminal busy state");
        apply_direct_session_operation_runtime_event(
            &mut operations,
            direct_session_operation_runtime_event(ended).expect("terminal transition"),
        );
        assert!(!busy);
        assert!(operations.direct_session_operation.is_none());
    }

    #[test]
    fn compact_event_then_response_order_keeps_the_native_fence_closed() {
        let ended = DirectSessionOperationRuntimeEvent::Terminal {
            kind: DirectSessionOperationKind::Compact,
        };
        let success = DirectSessionOperationRuntimeEvent::Response {
            kind: DirectSessionOperationKind::Compact,
            acknowledgement_timed_out: false,
        };
        let mut busy = false;
        let mut operations = AgentOperations::default();
        begin_rpc_admission(&mut busy, &mut operations, Some("compact"))
            .expect("compact admission");
        finish_runtime_write(&mut operations);

        apply_direct_session_operation_runtime_event(&mut operations, ended);
        assert!(operations.direct_session_operation.is_some());
        apply_direct_session_operation_runtime_event(&mut operations, success);
        assert!(operations.direct_session_operation.is_none());
    }

    #[test]
    fn refine_timeout_retains_an_unknown_fence_until_process_replacement() {
        let timeout = br#"{"type":"response","command":"refine","success":false,"error":"Timed out after 600000ms waiting for the Prime Agent daemon response to \"refine\"."}"#;
        let mut busy = false;
        let mut operations = AgentOperations::default();
        begin_rpc_admission(&mut busy, &mut operations, Some("refine")).expect("refine admission");
        finish_runtime_write(&mut operations);

        assert_eq!(runtime_busy_state(timeout), None);
        apply_direct_session_operation_runtime_event(
            &mut operations,
            direct_session_operation_runtime_event(timeout).expect("timeout transition"),
        );
        assert!(busy);
        assert!(operations
            .direct_session_operation
            .is_some_and(|marker| marker.kind == DirectSessionOperationKind::Refine
                && marker.acknowledgement_timed_out));
        assert!(direct_session_operation_runtime_event(
            br#"{"type":"refine_complete","result":{}}"#
        )
        .is_none());
        assert!(direct_session_operation_runtime_event(
            br#"{"type":"refine_failed","error":"late automatic refinement"}"#,
        )
        .is_none());
        assert_eq!(
            begin_rpc_admission(&mut busy, &mut operations, Some("refine")),
            Err(RpcAdmissionError::Busy),
        );

        let prompt = begin_rpc_admission(&mut busy, &mut operations, Some("prompt"))
            .expect("prompts remain admissible while refine acknowledgement is unknown");
        assert_eq!(prompt.previous_busy, Some(true));
        finish_runtime_write(&mut operations);
        let state = begin_rpc_admission(&mut busy, &mut operations, Some("get_state"))
            .expect("state reads remain admissible while refine acknowledgement is unknown");
        assert_eq!(state.previous_busy, None);
        finish_runtime_write(&mut operations);
        assert!(operations.direct_session_operation.is_some());
    }

    #[test]
    fn normal_refine_response_releases_the_exact_native_fence() {
        let response = br#"{"type":"response","command":"refine","success":true,"data":{}}"#;
        let mut busy = false;
        let mut operations = AgentOperations::default();
        begin_rpc_admission(&mut busy, &mut operations, Some("refine")).expect("refine admission");
        finish_runtime_write(&mut operations);

        busy = runtime_busy_state(response).expect("terminal refine response");
        apply_direct_session_operation_runtime_event(
            &mut operations,
            direct_session_operation_runtime_event(response).expect("refine response transition"),
        );
        assert!(!busy);
        assert!(operations.direct_session_operation.is_none());
        assert!(begin_rpc_admission(&mut busy, &mut operations, Some("refine")).is_ok());
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
        let daemon_socket = Path::new(
            r"\\.\pipe\prime-orbit-daemon-prime-agent-v0.7.4-4a6f213a1ed44889a0f0b40ea4774f3d",
        );
        let arguments = rpc_launch_arguments(
            Some(Path::new("C:\\sessions\\one.jsonl")),
            Some("openai"),
            Some("gpt-5.6-sol"),
            Some("xhigh"),
            Some("Prefer rlm.run thinking high."),
            AgentRuntimeMode::Normal,
            None,
            Some(daemon_socket),
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
                "--append-system-prompt",
                "Prefer rlm.run thinking high.",
                "--daemon-socket",
                r"\\.\pipe\prime-orbit-daemon-prime-agent-v0.7.4-4a6f213a1ed44889a0f0b40ea4774f3d",
            ]
        );
    }

    #[test]
    fn plan_runtime_launch_isolated_to_the_embedded_tools_and_extension() {
        let extension = Path::new(r"C:\Orbit Runtime\prime-orbit-plan-mode.ts");
        let arguments = rpc_launch_arguments(
            None,
            None,
            None,
            Some("high"),
            Some("A normal-runtime prompt must be ignored."),
            AgentRuntimeMode::Plan,
            Some(extension),
            None,
        )
        .into_iter()
        .map(|value| value.to_string_lossy().into_owned())
        .collect::<Vec<_>>();
        assert_eq!(
            arguments,
            [
                "--mode",
                "rpc",
                "--thinking",
                "high",
                "--no-extensions",
                "--no-skills",
                "--no-prompt-templates",
                "--tools",
                "prime_orbit_plan_inspect,prime_orbit_plan_question,prime_orbit_plan_submit",
                "--extension",
                r"C:\Orbit Runtime\prime-orbit-plan-mode.ts",
            ]
        );
        assert!(!arguments.iter().any(|argument| argument == "ipython"));
    }

    fn source_launch_spec(name: &str, managed: bool) -> LaunchSpec {
        LaunchSpec::Source {
            node: PathBuf::from("node"),
            cli: PathBuf::from("cli.js"),
            source_dir: PathBuf::from("runtime").join(name),
            managed,
        }
    }

    #[test]
    fn versioned_managed_sources_get_a_stable_generation_daemon_socket() {
        let generation = "prime-agent-v0.7.4-4a6f213a1ed44889a0f0b40ea4774f3d";
        let first = managed_generation_daemon_socket(&source_launch_spec(generation, true))
            .expect("valid managed generation")
            .expect("generation socket");
        let second = managed_generation_daemon_socket(&source_launch_spec(generation, true))
            .expect("same valid managed generation")
            .expect("same generation socket");
        assert_eq!(first, second);

        #[cfg(windows)]
        assert_eq!(
            first,
            PathBuf::from(format!(r"\\.\pipe\prime-orbit-daemon-{generation}"))
        );
        #[cfg(not(windows))]
        assert_eq!(
            first,
            PathBuf::from(format!("/tmp/prime-orbit-daemon-{generation}.sock"))
        );

        let other = managed_generation_daemon_socket(&source_launch_spec(
            "prime-agent-v0.7.4-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            true,
        ))
        .expect("other valid managed generation")
        .expect("other generation socket");
        assert_ne!(first, other);
    }

    #[test]
    fn only_private_managed_generations_are_registered_for_update_shutdown() {
        let generation = "prime-agent-v0.7.4-4a6f213a1ed44889a0f0b40ea4774f3d";
        let launch = source_launch_spec(generation, true);
        let socket = managed_generation_daemon_socket(&launch)
            .expect("valid generation")
            .expect("private socket");
        let target =
            managed_daemon_shutdown_target(&launch, Some(&socket)).expect("managed daemon target");
        assert_eq!(target.node, PathBuf::from("node"));
        assert_eq!(target.cli, PathBuf::from("cli.js"));
        assert_eq!(target.socket, socket);

        assert!(managed_daemon_shutdown_target(&launch, None).is_none());
        assert!(managed_daemon_shutdown_target(
            &source_launch_spec(generation, false),
            Some(Path::new("external.sock")),
        )
        .is_none());
        assert!(managed_daemon_shutdown_target(
            &LaunchSpec::Executable {
                executable: PathBuf::from("prime-agent"),
                managed: false,
            },
            Some(Path::new("system.sock")),
        )
        .is_none());
    }

    #[test]
    fn legacy_external_and_system_sources_keep_the_upstream_daemon_socket() {
        assert_eq!(
            managed_generation_daemon_socket(&source_launch_spec("prime-agent", true))
                .expect("legacy managed runtime"),
            None
        );
        assert_eq!(
            managed_generation_daemon_socket(&source_launch_spec(
                "prime-agent-v0.7.4-4a6f213a1ed44889a0f0b40ea4774f3d",
                false,
            ))
            .expect("external source runtime"),
            None
        );
        assert_eq!(
            managed_generation_daemon_socket(&LaunchSpec::Executable {
                executable: PathBuf::from("prime-agent"),
                managed: false,
            })
            .expect("system executable runtime"),
            None
        );
    }

    #[test]
    fn malformed_managed_generations_fail_closed_instead_of_sharing_the_default_socket() {
        for name in [
            "prime-agent-v0.7-4a6f213a1ed44889a0f0b40ea4774f3d",
            "prime-agent-v0.7.4-4A6F213A1ED44889A0F0B40EA4774F3D",
            "prime-agent-v0.7.4-../../prime-agent-daemon",
            "prime-agent-v00000000000.7.4-4a6f213a1ed44889a0f0b40ea4774f3d",
        ] {
            assert!(
                managed_generation_daemon_socket(&source_launch_spec(name, true)).is_err(),
                "{name} must fail closed"
            );
        }
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
    fn update_installation_fence_is_exclusive_and_blocks_agent_launches() {
        let agents = AgentsState::default();
        assert!(ensure_update_installation_is_idle(&agents).is_ok());

        let guard = begin_update_installation(&agents).expect("first updater claim");
        assert!(ensure_update_installation_is_idle(&agents).is_err());
        assert!(begin_update_installation(&agents).is_err());

        drop(guard);
        assert!(ensure_update_installation_is_idle(&agents).is_ok());
        assert!(begin_update_installation(&agents).is_ok());
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
