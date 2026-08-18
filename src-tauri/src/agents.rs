#[cfg(windows)]
use crate::runtime::LaunchSpec;
use crate::{
    paths::canonicalize,
    runtime::{detect_internal, now_millis},
    session_lease::reclaim_stale_session_lease,
};
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    ffi::OsString,
    fs,
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, ExitStatus, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc,
    },
    thread,
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager};

const MAX_RPC_BYTES: usize = 16 * 1024 * 1024;
const IDLE_RELEASE_GRACE: Duration = Duration::from_millis(350);
const MAX_EXIT_DIAGNOSTIC_BYTES: usize = 8 * 1024;
const STDERR_DRAIN_GRACE: Duration = Duration::from_millis(350);

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
    child: Arc<Mutex<Child>>,
    stdin: Arc<Mutex<ChildStdin>>,
    exit_emitted: Arc<AtomicBool>,
    owners: HashSet<String>,
    busy: bool,
    release_when_idle: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunningAgentInfo {
    pub conversation_id: String,
    pub pid: u32,
    pub cwd: String,
    pub session_path: Option<String>,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub thinking: Option<String>,
    pub started_at: u64,
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
    agents: Option<AgentsState>,
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
                if let Some(agents) = agents.as_ref() {
                    apply_runtime_record(agents, &conversation_id, &record);
                }
                let line = String::from_utf8_lossy(&record).into_owned();
                if let Some(diagnostic_tail) = diagnostic_tail.as_ref() {
                    append_diagnostic_tail(diagnostic_tail, &line);
                }
                emit_line(&app, event_name, &conversation_id, line);
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

fn runtime_session_path(record: &[u8]) -> Option<String> {
    let event: Value = serde_json::from_slice(record).ok()?;
    if event.get("type").and_then(Value::as_str) != Some("response")
        || event.get("command").and_then(Value::as_str) != Some("get_state")
        || event.get("success").and_then(Value::as_bool) == Some(false)
    {
        return None;
    }
    let data = event.get("data")?;
    data.get("sessionFile")
        .or_else(|| data.get("sessionPath"))
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn apply_runtime_record(agents: &AgentsState, conversation_id: &str, record: &[u8]) {
    let busy = runtime_busy_state(record);
    let session_path = runtime_session_path(record).and_then(|path| canonicalize(path).ok());
    if busy.is_none() && session_path.is_none() {
        return;
    }
    let release_candidate = {
        let mut map = agents.0.lock();
        let Some(agent) = map.get_mut(conversation_id) else {
            return;
        };
        if let Some(busy) = busy {
            agent.busy = busy;
        }
        if let Some(session_path) = session_path {
            agent.info.session_path = Some(session_path.to_string_lossy().into_owned());
        }
        (!agent.busy && agent.release_when_idle && agent.owners.is_empty())
            .then_some(agent.info.pid)
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
                .map(|agent| {
                    agent.info.pid == pid
                        && !agent.busy
                        && agent.release_when_idle
                        && agent.owners.is_empty()
                })
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
    acquire_owner_lease(&mut agent.owners, &mut agent.release_when_idle, owner);
}

fn release_owner_lease(agent: &mut RunningAgent, owner: &str) -> bool {
    release_owner_lease_state(
        &mut agent.owners,
        agent.busy,
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
        const LEVELS: [&str; 7] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
        if !LEVELS.contains(&level) {
            return Err(format!(
                "Niveau de réflexion inconnu: {level}. Valeurs: {}",
                LEVELS.join(", ")
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

    let mut arguments = vec![OsString::from("--mode"), OsString::from("rpc")];
    if let Some(path) = &session_path {
        arguments.push(OsString::from("--resume"));
        arguments.push(path.as_os_str().to_owned());
    }
    if let Some(value) = &provider {
        arguments.push(OsString::from("--provider"));
        arguments.push(OsString::from(value));
    }
    if let Some(value) = &model {
        arguments.push(OsString::from("--model"));
        arguments.push(OsString::from(value));
    }
    if let Some(value) = &thinking {
        arguments.push(OsString::from("--thinking"));
        arguments.push(OsString::from(value));
    }

    let mut command = launch_spec.command(&arguments);
    #[cfg(windows)]
    if matches!(&launch_spec, LaunchSpec::Source { .. }) {
        crate::node_compat::configure_source_rpc(&app, &mut command)?;
    }
    command
        .current_dir(&cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut map = agents.0.lock();
    if let Some(existing) = map.get_mut(&conversation_id) {
        acquire_owner(existing, owner);
        return Ok(existing.info.clone());
    }
    ensure_session_is_not_open_under_another_id(&map, &conversation_id, session_path.as_deref())?;
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

    let info = RunningAgentInfo {
        conversation_id: conversation_id.clone(),
        pid,
        cwd: cwd.to_string_lossy().into_owned(),
        session_path: session_path.map(|path| path.to_string_lossy().into_owned()),
        provider,
        model,
        thinking,
        started_at: now_millis(),
    };
    let child = Arc::new(Mutex::new(child));
    let exit_emitted = Arc::new(AtomicBool::new(false));
    map.insert(
        conversation_id.clone(),
        RunningAgent {
            info: info.clone(),
            child: Arc::clone(&child),
            stdin: Arc::new(Mutex::new(stdin)),
            exit_emitted: Arc::clone(&exit_emitted),
            owners: HashSet::from([owner]),
            // A resumed daemon session may already be working. Treat startup
            // as busy until get_state proves otherwise, so a fast navigation
            // cannot accidentally terminate live work.
            busy: true,
            release_when_idle: false,
        },
    );
    drop(map);

    let stdout_app = app.clone();
    let stdout_conversation_id = conversation_id.clone();
    thread::spawn(move || {
        stream_records(
            stdout,
            stdout_app,
            "prime-agent://event",
            stdout_conversation_id,
            Some(AgentsState(Arc::clone(&agents.0))),
            None,
        );
    });

    // Capture stderr natively as well as forwarding it to the renderer. The
    // process waiter gives the reader a short, bounded window to drain after
    // exit, so an actionable startup error is carried by the exit event even
    // when cross-thread Tauri event delivery is reordered. A descendant that
    // inherited the pipe can never block stop/release indefinitely.
    let exit_diagnostic = Arc::new(Mutex::new(String::new()));
    let (stderr_done_tx, stderr_done_rx) = mpsc::sync_channel(1);
    let stderr_app = app.clone();
    let stderr_conversation_id = conversation_id.clone();
    let stderr_exit_diagnostic = Arc::clone(&exit_diagnostic);
    thread::spawn(move || {
        stream_records(
            stderr,
            stderr_app,
            "prime-agent://stderr",
            stderr_conversation_id,
            None,
            Some(stderr_exit_diagnostic),
        );
        let _ = stderr_done_tx.send(());
    });

    let wait_app = app.clone();
    let wait_conversation_id = conversation_id.clone();
    let wait_child = Arc::clone(&child);
    thread::spawn(move || {
        let status = wait_for_child(&wait_child);
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
                .map(|agent| agent.info.pid == pid)
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
        map.get_mut(&conversation_id)
            .and_then(|agent| release_owner_lease(agent, &owner).then_some(agent.info.pid))
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
                release_owner_lease(agent, owner).then(|| (conversation_id.clone(), agent.info.pid))
            })
            .collect::<Vec<_>>()
    };
    for (conversation_id, pid) in release_candidates {
        schedule_idle_release(agents.clone(), conversation_id, pid);
    }
}

fn send_rpc_blocking(
    agents: AgentsState,
    conversation_id: String,
    payload: Value,
) -> Result<(), String> {
    let conversation_id = validated_identifier(conversation_id)?;
    if !payload.is_object() {
        return Err("Le payload RPC doit être un objet JSON".to_string());
    }
    let mut bytes = serde_json::to_vec(&payload)
        .map_err(|error| format!("Impossible de sérialiser le payload RPC: {error}"))?;
    if bytes.len() > MAX_RPC_BYTES {
        return Err(format!(
            "Le payload RPC dépasse la limite de {} octets",
            MAX_RPC_BYTES
        ));
    }
    bytes.push(b'\n');

    let stdin = {
        let map = agents.0.lock();
        map.get(&conversation_id)
            .map(|agent| Arc::clone(&agent.stdin))
            .ok_or_else(|| format!("Aucun Prime Agent actif pour {conversation_id}"))?
    };
    let mut stdin = stdin.lock();
    stdin
        .write_all(&bytes)
        .and_then(|_| stdin.flush())
        .map_err(|error| format!("Impossible d’envoyer la commande RPC: {error}"))
}

fn stop_agent_blocking(
    app: AppHandle,
    agents: AgentsState,
    conversation_id: String,
) -> Result<bool, String> {
    let conversation_id = validated_identifier(conversation_id)?;
    let Some(agent) = agents.0.lock().remove(&conversation_id) else {
        return Ok(false);
    };

    let status = terminate_child(&mut agent.child.lock());
    emit_exit_once(&app, &conversation_id, &agent.exit_emitted, status, None);
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
    agents: tauri::State<'_, AgentsState>,
    conversation_id: String,
    payload: Value,
) -> Result<(), String> {
    let agents = AgentsState(Arc::clone(&agents.0));
    crate::run_blocking(move || send_rpc_blocking(agents, conversation_id, payload)).await
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
        acquire_owner_lease, append_diagnostic_tail, conflicting_session_conversation,
        release_owner_lease_state, runtime_busy_state, runtime_session_path, RunningAgentInfo,
        MAX_EXIT_DIAGNOSTIC_BYTES,
    };
    use parking_lot::Mutex;
    use std::{collections::HashSet, path::Path};

    fn info(conversation_id: &str, session_path: Option<&str>) -> RunningAgentInfo {
        RunningAgentInfo {
            conversation_id: conversation_id.to_string(),
            pid: 1,
            cwd: "C:\\project".to_string(),
            session_path: session_path.map(str::to_string),
            provider: None,
            model: None,
            thinking: None,
            started_at: 0,
        }
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
    }

    #[test]
    fn records_the_canonical_session_returned_by_get_state() {
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
}
