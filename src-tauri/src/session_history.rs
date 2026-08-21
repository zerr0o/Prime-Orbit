use crate::{
    harness::{read_harness_inventory, HarnessInventory},
    paths::canonicalize,
};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, File, Metadata},
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    time::SystemTime,
};
use tauri::{AppHandle, Manager};

use crate::session_lease::resolve_agent_dir;

const CURRENT_SESSION_VERSION: u64 = 3;
const MAX_SESSION_BYTES: u64 = 64 * 1024 * 1024;
const MAX_LINE_BYTES: usize = 8 * 1024 * 1024;
const MAX_ENTRIES: usize = 100_000;
const MAX_MESSAGES: usize = 5_000;
const MAX_PUBLIC_TEXT_CHARS: usize = 16_000;
const MAX_SUMMARY_CHARS: usize = 64_000;
const MAX_IPC_BYTES: usize = 8 * 1024 * 1024;
const MAX_TRANSCRIPT_IPC_BYTES: usize = 6 * 1024 * 1024;
const MAX_REFINEMENT_IPC_BYTES: usize = 1024 * 1024;
const MAX_PUBLIC_AGENT_MESSAGE_ID_SUFFIX_CHARS: usize = 200;
const MAX_PUBLIC_AGENT_NAME_CHARS: usize = 160;
const MAX_REFINEMENT_RECORDS: usize = 48;
const MAX_REFINEMENT_EDITS: usize = 64;
const MAX_OBSERVED_HARNESS_ENTRIES: usize = 128;
const MAX_REFINEMENT_ID_CHARS: usize = 200;
const MAX_REFINEMENT_SUMMARY_CHARS: usize = 480;
const MAX_REFINEMENT_DETAIL_CHARS: usize = 1_200;
const MAX_REFINEMENT_CONTENT_CHARS: usize = 4_000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRefinementEdit {
    pub action: String,
    pub kind: String,
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    pub applied: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRefinementRecord {
    pub id: String,
    pub timestamp: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rationale: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_outcome: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rollback_of: Option<String>,
    pub applied_edits: Vec<SessionRefinementEdit>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionHarnessEntry {
    pub key: String,
    pub id: String,
    pub kind: String,
    pub scope: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    pub refinement_id: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionHistoryResult {
    pub messages: Vec<Value>,
    pub refinements: Vec<SessionRefinementRecord>,
    pub harness_entries: Vec<SessionHarnessEntry>,
    pub read_only: bool,
    pub truncated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionCatalogEntry {
    pub session_path: String,
    pub session_id: String,
    pub cwd: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_message: Option<String>,
    pub message_count: usize,
    pub rlm_depth: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_session_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    pub updated_at_ms: u64,
}

fn catalog_text(value: &Value, limit: usize) -> Option<String> {
    let text = match value {
        Value::String(text) => crate::files::parse_orbit_attachment_context(text)
            .map(|context| context.visible_text)
            .unwrap_or_else(|| text.clone()),
        Value::Array(blocks) => blocks
            .iter()
            .filter_map(|block| {
                let block = block.as_object()?;
                matches!(
                    block.get("type").and_then(Value::as_str),
                    Some("text" | "output_text")
                )
                .then(|| {
                    block
                        .get("text")
                        .or_else(|| block.get("content"))
                        .and_then(Value::as_str)
                })
                .flatten()
            })
            .map(|text| {
                crate::files::parse_orbit_attachment_context(text)
                    .map(|context| context.visible_text)
                    .unwrap_or_else(|| text.to_string())
            })
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    };
    let single_line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if single_line.is_empty() {
        None
    } else {
        Some(single_line.chars().take(limit).collect())
    }
}

fn scan_catalog_entry(path: &Path) -> Option<SessionCatalogEntry> {
    let metadata = fs::symlink_metadata(path).ok()?;
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.len() > MAX_SESSION_BYTES
    {
        return None;
    }
    let file = File::open(path).ok()?;
    let mut reader = BufReader::new(file);
    let mut line = Vec::new();
    let mut header: Option<Value> = None;
    let mut session_name = None;
    let mut first_message = None;
    let mut message_count = 0_usize;
    let mut entries = 0_usize;
    loop {
        line.clear();
        let read = reader.read_until(b'\n', &mut line).ok()?;
        if read == 0 {
            break;
        }
        entries = entries.saturating_add(1);
        if entries > MAX_ENTRIES {
            return None;
        }
        if line.len() > MAX_LINE_BYTES {
            // Oversized tool results contain no catalog metadata. Count only
            // ordinary message envelopes without retaining the payload.
            const MESSAGE_MARKER: &[u8] = b"\"type\":\"message\"";
            if line
                .windows(MESSAGE_MARKER.len())
                .any(|window| window == MESSAGE_MARKER)
            {
                message_count = message_count.saturating_add(1);
            }
            continue;
        }
        let value = match serde_json::from_slice::<Value>(&line) {
            Ok(value) => value,
            Err(_) if !line.ends_with(b"\n") => break,
            Err(_) => continue,
        };
        let kind = string_field(&value, "type");
        if header.is_none() {
            if kind != Some("session") {
                return None;
            }
            header = Some(value.clone());
        }
        if kind == Some("session_info") {
            session_name = value
                .get("name")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|name| !name.is_empty())
                .map(|name| name.chars().take(160).collect());
        }
        if kind == Some("message") {
            message_count = message_count.saturating_add(1);
            if first_message.is_none()
                && value
                    .get("message")
                    .and_then(|message| string_field(message, "role"))
                    == Some("user")
            {
                first_message = value
                    .get("message")
                    .and_then(|message| message.get("content"))
                    .and_then(|content| catalog_text(content, 180));
            }
        }
    }
    let header = header?;
    let session_id = string_field(&header, "id")?.to_string();
    let cwd = string_field(&header, "cwd")?.to_string();
    let rlm_depth = header.get("rlmDepth").and_then(Value::as_u64).unwrap_or(0);
    let updated_at_ms = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis().try_into().unwrap_or(u64::MAX))
        .unwrap_or(0);
    Some(SessionCatalogEntry {
        session_path: canonicalize(path).ok()?.to_string_lossy().into_owned(),
        session_id,
        cwd,
        session_name,
        first_message,
        message_count,
        rlm_depth,
        parent_session_path: string_field(&header, "parentSession").map(str::to_string),
        created_at: string_field(&header, "timestamp").map(str::to_string),
        updated_at_ms,
    })
}

fn list_session_catalog(
    app: &AppHandle,
    project_paths: Vec<String>,
) -> Result<Vec<SessionCatalogEntry>, String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|error| format!("Impossible de localiser les sessions Prime Agent: {error}"))?;
    let configured = std::env::var_os("PRIME_AGENT_CODING_AGENT_DIR")
        .or_else(|| std::env::var_os("PI_CODING_AGENT_DIR"));
    let mut roots = project_paths
        .into_iter()
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .map(|cwd| resolve_agent_dir(&home, &cwd, configured.as_deref()).join("sessions"))
        .collect::<HashSet<_>>();
    if roots.is_empty() {
        let cwd = std::env::current_dir().unwrap_or_else(|_| home.clone());
        roots.insert(resolve_agent_dir(&home, &cwd, configured.as_deref()).join("sessions"));
    }
    let mut sessions = Vec::new();
    let mut known_paths = HashSet::new();
    for root in roots {
        let entries = match fs::read_dir(&root) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(format!("Impossible de lire {}: {error}", root.display())),
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path
                .extension()
                .and_then(|value| value.to_str())
                .is_some_and(|value| value.eq_ignore_ascii_case("jsonl"))
            {
                if let Some(session) = scan_catalog_entry(&path) {
                    if known_paths.insert(session.session_path.clone()) {
                        sessions.push(session);
                    }
                }
            }
        }
    }
    sessions.sort_by_key(|session| std::cmp::Reverse(session.updated_at_ms));
    Ok(sessions)
}

#[tauri::command]
pub async fn list_prime_agent_sessions(
    app: AppHandle,
    project_paths: Vec<String>,
) -> Result<Vec<SessionCatalogEntry>, String> {
    crate::run_blocking(move || list_session_catalog(&app, project_paths)).await
}

#[derive(Debug, Clone)]
struct ParsedEntry {
    id: String,
    parent_id: Option<String>,
    value: Value,
}

#[derive(Debug)]
struct ParsedSession {
    header: Value,
    entries: Vec<ParsedEntry>,
    partial_tail: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct FileStamp {
    len: u64,
    modified: Option<SystemTime>,
}

impl FileStamp {
    fn from_metadata(metadata: &Metadata) -> Self {
        Self {
            len: metadata.len(),
            modified: metadata.modified().ok(),
        }
    }
}

fn string_field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key)?.as_str()
}

fn validate_identifier(value: Option<String>) -> Result<Option<String>, String> {
    let Some(value) = value else {
        return Ok(None);
    };
    let value = value.trim();
    if value.is_empty() {
        return Ok(None);
    }
    if value.len() > 256 || value.chars().any(char::is_control) {
        return Err("L’identifiant de session contient des caractères invalides".to_string());
    }
    Ok(Some(value.to_string()))
}

fn validate_project_path(path: String) -> Result<PathBuf, String> {
    let path = PathBuf::from(path);
    if !path.is_absolute() {
        return Err("Le chemin du projet doit être absolu".to_string());
    }
    let metadata = fs::metadata(&path)
        .map_err(|error| format!("Le projet {} est inaccessible: {error}", path.display()))?;
    if !metadata.is_dir() {
        return Err(format!("{} n’est pas un dossier de projet", path.display()));
    }
    canonicalize(&path).map_err(|error| {
        format!(
            "Impossible de résoudre le projet {}: {error}",
            path.display()
        )
    })
}

fn validate_session_file(path: String) -> Result<(PathBuf, FileStamp), String> {
    let requested = PathBuf::from(path);
    if !requested.is_absolute() {
        return Err("Le chemin de session doit être absolu".to_string());
    }
    if !requested
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("jsonl"))
    {
        return Err("La session doit être un fichier JSONL Prime Agent".to_string());
    }
    let link_metadata = fs::symlink_metadata(&requested).map_err(|error| {
        format!(
            "La session Prime Agent {} est inaccessible: {error}",
            requested.display()
        )
    })?;
    if link_metadata.file_type().is_symlink() || !link_metadata.is_file() {
        return Err("La session doit être un fichier régulier non symbolique".to_string());
    }
    if link_metadata.len() > MAX_SESSION_BYTES {
        return Err(format!(
            "La session dépasse la limite de {} Mio",
            MAX_SESSION_BYTES / 1024 / 1024
        ));
    }
    let canonical = canonicalize(&requested)
        .map_err(|error| format!("Impossible de résoudre {}: {error}", requested.display()))?;
    Ok((canonical, FileStamp::from_metadata(&link_metadata)))
}

fn canonical_if_directory(path: &Path) -> Option<PathBuf> {
    fs::metadata(path)
        .ok()
        .filter(|metadata| metadata.is_dir())
        .and_then(|_| canonicalize(path).ok())
}

fn is_under_known_session_root(path: &Path, home: &Path) -> bool {
    canonical_if_directory(&home.join(".prime").join("agent").join("sessions"))
        .is_some_and(|root| path.starts_with(root))
}

fn header_version(header: &Value) -> Result<u64, String> {
    let version = header.get("version").and_then(Value::as_u64).unwrap_or(1);
    if version == 0 || version > CURRENT_SESSION_VERSION {
        return Err(format!(
            "Version de session Prime Agent non prise en charge ({version})"
        ));
    }
    Ok(version)
}

fn validate_header(
    header: &Value,
    session_path: &Path,
    expected_session_id: Option<&str>,
    project_path: &Path,
    home: &Path,
) -> Result<Option<String>, String> {
    if string_field(header, "type") != Some("session") {
        return Err("Le fichier ne contient pas un en-tête de session Prime Agent".to_string());
    }
    header_version(header)?;
    let header_id = string_field(header, "id")
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "L’en-tête de session ne contient pas d’identifiant".to_string())?;
    let header_cwd =
        string_field(header, "cwd").and_then(|value| canonical_if_directory(Path::new(value)));
    let cwd_matches = header_cwd.as_deref() == Some(project_path);

    if let Some(expected_session_id) = expected_session_id {
        if expected_session_id != header_id {
            return Err("La session ne correspond pas à la conversation sélectionnée".to_string());
        }
        return Ok((!cwd_matches).then(|| {
            "Le projet a été déplacé depuis la création de cette session; l’historique reste consultable en lecture seule."
                .to_string()
        }));
    }

    if !is_under_known_session_root(session_path, home) || !cwd_matches {
        return Err(
            "La session ne correspond ni à la conversation ni au projet sélectionné".to_string(),
        );
    }
    Ok(None)
}

fn synthetic_v1_id(index: usize) -> String {
    format!("legacy-{index:08x}")
}

fn fold_child_usage_attributions(raw_entries: &mut [Value]) {
    // Index once so a large child-agent transcript remains linear instead of
    // scanning every message again for every attribution record.
    let assistant_messages = raw_entries
        .iter()
        .enumerate()
        .filter_map(|(index, entry)| {
            if string_field(entry, "type") == Some("message")
                && entry
                    .get("message")
                    .and_then(|message| string_field(message, "role"))
                    == Some("assistant")
            {
                Some((string_field(entry, "id")?.to_string(), index))
            } else {
                None
            }
        })
        .collect::<HashMap<_, _>>();
    let usage_attributions = raw_entries
        .iter()
        .filter(|entry| string_field(entry, "type") == Some("child_usage_attributed"))
        .filter_map(|entry| {
            Some((
                *assistant_messages.get(string_field(entry, "targetId")?)?,
                entry.get("aggregateUsage")?.clone(),
            ))
        })
        .collect::<Vec<_>>();

    for (message_index, usage) in usage_attributions {
        if let Some(message) = raw_entries[message_index]
            .get_mut("message")
            .and_then(Value::as_object_mut)
        {
            message.insert("usage".to_string(), usage);
        }
    }
}

fn parse_session(path: &Path) -> Result<ParsedSession, String> {
    let file = File::open(path)
        .map_err(|error| format!("Impossible d’ouvrir la session {}: {error}", path.display()))?;
    let mut reader = BufReader::new(file);
    let mut line = Vec::new();
    let mut raw_entries = Vec::<Value>::new();
    let mut partial_tail = false;

    loop {
        line.clear();
        let read = reader
            .read_until(b'\n', &mut line)
            .map_err(|error| format!("Impossible de lire la session: {error}"))?;
        if read == 0 {
            break;
        }
        if line.len() > MAX_LINE_BYTES {
            return Err(format!(
                "Une entrée de session dépasse la limite de {} Mio",
                MAX_LINE_BYTES / 1024 / 1024
            ));
        }
        let terminated = line.last() == Some(&b'\n');
        while matches!(line.last(), Some(b'\n' | b'\r')) {
            line.pop();
        }
        if raw_entries.is_empty() && line.starts_with(&[0xef, 0xbb, 0xbf]) {
            line.drain(..3);
        }
        if line.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        match serde_json::from_slice::<Value>(&line) {
            Ok(entry) => raw_entries.push(entry),
            Err(_) if !terminated => {
                partial_tail = true;
                break;
            }
            Err(error) => {
                return Err(format!("Une entrée JSONL intérieure est invalide: {error}"));
            }
        }
        if raw_entries.len() > MAX_ENTRIES {
            return Err(format!(
                "La session dépasse la limite de {MAX_ENTRIES} entrées"
            ));
        }
    }

    let header_index = raw_entries
        .iter()
        .position(|entry| string_field(entry, "type") == Some("session"))
        .ok_or_else(|| "Le fichier ne contient pas d’en-tête de session Prime Agent".to_string())?;
    if header_index != 0 {
        return Err("L’en-tête Prime Agent doit être la première entrée du fichier".to_string());
    }
    let header = raw_entries.remove(0);
    let version = header_version(&header)?;

    if version == 1 {
        let ids = (0..raw_entries.len())
            .map(synthetic_v1_id)
            .collect::<Vec<_>>();
        for (index, entry) in raw_entries.iter_mut().enumerate() {
            let is_compaction = string_field(entry, "type") == Some("compaction");
            let kept_index = is_compaction
                .then(|| {
                    entry
                        .get("firstKeptEntryIndex")
                        .and_then(Value::as_u64)
                        .and_then(|value| usize::try_from(value).ok())
                })
                .flatten();
            if let Some(object) = entry.as_object_mut() {
                object.insert("id".to_string(), Value::String(ids[index].clone()));
                object.insert(
                    "parentId".to_string(),
                    index
                        .checked_sub(1)
                        .map(|parent| Value::String(ids[parent].clone()))
                        .unwrap_or(Value::Null),
                );
                if is_compaction {
                    if let Some(kept_index) = kept_index {
                        // v1 indexes include the session header.
                        if let Some(id) = kept_index.checked_sub(1).and_then(|value| ids.get(value))
                        {
                            object
                                .insert("firstKeptEntryId".to_string(), Value::String(id.clone()));
                        }
                    }
                    object.remove("firstKeptEntryIndex");
                }
            }
        }
    }

    // Prime Agent stores child/sub-agent usage as separate bookkeeping
    // entries. Fold only the public aggregate counters into their assistant
    // message, exactly as the runtime loader does; never expose the attribution
    // records themselves.
    fold_child_usage_attributions(&mut raw_entries);
    if version <= 2 {
        for entry in &mut raw_entries {
            if string_field(entry, "type") != Some("message") {
                continue;
            }
            if let Some(message) = entry.get_mut("message").and_then(Value::as_object_mut) {
                if message.get("role").and_then(Value::as_str) == Some("hookMessage") {
                    message.insert("role".to_string(), Value::String("custom".to_string()));
                }
            }
        }
    }

    let mut ids = HashSet::new();
    let mut entries = Vec::with_capacity(raw_entries.len());
    for entry in raw_entries {
        let id = string_field(&entry, "id")
            .filter(|id| !id.is_empty())
            .ok_or_else(|| "Une entrée de session ne contient pas d’identifiant".to_string())?
            .to_string();
        if !ids.insert(id.clone()) {
            return Err("La session contient des identifiants d’entrée dupliqués".to_string());
        }
        let parent_id = match entry.get("parentId") {
            None | Some(Value::Null) => None,
            Some(Value::String(value)) if !value.is_empty() => Some(value.clone()),
            _ => return Err("Une entrée contient un parentId invalide".to_string()),
        };
        entries.push(ParsedEntry {
            id,
            parent_id,
            value: entry,
        });
    }
    Ok(ParsedSession {
        header,
        entries,
        partial_tail,
    })
}

fn active_path(entries: &[ParsedEntry]) -> Result<Vec<usize>, String> {
    let Some(mut current) = entries.len().checked_sub(1) else {
        return Ok(Vec::new());
    };
    let by_id = entries
        .iter()
        .enumerate()
        .map(|(index, entry)| (entry.id.as_str(), index))
        .collect::<HashMap<_, _>>();
    let mut visited = HashSet::new();
    let mut reverse_path = Vec::new();
    loop {
        if !visited.insert(current) {
            return Err("La branche active de la session contient un cycle".to_string());
        }
        reverse_path.push(current);
        let Some(parent_id) = entries[current].parent_id.as_deref() else {
            break;
        };
        current = *by_id.get(parent_id).ok_or_else(|| {
            "La branche active de la session référence une entrée absente".to_string()
        })?;
    }
    reverse_path.reverse();
    Ok(reverse_path)
}

fn truncate_text(value: &str, limit: usize, truncated: &mut bool) -> String {
    let visible =
        crate::files::parse_orbit_attachment_context(value).map(|context| context.visible_text);
    let value = visible.as_deref().unwrap_or(value);
    if value.chars().count() <= limit {
        return value.to_string();
    }
    *truncated = true;
    let mut text = value.chars().take(limit).collect::<String>();
    text.push_str("\n… [historique tronqué]");
    text
}

fn refinement_id(value: Option<&str>, truncated: &mut bool) -> Option<String> {
    let value = value?.trim();
    if value.is_empty() || value.chars().any(char::is_control) {
        return None;
    }
    if value.chars().count() > MAX_REFINEMENT_ID_CHARS {
        *truncated = true;
        return None;
    }
    Some(value.to_string())
}

fn refinement_text(value: Option<&str>, limit: usize, truncated: &mut bool) -> Option<String> {
    let value = value?.trim();
    (!value.is_empty()).then(|| truncate_text(value, limit, truncated))
}

fn refinement_scope(record: &Map<String, Value>, snapshot: Option<&Map<String, Value>>) -> String {
    snapshot
        .and_then(|entry| entry.get("scope"))
        .and_then(Value::as_str)
        .or_else(|| record.get("scope").and_then(Value::as_str))
        .filter(|scope| matches!(*scope, "local" | "global"))
        .unwrap_or("unknown")
        .to_string()
}

fn public_harness_entries(
    entries: &[ParsedEntry],
    truncated: &mut bool,
) -> Vec<SessionHarnessEntry> {
    // This projection is folded independently from the bounded audit rows.
    // Every edit in the validated session file is considered, so an update or
    // delete after the visible 64-edit limit cannot leave a stale active item.
    let mut observed = HashMap::<String, (u64, SessionHarnessEntry)>::new();
    let mut sequence = 0_u64;
    for entry in entries {
        let value = &entry.value;
        if string_field(value, "type") != Some("custom")
            || string_field(value, "customType") != Some("prime-agent.refinement")
        {
            continue;
        }
        let Some(timestamp) = refinement_text(
            string_field(value, "timestamp"),
            MAX_REFINEMENT_ID_CHARS,
            truncated,
        ) else {
            continue;
        };
        let Some(data) = value.get("data").and_then(Value::as_object) else {
            continue;
        };
        let Some(record_refinement_id) =
            refinement_id(data.get("id").and_then(Value::as_str), truncated)
        else {
            continue;
        };
        let Some(edits) = data.get("appliedEdits").and_then(Value::as_array) else {
            continue;
        };
        for edit in edits {
            let Some(edit) = edit.as_object() else {
                continue;
            };
            if edit.get("applied").and_then(Value::as_bool) != Some(true) {
                continue;
            }
            let Some(action) = edit.get("action").and_then(Value::as_str) else {
                continue;
            };
            if !matches!(action, "create" | "update" | "delete") {
                continue;
            }
            let Some(kind) = edit.get("kind").and_then(Value::as_str) else {
                continue;
            };
            if !matches!(kind, "prompt" | "memory" | "skill" | "subagent") {
                continue;
            }
            let Some(id) = refinement_id(edit.get("id").and_then(Value::as_str), truncated) else {
                continue;
            };
            let snapshot = if action == "delete" {
                edit.get("before").and_then(Value::as_object)
            } else {
                edit.get("after").and_then(Value::as_object)
            };
            let scope = refinement_scope(data, snapshot);
            let key = format!("{scope}:{kind}:{id}");
            sequence = sequence.saturating_add(1);
            if action == "delete" {
                observed.remove(&key);
                continue;
            }

            let previous = observed.remove(&key).map(|(_, entry)| entry);
            if previous.is_none() && observed.len() >= MAX_OBSERVED_HARNESS_ENTRIES {
                if let Some(oldest) = observed
                    .iter()
                    .min_by_key(|(_, (ordinal, _))| *ordinal)
                    .map(|(key, _)| key.clone())
                {
                    observed.remove(&oldest);
                    *truncated = true;
                }
            }
            let title = refinement_text(
                snapshot
                    .and_then(|entry| entry.get("title"))
                    .or_else(|| edit.get("title"))
                    .and_then(Value::as_str),
                MAX_REFINEMENT_SUMMARY_CHARS,
                truncated,
            )
            .or_else(|| previous.as_ref().and_then(|entry| entry.title.clone()));
            let content = refinement_text(
                snapshot
                    .and_then(|entry| entry.get("content"))
                    .or_else(|| edit.get("content"))
                    .and_then(Value::as_str),
                MAX_REFINEMENT_CONTENT_CHARS,
                truncated,
            )
            .or_else(|| previous.as_ref().and_then(|entry| entry.content.clone()));
            observed.insert(
                key.clone(),
                (
                    sequence,
                    SessionHarnessEntry {
                        key,
                        id,
                        kind: kind.to_string(),
                        scope,
                        title,
                        content,
                        refinement_id: record_refinement_id.clone(),
                        updated_at: timestamp.clone(),
                    },
                ),
            );
        }
    }

    let mut harness_entries = observed.into_values().collect::<Vec<_>>();
    harness_entries.sort_by_key(|(ordinal, _)| std::cmp::Reverse(*ordinal));
    harness_entries
        .into_iter()
        .map(|(_, entry)| entry)
        .collect()
}

fn refinement_output_size(
    records: &[SessionRefinementRecord],
    harness_entries: &[SessionHarnessEntry],
) -> usize {
    serde_json::to_vec(&(records, harness_entries)).map_or(usize::MAX, |value| value.len())
}

fn bound_refinement_output(
    records: &mut Vec<SessionRefinementRecord>,
    harness_entries: &mut Vec<SessionHarnessEntry>,
    truncated: &mut bool,
) {
    // Drop old audit rows before current entries. The snapshot is the useful
    // state, while audit rows are supplementary context.
    while records.len() > 1
        && refinement_output_size(records, harness_entries) > MAX_REFINEMENT_IPC_BYTES
    {
        records.remove(0);
        *truncated = true;
    }
    while harness_entries.len() > 1
        && refinement_output_size(records, harness_entries) > MAX_REFINEMENT_IPC_BYTES
    {
        harness_entries.pop();
        *truncated = true;
    }
    if refinement_output_size(records, harness_entries) > MAX_REFINEMENT_IPC_BYTES {
        records.clear();
        harness_entries.clear();
        *truncated = true;
    }
}

fn overlay_harness_inventory(
    harness_entries: &mut Vec<SessionHarnessEntry>,
    inventory: HarnessInventory,
    truncated: &mut bool,
) {
    let previous = harness_entries
        .iter()
        .map(|entry| (entry.key.clone(), entry.clone()))
        .collect::<HashMap<_, _>>();
    let mut merged = harness_entries
        .drain(..)
        .filter(|entry| match entry.scope.as_str() {
            "local" => !inventory.local_available,
            "global" => !inventory.global_available,
            _ => true,
        })
        .collect::<Vec<_>>();

    for entry in inventory.entries {
        let key = format!("{}:{}:{}", entry.scope, entry.kind, entry.id);
        let audit_entry = previous.get(&key);
        merged.push(SessionHarnessEntry {
            key,
            id: entry.id,
            kind: entry.kind,
            scope: entry.scope,
            title: entry.title,
            content: entry.content,
            refinement_id: audit_entry
                .map(|entry| entry.refinement_id.clone())
                .unwrap_or_default(),
            updated_at: entry
                .updated_at
                .or_else(|| audit_entry.map(|entry| entry.updated_at.clone()))
                .unwrap_or_default(),
        });
    }

    // The native inventory is already ordered by recency. Sorting once more
    // keeps reconstructed fallbacks deterministic when one store is absent.
    merged.sort_by(|left, right| {
        right
            .updated_at
            .cmp(&left.updated_at)
            .then_with(|| left.scope.cmp(&right.scope))
            .then_with(|| left.kind.cmp(&right.kind))
            .then_with(|| left.id.cmp(&right.id))
    });
    merged.dedup_by(|left, right| left.key == right.key);
    *harness_entries = merged;
    *truncated |= inventory.truncated;
}

fn public_refinement_records(
    entries: &[ParsedEntry],
) -> (Vec<SessionRefinementRecord>, Vec<SessionHarnessEntry>, bool) {
    let mut truncated = false;
    let harness_entries = public_harness_entries(entries, &mut truncated);
    let mut records = entries
        .iter()
        .filter_map(|entry| {
            let value = &entry.value;
            if string_field(value, "type") != Some("custom")
                || string_field(value, "customType") != Some("prime-agent.refinement")
            {
                return None;
            }
            let timestamp = refinement_text(
                string_field(value, "timestamp"),
                MAX_REFINEMENT_ID_CHARS,
                &mut truncated,
            )?;
            let data = value.get("data")?.as_object()?;
            let id = refinement_id(data.get("id").and_then(Value::as_str), &mut truncated)?;
            let edits = data.get("appliedEdits")?.as_array()?;
            if edits.len() > MAX_REFINEMENT_EDITS {
                truncated = true;
            }
            let applied_edits = edits
                .iter()
                .take(MAX_REFINEMENT_EDITS)
                .filter_map(|edit| {
                    let edit = edit.as_object()?;
                    let action = edit.get("action").and_then(Value::as_str)?;
                    if !matches!(action, "create" | "update" | "delete") {
                        return None;
                    }
                    let kind = edit.get("kind").and_then(Value::as_str)?;
                    if !matches!(kind, "prompt" | "memory" | "skill" | "subagent") {
                        return None;
                    }
                    let id = refinement_id(edit.get("id").and_then(Value::as_str), &mut truncated)?;
                    let snapshot = if action == "delete" {
                        edit.get("before").and_then(Value::as_object)
                    } else {
                        edit.get("after").and_then(Value::as_object)
                    };
                    let title = refinement_text(
                        snapshot
                            .and_then(|entry| entry.get("title"))
                            .or_else(|| edit.get("title"))
                            .and_then(Value::as_str),
                        MAX_REFINEMENT_SUMMARY_CHARS,
                        &mut truncated,
                    );
                    Some(SessionRefinementEdit {
                        action: action.to_string(),
                        kind: kind.to_string(),
                        id,
                        title,
                        content: None,
                        applied: edit
                            .get("applied")
                            .and_then(Value::as_bool)
                            .unwrap_or(false),
                        error: refinement_text(
                            edit.get("error").and_then(Value::as_str),
                            MAX_REFINEMENT_SUMMARY_CHARS,
                            &mut truncated,
                        ),
                    })
                })
                .collect::<Vec<_>>();
            let scope = data
                .get("scope")
                .and_then(Value::as_str)
                .filter(|scope| matches!(*scope, "local" | "global"))
                .map(str::to_string);
            Some(SessionRefinementRecord {
                id,
                timestamp,
                summary: refinement_text(
                    data.get("summary").and_then(Value::as_str),
                    MAX_REFINEMENT_SUMMARY_CHARS,
                    &mut truncated,
                ),
                rationale: refinement_text(
                    data.get("rationale").and_then(Value::as_str),
                    MAX_REFINEMENT_DETAIL_CHARS,
                    &mut truncated,
                ),
                expected_outcome: refinement_text(
                    data.get("expectedOutcome").and_then(Value::as_str),
                    MAX_REFINEMENT_DETAIL_CHARS,
                    &mut truncated,
                ),
                scope,
                rollback_of: refinement_id(
                    data.get("rollbackOf").and_then(Value::as_str),
                    &mut truncated,
                ),
                applied_edits,
            })
        })
        .collect::<Vec<_>>();

    if records.len() > MAX_REFINEMENT_RECORDS {
        truncated = true;
        records.drain(..records.len() - MAX_REFINEMENT_RECORDS);
    }
    (records, harness_entries, truncated)
}

fn is_sensitive_payload_key(key: &str) -> bool {
    let normalized = key
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect::<String>();
    normalized.contains("token")
        || normalized.contains("secret")
        || normalized.contains("password")
        || normalized.contains("passwd")
        || matches!(
            normalized.as_str(),
            "auth"
                | "authorization"
                | "cookie"
                | "cookies"
                | "credential"
                | "credentials"
                | "data"
                | "headers"
                | "apikey"
                | "database64"
                | "base64"
                | "image"
                | "images"
                | "imagebase64"
                | "imagedata"
                | "privatekey"
        )
}

fn sanitize_payload_inner(value: &Value, depth: usize, truncated: &mut bool) -> Value {
    if depth >= 8 {
        *truncated = true;
        return Value::String("… [structure tronquée]".to_string());
    }
    match value {
        Value::String(text) => {
            let trimmed = text.trim_start();
            if trimmed
                .get(..7)
                .is_some_and(|prefix| prefix.eq_ignore_ascii_case("bearer "))
            {
                return Value::String("[valeur sensible masquée]".to_string());
            }
            Value::String(truncate_text(text, MAX_PUBLIC_TEXT_CHARS, truncated))
        }
        Value::Array(values) => {
            if values.len() > 128 {
                *truncated = true;
            }
            Value::Array(
                values
                    .iter()
                    .take(128)
                    .map(|value| sanitize_payload_inner(value, depth + 1, truncated))
                    .collect(),
            )
        }
        Value::Object(object) => {
            if object.len() > 128 {
                *truncated = true;
            }
            Value::Object(
                object
                    .iter()
                    .take(128)
                    .map(|(key, value)| {
                        let value = if is_sensitive_payload_key(key) {
                            Value::String("[valeur sensible masquée]".to_string())
                        } else {
                            sanitize_payload_inner(value, depth + 1, truncated)
                        };
                        (key.clone(), value)
                    })
                    .collect(),
            )
        }
        _ => value.clone(),
    }
}

fn sanitize_payload(value: &Value, truncated: &mut bool) -> Value {
    let sanitized = sanitize_payload_inner(value, 0, truncated);
    let serialized = serde_json::to_string(&sanitized).unwrap_or_default();
    if serialized.chars().count() > MAX_PUBLIC_TEXT_CHARS {
        return Value::String(truncate_text(&serialized, MAX_PUBLIC_TEXT_CHARS, truncated));
    }
    sanitized
}

fn sanitized_content(
    value: &Value,
    truncated: &mut bool,
    orbit_attachments: &mut Vec<crate::files::PublicAttachmentMetadata>,
    allow_orbit_context: bool,
) -> Value {
    match value {
        Value::String(text) => {
            let visible = crate::files::parse_orbit_attachment_context(text).map(|context| {
                if allow_orbit_context {
                    orbit_attachments.extend(context.attachments);
                }
                context.visible_text
            });
            Value::String(truncate_text(
                visible.as_deref().unwrap_or(text),
                MAX_SUMMARY_CHARS,
                truncated,
            ))
        }
        Value::Array(blocks) => Value::Array(
            blocks
                .iter()
                .filter_map(|block| {
                    let object = block.as_object()?;
                    match object.get("type").and_then(Value::as_str)? {
                        "text" | "output_text" => {
                            let text = object
                                .get("text")
                                .or_else(|| object.get("content"))
                                .and_then(Value::as_str)
                                .unwrap_or_default();
                            let visible = crate::files::parse_orbit_attachment_context(text).map(
                                |context| {
                                    if allow_orbit_context {
                                        orbit_attachments.extend(context.attachments);
                                    }
                                    context.visible_text
                                },
                            );
                            Some(json!({
                                "type": object.get("type").and_then(Value::as_str).unwrap_or("text"),
                                "text": truncate_text(
                                    visible.as_deref().unwrap_or(text),
                                    MAX_PUBLIC_TEXT_CHARS,
                                    truncated,
                                ),
                            }))
                        }
                        "toolCall" => Some(json!({
                            "type": "toolCall",
                            "id": object.get("id").and_then(Value::as_str).unwrap_or("tool"),
                            "name": object.get("name").and_then(Value::as_str).unwrap_or("tool"),
                            "arguments": sanitize_payload(object.get("arguments").unwrap_or(&Value::Null), truncated),
                        })),
                        // Never move original image bytes or URLs over IPC.
                        // A small native-generated thumbnail is sufficient for
                        // the transcript/session preview and remains bounded.
                        "image" | "image_url" => {
                            let mime_type = object.get("mimeType").and_then(Value::as_str);
                            let image_bytes = object
                                .get("data")
                                .and_then(Value::as_str)
                                .filter(|data| data.len() <= 12 * 1024 * 1024)
                                .and_then(|data| STANDARD.decode(data).ok())
                                .filter(|bytes| bytes.len() <= 8 * 1024 * 1024);
                            let size = image_bytes.as_ref().map(Vec::len);
                            let preview_data_url = image_bytes.as_deref().and_then(|bytes| {
                                crate::files::image_preview_data_url(
                                    mime_type.unwrap_or("image/png"),
                                    bytes,
                                )
                                .ok()
                            });
                            Some(json!({
                                "type": "image",
                                "mimeType": mime_type,
                                "size": size,
                                "previewDataUrl": preview_data_url,
                            }))
                        },
                        _ => None,
                    }
                })
                .take(256)
                .collect(),
        ),
        _ => Value::String(String::new()),
    }
}

fn copy_timestamp(target: &mut Map<String, Value>, source: &Value, fallback: &Value) {
    if let Some(timestamp) = source
        .get("timestamp")
        .or_else(|| fallback.get("timestamp"))
    {
        if timestamp.is_string() || timestamp.is_number() {
            target.insert("timestamp".to_string(), timestamp.clone());
        }
    }
}

fn public_agent_message_id(value: &Value, truncated: &mut bool) -> Option<String> {
    let id = value.as_str()?.trim();
    let suffix = id.strip_prefix("agentmsg_");
    if suffix.is_none_or(|suffix| {
        suffix.is_empty()
            || suffix.chars().count() > MAX_PUBLIC_AGENT_MESSAGE_ID_SUFFIX_CHARS
            || !suffix
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || character == '-')
    }) {
        *truncated = true;
        return None;
    }
    Some(id.to_string())
}

fn public_agent_name(value: &Value, truncated: &mut bool) -> Option<String> {
    let raw_name = value.get("sessionName")?.as_str()?;
    let mut name = String::new();
    let mut written = 0_usize;
    let mut name_truncated = false;
    'words: for word in raw_name.split_whitespace() {
        if !name.is_empty() {
            if written >= MAX_PUBLIC_AGENT_NAME_CHARS {
                name_truncated = true;
                break;
            }
            name.push(' ');
            written += 1;
        }
        for character in word.chars() {
            if written >= MAX_PUBLIC_AGENT_NAME_CHARS {
                name_truncated = true;
                break 'words;
            }
            name.push(character);
            written += 1;
        }
    }
    if name.is_empty() {
        return None;
    }
    if name_truncated && written == MAX_PUBLIC_AGENT_NAME_CHARS {
        name.pop();
        name.push('…');
    }
    *truncated |= name_truncated;
    Some(name)
}

fn sanitized_agent_message_details(value: &Value, truncated: &mut bool) -> Option<Value> {
    let details = value.as_object()?;
    let id = public_agent_message_id(details.get("id")?, truncated)?;
    let message = details.get("message")?.as_str()?;
    if message.trim().is_empty() {
        return None;
    }
    let mut public = Map::new();
    public.insert("id".to_string(), Value::String(id));
    public.insert(
        "message".to_string(),
        Value::String(truncate_text(message, MAX_PUBLIC_TEXT_CHARS, truncated)),
    );
    if let Some(from) = details.get("from").and_then(|value| {
        public_agent_name(value, truncated).map(|session_name| json!({"sessionName": session_name}))
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
        public_agent_name(value, truncated).map(|session_name| json!({"sessionName": session_name}))
    }) {
        public.insert("target".to_string(), target);
    }
    Some(Value::Object(public))
}

fn sanitized_message(entry: &ParsedEntry, truncated: &mut bool) -> Option<Value> {
    let kind = string_field(&entry.value, "type")?;
    match kind {
        "message" => {
            let source = entry.value.get("message")?.as_object()?;
            let role = source.get("role")?.as_str()?;
            if !matches!(
                role,
                "user" | "assistant" | "system" | "toolResult" | "custom" | "bashExecution"
            ) {
                return None;
            }
            if role == "custom" && source.get("display").and_then(Value::as_bool) != Some(true) {
                return None;
            }
            let mut public = Map::new();
            let mut orbit_attachments = Vec::new();
            public.insert("id".to_string(), Value::String(entry.id.clone()));
            public.insert("role".to_string(), Value::String(role.to_string()));
            copy_timestamp(&mut public, &Value::Object(source.clone()), &entry.value);
            if let Some(content) = source.get("content") {
                let content =
                    sanitized_content(content, truncated, &mut orbit_attachments, role == "user");
                public.insert("content".to_string(), content);
            }
            if !orbit_attachments.is_empty() {
                public.insert(
                    "primeOrbitAttachments".to_string(),
                    serde_json::to_value(orbit_attachments).ok()?,
                );
            }
            if role == "assistant" {
                if let Some(model) = source.get("model").and_then(Value::as_str) {
                    public.insert("model".to_string(), Value::String(model.to_string()));
                }
                if let Some(usage) = source.get("usage").and_then(Value::as_object) {
                    let safe_usage = ["input", "output", "cacheRead", "totalTokens", "total"]
                        .into_iter()
                        .filter_map(|key| {
                            usage
                                .get(key)
                                .filter(|value| value.is_number())
                                .map(|value| (key.to_string(), value.clone()))
                        })
                        .collect();
                    public.insert("usage".to_string(), Value::Object(safe_usage));
                }
            }
            if role == "toolResult" {
                for key in ["toolCallId", "toolName"] {
                    if let Some(value) = source.get(key).and_then(Value::as_str) {
                        public.insert(key.to_string(), Value::String(value.to_string()));
                    }
                }
                if source.get("isError").and_then(Value::as_bool) == Some(true) {
                    public.insert("isError".to_string(), Value::Bool(true));
                }
                if !public.contains_key("content") {
                    if let Some(details) = source.get("details") {
                        public.insert("details".to_string(), sanitize_payload(details, truncated));
                    }
                }
            }
            if role == "custom" {
                public.insert("display".to_string(), Value::Bool(true));
            }
            if role == "bashExecution" {
                for key in ["command", "output"] {
                    if let Some(value) = source.get(key).and_then(Value::as_str) {
                        public.insert(
                            key.to_string(),
                            Value::String(truncate_text(value, MAX_PUBLIC_TEXT_CHARS, truncated)),
                        );
                    }
                }
                if let Some(exit_code) = source.get("exitCode").filter(|value| value.is_number()) {
                    public.insert("exitCode".to_string(), exit_code.clone());
                }
                if source.get("cancelled").and_then(Value::as_bool) == Some(true) {
                    public.insert("cancelled".to_string(), Value::Bool(true));
                }
            }
            Some(Value::Object(public))
        }
        "custom_message" if entry.value.get("display").and_then(Value::as_bool) == Some(true) => {
            let mut public = Map::new();
            let mut orbit_attachments = Vec::new();
            public.insert("id".to_string(), Value::String(entry.id.clone()));
            public.insert("role".to_string(), Value::String("custom".to_string()));
            public.insert("display".to_string(), Value::Bool(true));
            copy_timestamp(&mut public, &entry.value, &entry.value);
            if string_field(&entry.value, "customType") == Some("agent_message") {
                let details = sanitized_agent_message_details(
                    entry.value.get("details").unwrap_or(&Value::Null),
                    truncated,
                )?;
                public.insert(
                    "customType".to_string(),
                    Value::String("agent_message".to_string()),
                );
                public.insert(
                    "content".to_string(),
                    details
                        .get("message")
                        .cloned()
                        .unwrap_or_else(|| Value::String(String::new())),
                );
                public.insert("details".to_string(), details);
            } else {
                public.insert(
                    "content".to_string(),
                    sanitized_content(
                        entry
                            .value
                            .get("content")
                            .unwrap_or(&Value::String(String::new())),
                        truncated,
                        &mut orbit_attachments,
                        false,
                    ),
                );
            }
            if !orbit_attachments.is_empty() {
                public.insert(
                    "primeOrbitAttachments".to_string(),
                    serde_json::to_value(orbit_attachments).ok()?,
                );
            }
            Some(Value::Object(public))
        }
        "branch_summary" => {
            let summary = entry.value.get("summary")?.as_str()?;
            Some(json!({
                "id": entry.id,
                "role": "branchSummary",
                "summary": truncate_text(summary, MAX_SUMMARY_CHARS, truncated),
                "timestamp": entry.value.get("timestamp"),
            }))
        }
        _ => None,
    }
}

fn compaction_message(
    entry: &ParsedEntry,
    retained_count: usize,
    truncated: &mut bool,
) -> Option<Value> {
    let summary = entry.value.get("summary")?.as_str()?;
    Some(json!({
        "id": entry.id,
        "role": "compactionSummary",
        "summary": truncate_text(summary, MAX_SUMMARY_CHARS, truncated),
        "timestamp": entry.value.get("timestamp"),
        "retainedMessageCount": retained_count,
    }))
}

fn build_public_messages(entries: &[ParsedEntry]) -> Result<(Vec<Value>, bool), String> {
    let path = active_path(entries)?;
    let mut truncated = false;
    let latest_compaction = path
        .iter()
        .enumerate()
        .rev()
        .find(|(_, index)| string_field(&entries[**index].value, "type") == Some("compaction"));
    let mut messages = Vec::new();

    if let Some((compaction_path_index, compaction_entry_index)) = latest_compaction {
        let compaction = &entries[*compaction_entry_index];
        let first_kept_id = string_field(&compaction.value, "firstKeptEntryId");
        let retained_start = first_kept_id.and_then(|wanted| {
            path[..compaction_path_index]
                .iter()
                .position(|index| entries[*index].id == wanted)
        });
        let retained = retained_start
            .map(|start| {
                path[start..compaction_path_index]
                    .iter()
                    .filter_map(|index| sanitized_message(&entries[*index], &mut truncated))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        if first_kept_id.is_some() && retained_start.is_none() {
            return Err("La compaction référence une entrée conservée absente".to_string());
        }
        if let Some(summary) = compaction_message(compaction, retained.len(), &mut truncated) {
            messages.push(summary);
        }
        messages.extend(retained);
        messages.extend(
            path[compaction_path_index + 1..]
                .iter()
                .filter_map(|index| sanitized_message(&entries[*index], &mut truncated)),
        );
    } else {
        messages.extend(
            path.iter()
                .filter_map(|index| sanitized_message(&entries[*index], &mut truncated)),
        );
    }

    if messages.len() > MAX_MESSAGES {
        truncated = true;
        messages.drain(..messages.len() - MAX_MESSAGES);
    }
    let mut size = messages
        .iter()
        .map(|message| serde_json::to_vec(message).map_or(0, |value| value.len()))
        .sum::<usize>();
    while messages.len() > 1 && size > MAX_TRANSCRIPT_IPC_BYTES {
        truncated = true;
        size = size.saturating_sub(serde_json::to_vec(&messages[0]).map_or(0, |value| value.len()));
        messages.remove(0);
    }
    if size > MAX_TRANSCRIPT_IPC_BYTES {
        return Err("Un message public dépasse le budget d’affichage de l’historique".to_string());
    }
    Ok((messages, truncated))
}

fn load_once(
    path: &Path,
    expected_session_id: Option<&str>,
    project_path: &Path,
    home: &Path,
) -> Result<(SessionHistoryResult, FileStamp), String> {
    let before = fs::metadata(path)
        .map(|metadata| FileStamp::from_metadata(&metadata))
        .map_err(|error| format!("Impossible d’inspecter la session: {error}"))?;
    if before.len > MAX_SESSION_BYTES {
        return Err(format!(
            "La session dépasse la limite de {} Mio",
            MAX_SESSION_BYTES / 1024 / 1024
        ));
    }
    let parsed = parse_session(path)?;
    let header_warning = validate_header(
        &parsed.header,
        path,
        expected_session_id,
        project_path,
        home,
    )?;
    let (messages, message_output_truncated) = build_public_messages(&parsed.entries)?;
    let (mut refinements, mut harness_entries, mut refinement_output_truncated) =
        public_refinement_records(&parsed.entries);
    let header_id = string_field(&parsed.header, "id")
        .expect("validate_header accepted a session without an id");
    let inventory_warning = match read_harness_inventory(
        home,
        &path.to_string_lossy(),
        header_id,
        &project_path.to_string_lossy(),
    ) {
        Ok(inventory) => {
            overlay_harness_inventory(
                &mut harness_entries,
                inventory,
                &mut refinement_output_truncated,
            );
            false
        }
        Err(_) => true,
    };
    bound_refinement_output(
        &mut refinements,
        &mut harness_entries,
        &mut refinement_output_truncated,
    );
    let projected_ipc_bytes = serde_json::to_vec(&(
        messages.as_slice(),
        refinements.as_slice(),
        harness_entries.as_slice(),
    ))
    .map_err(|error| format!("Impossible de préparer l’historique public: {error}"))?
    .len();
    if projected_ipc_bytes > MAX_IPC_BYTES {
        return Err("L’historique public dépasse le budget IPC de sécurité".to_string());
    }
    let output_truncated = message_output_truncated || refinement_output_truncated;
    let after = fs::metadata(path)
        .map(|metadata| FileStamp::from_metadata(&metadata))
        .map_err(|error| format!("Impossible de réinspecter la session: {error}"))?;
    let truncated = parsed.partial_tail || output_truncated;
    let warning = match (header_warning, parsed.partial_tail, output_truncated) {
        (Some(header), true, _) | (Some(header), _, true) => Some(format!(
            "{header} La fin ou une partie volumineuse de l’historique a été ignorée."
        )),
        (Some(header), false, false) => Some(header),
        (None, true, _) => {
            Some("La dernière ligne de session était incomplète et a été ignorée.".to_string())
        }
        (None, false, true) => Some(
            "Une partie volumineuse de l’historique a été tronquée pour l’affichage.".to_string(),
        ),
        (None, false, false) => None,
    };
    let warning = if inventory_warning {
        Some(match warning {
            Some(warning) => format!(
                "{warning} L’inventaire réel du harness n’a pas pu être relu; les entrées affichées proviennent du journal de raffinements."
            ),
            None => "L’inventaire réel du harness n’a pas pu être relu; les entrées affichées proviennent du journal de raffinements."
                .to_string(),
        })
    } else {
        warning
    };
    Ok((
        SessionHistoryResult {
            messages,
            refinements,
            harness_entries,
            read_only: true,
            truncated,
            warning,
        },
        after,
    ))
}

fn load_session_history_blocking(
    session_path: String,
    expected_session_id: Option<String>,
    project_path: String,
    home: PathBuf,
) -> Result<SessionHistoryResult, String> {
    let expected_session_id = validate_identifier(expected_session_id)?;
    let project_path = validate_project_path(project_path)?;
    let (path, initial_stamp) = validate_session_file(session_path)?;
    let (first, first_after) =
        load_once(&path, expected_session_id.as_deref(), &project_path, &home)?;
    if initial_stamp == first_after {
        return Ok(first);
    }
    let (second, second_after) =
        load_once(&path, expected_session_id.as_deref(), &project_path, &home)?;
    if first_after != second_after {
        return Err(
            "La session est encore en cours de modification; réessayez dans un instant".to_string(),
        );
    }
    Ok(second)
}

#[tauri::command]
pub async fn load_session_history(
    app: AppHandle,
    session_path: String,
    expected_session_id: Option<String>,
    project_path: String,
) -> Result<SessionHistoryResult, String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|error| format!("Impossible de localiser le dossier utilisateur: {error}"))?;
    crate::run_blocking(move || {
        load_session_history_blocking(session_path, expected_session_id, project_path, home)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use std::io::Write;
    use tempfile::TempDir;

    struct Fixture {
        _temp: TempDir,
        home: PathBuf,
        project: PathBuf,
        session: PathBuf,
        session_id: String,
    }

    impl Fixture {
        fn new(lines: &[Value]) -> Self {
            let temp = tempfile::tempdir().unwrap();
            let home = temp.path().join("home");
            let project = temp.path().join("project");
            let sessions = home.join(".prime").join("agent").join("sessions");
            fs::create_dir_all(&sessions).unwrap();
            fs::create_dir_all(&project).unwrap();
            let session = sessions.join("session.jsonl");
            let session_id = "session-safe-id".to_string();
            let mut file = File::create(&session).unwrap();
            writeln!(
                file,
                "{}",
                json!({"type":"session","version":3,"id":session_id,"cwd":project})
            )
            .unwrap();
            for line in lines {
                writeln!(file, "{line}").unwrap();
            }
            Self {
                _temp: temp,
                home,
                project,
                session,
                session_id,
            }
        }

        fn load(&self) -> Result<SessionHistoryResult, String> {
            load_session_history_blocking(
                self.session.to_string_lossy().into_owned(),
                Some(self.session_id.clone()),
                self.project.to_string_lossy().into_owned(),
                self.home.clone(),
            )
        }

        fn write_harness_state(&self, scope: &str, memory_entries: Value) {
            let directory = if scope == "global" {
                self.home.join(".prime").join("agent").join("harness")
            } else {
                self.home
                    .join(".prime")
                    .join("agent")
                    .join("session-artifacts")
                    .join(&self.session_id)
                    .join("harness")
            };
            fs::create_dir_all(&directory).expect("harness directory");
            fs::write(
                directory.join("harness_state.json"),
                serde_json::to_vec_pretty(&json!({
                    "schema": 1,
                    "entries": {
                        "prompt": {},
                        "memory": memory_entries,
                        "skill": {},
                        "subagent": {}
                    },
                    "refinements": []
                }))
                .expect("harness state"),
            )
            .expect("write harness state");
        }
    }

    fn wrapped_attachment_message(visible: &str, private_fragment: &str) -> String {
        let context_id = "550e8400-e29b-41d4-a716-446655440000";
        let manifest = serde_json::to_vec(&json!([{
            "name": "report.pdf",
            "mimeType": "application/pdf",
            "size": 42,
            "isImage": false,
        }]))
        .expect("manifest");
        let encoded = URL_SAFE_NO_PAD.encode(manifest);
        let separator = if visible.is_empty() { "" } else { "\n\n" };
        let content_utf16 = private_fragment.encode_utf16().count();
        format!(
            "{visible}{separator}<prime_orbit_attachment_context v=\"1\" id=\"{context_id}\">\n<prime_orbit_manifest encoding=\"base64url\">{encoded}</prime_orbit_manifest>\n<file name=\"report.pdf\" content_utf16=\"{content_utf16}\">\n{private_fragment}\n</file>\n</prime_orbit_attachment_context>\n<prime_orbit_ui_boundary v=\"1\" id=\"{context_id}\" visible_utf16=\"{}\"/>",
            visible.encode_utf16().count()
        )
    }

    #[test]
    fn reconstructs_only_the_active_branch() {
        let fixture = Fixture::new(&[
            json!({"type":"message","id":"one","parentId":null,"timestamp":"2026-01-01T00:00:00Z","message":{"role":"user","content":"racine"}}),
            json!({"type":"message","id":"abandoned","parentId":"one","message":{"role":"assistant","content":"branche abandonnée"}}),
            json!({"type":"message","id":"active","parentId":"one","message":{"role":"assistant","content":"branche active"}}),
            json!({"type":"agent_status","id":"leaf","parentId":"active","status":{"summary":"secret interne"}}),
        ]);
        let history = fixture.load().unwrap();
        let serialized = serde_json::to_string(&history.messages).unwrap();
        assert!(serialized.contains("racine"));
        assert!(serialized.contains("branche active"));
        assert!(!serialized.contains("branche abandonnée"));
        assert!(!serialized.contains("secret interne"));
        assert!(history.read_only);
    }

    #[test]
    fn exposes_only_sanitized_refinement_history_and_current_observed_entries() {
        let fixture = Fixture::new(&[
            json!({
                "type":"custom","customType":"prime-agent.refinement","id":"custom-create","parentId":null,"timestamp":"2026-08-21T10:00:00Z",
                "data":{"id":"refine-create","summary":"Create memory","scope":"local","harnessStatePath":"C:\\private\\harness_state.json","appliedEdits":[{
                    "action":"create","kind":"memory","id":"decision","title":"Initial decision","content":"old","path":"C:\\private\\memory.md","applied":true,
                    "after":{"title":"Initial decision","content":"old","path":"C:\\private\\memory.md","metadata":{"token":"SECRET"}}
                }]}
            }),
            json!({
                "type":"custom","customType":"prime-agent.refinement","id":"custom-update","parentId":"custom-create","timestamp":"2026-08-21T10:01:00Z",
                "data":{"id":"refine-update","summary":"Update memory","scope":"local","appliedEdits":[{
                    "action":"update","kind":"memory","id":"decision","applied":true,
                    "before":{"title":"Initial decision","content":"old"},
                    "after":{"title":"Final decision","content":"new","reference":{"secret":"REFERENCE_SECRET"}}
                },{
                    "action":"create","kind":"skill","id":"validator","applied":true,
                    "after":{"title":"Validation skill","content":"Run validation safely","path":"C:\\private\\skill.py"}
                }]}
            }),
            json!({
                "type":"custom","customType":"prime-agent.refinement","id":"custom-delete","parentId":"custom-update","timestamp":"2026-08-21T10:02:00Z",
                "data":{"id":"refine-delete","summary":"Delete memory","scope":"local","appliedEdits":[{
                    "action":"delete","kind":"memory","id":"decision","applied":true,
                    "before":{"title":"Final decision","content":"new","path":"C:\\private\\memory.md"}
                }]}
            }),
        ]);

        let history = fixture.load().expect("load refinements");
        assert_eq!(history.refinements.len(), 3);
        assert_eq!(history.harness_entries.len(), 1);
        assert_eq!(history.harness_entries[0].kind, "skill");
        assert_eq!(
            history.harness_entries[0].title.as_deref(),
            Some("Validation skill")
        );
        let serialized = serde_json::to_string(&(history.refinements, history.harness_entries))
            .expect("public refinements");
        for private in [
            "harnessStatePath",
            "C:\\\\private",
            "REFERENCE_SECRET",
            "SECRET",
            "metadata",
            "reference",
            "before",
            "after",
        ] {
            assert!(!serialized.contains(private), "leaked {private}");
        }
    }

    #[test]
    fn overlays_real_harness_state_and_treats_present_empty_as_authoritative() {
        let fixture = Fixture::new(&[
            json!({
                "type":"custom","customType":"prime-agent.refinement","id":"custom-local","parentId":null,"timestamp":"2026-08-21T10:00:00Z",
                "data":{"id":"refine-local","scope":"local","appliedEdits":[{
                    "action":"create","kind":"memory","id":"stale-local","applied":true,
                    "after":{"title":"Stale local","content":"must disappear"}
                }]}
            }),
            json!({
                "type":"custom","customType":"prime-agent.refinement","id":"custom-global","parentId":"custom-local","timestamp":"2026-08-21T10:01:00Z",
                "data":{"id":"refine-global","scope":"global","appliedEdits":[{
                    "action":"create","kind":"memory","id":"stale-global","applied":true,
                    "after":{"title":"Stale global","content":"must be replaced"}
                }]}
            }),
        ]);
        fixture.write_harness_state("local", json!({}));
        fixture.write_harness_state(
            "global",
            json!({
                "direct-python-entry": {
                    "id":"direct-python-entry",
                    "kind":"memory",
                    "scope":"global",
                    "title":"Real global memory",
                    "content":"visible current state",
                    "path":"C:\\private\\memory.md",
                    "reference":{"token":"REFERENCE_SECRET"},
                    "arguments":{"secret":"ARGUMENT_SECRET"},
                    "metadata":{"secret":"METADATA_SECRET"},
                    "updated_at":"2026-08-21T11:00:00Z",
                    "version":1
                }
            }),
        );

        let history = fixture.load().expect("load real harness inventory");
        assert_eq!(history.harness_entries.len(), 1);
        let entry = &history.harness_entries[0];
        assert_eq!(entry.id, "direct-python-entry");
        assert_eq!(entry.scope, "global");
        assert_eq!(entry.title.as_deref(), Some("Real global memory"));
        assert_eq!(entry.content.as_deref(), Some("visible current state"));
        assert!(entry.refinement_id.is_empty());
        let serialized = serde_json::to_string(&history.harness_entries).expect("inventory IPC");
        for forbidden in [
            "stale-local",
            "stale-global",
            "C:\\\\private",
            "REFERENCE_SECRET",
            "ARGUMENT_SECRET",
            "METADATA_SECRET",
            "metadata",
            "reference",
            "arguments",
            "path",
        ] {
            assert!(!serialized.contains(forbidden), "leaked {forbidden}");
        }
    }

    #[test]
    fn bounds_refinement_audit_rows_after_folding_all_records_into_the_snapshot() {
        let lines = (0..MAX_REFINEMENT_RECORDS + 5)
            .map(|index| json!({
                "type":"custom","customType":"prime-agent.refinement","id":format!("custom-{index}"),"parentId":null,"timestamp":format!("2026-08-21T10:{:02}:00Z", index % 60),
                "data":{"id":format!("refine-{index}"),"summary":format!("Create {index}"),"scope":"local","appliedEdits":[{
                    "action":"create","kind":"memory","id":format!("memory-{index}"),"applied":true,
                    "after":{"title":format!("Memory {index}"),"content":"bounded"}
                }]}
            }))
            .collect::<Vec<_>>();
        let fixture = Fixture::new(&lines);

        let history = fixture.load().expect("load bounded refinements");
        assert_eq!(history.refinements.len(), MAX_REFINEMENT_RECORDS);
        assert_eq!(history.harness_entries.len(), MAX_REFINEMENT_RECORDS + 5);
        assert!(history
            .harness_entries
            .iter()
            .any(|entry| entry.id == "memory-0"));
        assert!(history.truncated);
    }

    #[test]
    fn folds_edits_after_the_visible_per_record_limit() {
        let mut edits = vec![json!({
            "action":"create","kind":"memory","id":"victim","applied":true,
            "after":{"title":"Victim","content":"must be deleted","scope":"local"}
        })];
        edits.extend((1..MAX_REFINEMENT_EDITS).map(|index| {
            json!({
                "action":"create","kind":"memory","id":format!("memory-{index}"),"applied":true,
                "after":{"title":format!("Memory {index}"),"content":"kept","scope":"local"}
            })
        }));
        edits.push(json!({
            "action":"delete","kind":"memory","id":"victim","applied":true,
            "before":{"title":"Victim","content":"must be deleted","scope":"local"}
        }));
        let fixture = Fixture::new(&[json!({
            "type":"custom","customType":"prime-agent.refinement","id":"custom-many-edits","parentId":null,"timestamp":"2026-08-21T10:00:00Z",
            "data":{"id":"refine-many-edits","scope":"local","appliedEdits":edits}
        })]);

        let history = fixture.load().expect("load all refinement edits");
        assert_eq!(
            history.refinements[0].applied_edits.len(),
            MAX_REFINEMENT_EDITS
        );
        assert!(!history
            .harness_entries
            .iter()
            .any(|entry| entry.id == "victim"));
        assert_eq!(history.harness_entries.len(), MAX_REFINEMENT_EDITS - 1);
        assert!(history.truncated);
    }

    #[test]
    fn rejects_oversized_ids_instead_of_folding_colliding_prefixes() {
        let common = "x".repeat(MAX_REFINEMENT_ID_CHARS);
        let fixture = Fixture::new(&[json!({
            "type":"custom","customType":"prime-agent.refinement","id":"custom-long-ids","parentId":null,"timestamp":"2026-08-21T10:00:00Z",
            "data":{"id":"refine-long-ids","scope":"local","appliedEdits":[
                {"action":"create","kind":"memory","id":format!("{common}a"),"applied":true,"after":{"title":"A","content":"one","scope":"local"}},
                {"action":"create","kind":"memory","id":format!("{common}b"),"applied":true,"after":{"title":"B","content":"two","scope":"local"}}
            ]}
        })]);

        let history = fixture.load().expect("load oversized ids safely");
        assert!(history.harness_entries.is_empty());
        assert!(history.refinements[0].applied_edits.is_empty());
        assert!(history.truncated);
    }

    #[test]
    fn keeps_refinement_projection_inside_its_ipc_budget() {
        let detail = "d".repeat(MAX_REFINEMENT_SUMMARY_CHARS);
        let lines = (0..MAX_REFINEMENT_RECORDS)
            .map(|record| {
                let edits = (0..MAX_REFINEMENT_EDITS)
                    .map(|edit| json!({
                        "action":"create","kind":"memory","id":format!("memory-{record}-{edit}"),
                        "title":detail,"applied":false,"error":detail
                    }))
                    .collect::<Vec<_>>();
                json!({
                    "type":"custom","customType":"prime-agent.refinement","id":format!("custom-budget-{record}"),"parentId":null,"timestamp":"2026-08-21T10:00:00Z",
                    "data":{"id":format!("refine-budget-{record}"),"summary":detail,"scope":"local","appliedEdits":edits}
                })
            })
            .collect::<Vec<_>>();
        let fixture = Fixture::new(&lines);

        let history = fixture.load().expect("load bounded refinement projection");
        let refinement_bytes = serde_json::to_vec(&(
            history.refinements.as_slice(),
            history.harness_entries.as_slice(),
        ))
        .expect("serialize refinement projection")
        .len();
        let combined_bytes = serde_json::to_vec(&(
            history.messages.as_slice(),
            history.refinements.as_slice(),
            history.harness_entries.as_slice(),
        ))
        .expect("serialize combined projection")
        .len();
        assert!(refinement_bytes <= MAX_REFINEMENT_IPC_BYTES);
        assert!(combined_bytes <= MAX_IPC_BYTES);
        assert!(history.refinements.len() < MAX_REFINEMENT_RECORDS);
        assert!(history.truncated);
    }

    #[test]
    fn strips_large_attachment_context_before_history_truncation() {
        let staged_path = r#"C:\Users\example\AppData\Roaming\Prime Orbit\session-attachments\private\prime-orbit-attachments\uuid\attachment.pdf"#;
        let private_fragment = format!(
            "[Attachment staged by Prime Orbit at {staged_path}]{}",
            "PRIVATE_DOCUMENT_CONTENT".repeat(4_000)
        );
        assert!(private_fragment.len() > MAX_SUMMARY_CHARS);
        let wrapped = wrapped_attachment_message("visible question", &private_fragment);
        let fixture = Fixture::new(&[json!({
            "type":"message",
            "id":"one",
            "parentId":null,
            "message":{"role":"user","content":wrapped}
        })]);

        let history = fixture.load().expect("load sanitized history");
        let serialized =
            serde_json::to_string(&history.messages).expect("serialize public history");
        assert!(serialized.contains("visible question"));
        assert!(serialized.contains("primeOrbitAttachments"));
        assert!(serialized.contains("report.pdf"));
        assert!(!serialized.contains("PRIVATE_DOCUMENT_CONTENT"));
        assert!(!serialized.contains("session-attachments"));
        assert!(!serialized.contains("prime_orbit_attachment_context"));
        assert!(!serialized.contains("prime_orbit_ui_boundary"));
        assert_eq!(history.messages[0]["content"], "visible question");
        assert_eq!(
            history.messages[0]["primeOrbitAttachments"][0]["mimeType"],
            "application/pdf"
        );
    }

    #[test]
    fn assistant_and_tool_wrappers_are_stripped_without_attachment_sidecars() {
        let private = r#"PRIVATE_TOOL_BODY C:\Users\example\session-attachments\secret.pdf"#;
        let assistant = wrapped_attachment_message("assistant visible", private);
        let tool = wrapped_attachment_message("tool visible", private);
        let fixture = Fixture::new(&[
            json!({
                "type":"message",
                "id":"assistant",
                "parentId":null,
                "message":{"role":"assistant","content":assistant}
            }),
            json!({
                "type":"message",
                "id":"tool",
                "parentId":"assistant",
                "message":{"role":"toolResult","content":[{"type":"text","text":tool}]}
            }),
        ]);

        let history = fixture.load().expect("load sanitized history");
        let serialized = serde_json::to_string(&history.messages).expect("public history");
        assert!(!serialized.contains("PRIVATE_TOOL_BODY"));
        assert!(!serialized.contains("session-attachments"));
        assert!(!serialized.contains("primeOrbitAttachments"));
        assert_eq!(history.messages[0]["content"], "assistant visible");
        assert_eq!(history.messages[1]["content"][0]["text"], "tool visible");
    }

    #[test]
    fn preserves_only_safe_agent_message_history_details() {
        let fixture = Fixture::new(&[json!({
            "type":"custom_message",
            "customType":"agent_message",
            "id":"entry-agent-message",
            "parentId":null,
            "timestamp":"2026-01-01T00:00:00Z",
            "display":true,
            "content":"[from child:audit-security]\nAgent-to-agent message received.\nSource: agent_message\nFrom: audit-security, active ACTIVE_SECRET, session SESSION_SECRET, client CLIENT_SECRET\nTo: main, active TARGET_ACTIVE_SECRET, session TARGET_SESSION_SECRET\nMessage id: agentmsg_public\n\nAudit terminé.",
            "details":{
                "id":"agentmsg_public",
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
            }
        })]);

        let history = fixture.load().expect("load safe agent message");
        assert_eq!(history.messages.len(), 1);
        assert_eq!(history.messages[0]["role"], "custom");
        assert_eq!(history.messages[0]["customType"], "agent_message");
        assert_eq!(history.messages[0]["content"], "Audit terminé.");
        assert_eq!(
            history.messages[0]["details"],
            json!({
                "id":"agentmsg_public",
                "message":"Audit terminé.",
                "from":{"sessionName":"audit-security"},
                "fromRelationship":"child",
                "target":{"sessionName":"main"}
            })
        );
        let serialized = serde_json::to_string(&history.messages).expect("public history");
        for private_value in [
            "ACTIVE_SECRET",
            "SESSION_SECRET",
            "CLIENT_SECRET",
            "TARGET_ACTIVE_SECRET",
            "TARGET_SESSION_SECRET",
            "AUTH_SECRET",
            "ARBITRARY_SECRET",
            "runtimeKind",
            "activeSessionId",
            "sessionId",
            "clientId",
            "authorization",
            "arbitrary",
        ] {
            assert!(
                !serialized.contains(private_value),
                "leaked {private_value}"
            );
        }
    }

    #[test]
    fn rejects_unbounded_agent_message_identifiers_before_ipc() {
        let fixture = Fixture::new(&[json!({
            "type":"custom_message",
            "customType":"agent_message",
            "id":"entry-agent-message",
            "parentId":null,
            "display":true,
            "content":"raw protocol must not cross IPC",
            "details":{
                "id":format!("agentmsg_{}", "x".repeat(MAX_PUBLIC_AGENT_MESSAGE_ID_SUFFIX_CHARS + 1)),
                "message":"still private because the envelope is invalid",
                "from":{"sessionName":"audit"},
                "fromRelationship":"child",
                "target":{"sessionName":"main"}
            }
        })]);

        let history = fixture.load().expect("ignore invalid agent message");
        assert!(history.messages.is_empty());
        assert!(history.truncated);
    }

    #[test]
    fn catalogs_terminal_sessions_without_loading_their_transcript() {
        let fixture = Fixture::new(&[
            json!({"type":"session_info","id":"name","parentId":null,"name":"Audit terminal"}),
            json!({"type":"message","id":"one","parentId":"name","timestamp":"2026-01-01T00:00:00Z","message":{"role":"user","content":"Inspecte le dépôt depuis le terminal"}}),
            json!({"type":"message","id":"two","parentId":"one","message":{"role":"assistant","content":"Détails confidentiels non nécessaires au catalogue"}}),
        ]);
        let entry = scan_catalog_entry(&fixture.session).expect("catalog entry");
        assert_eq!(entry.session_id, fixture.session_id);
        assert_eq!(entry.session_name.as_deref(), Some("Audit terminal"));
        assert_eq!(
            entry.first_message.as_deref(),
            Some("Inspecte le dépôt depuis le terminal")
        );
        assert_eq!(entry.message_count, 2);
        assert_eq!(entry.rlm_depth, 0);
        assert_eq!(Path::new(&entry.cwd), fixture.project);
    }

    #[test]
    fn applies_compaction_and_filters_private_fields() {
        let fixture = Fixture::new(&[
            json!({"type":"message","id":"old","parentId":null,"message":{"role":"user","content":"ancien"}}),
            json!({"type":"message","id":"kept","parentId":"old","message":{"role":"assistant","content":[{"type":"text","text":"conservé"},{"type":"image","data":"BASE64_SECRET"},{"type":"toolCall","id":"call-details","name":"python","arguments":{"authorization":"Bearer ARGUMENT_SECRET","path":"safe.py"}}],"thinking":"raisonnement privé"}}),
            json!({"type":"compaction","id":"compact","parentId":"kept","summary":"résumé","firstKeptEntryId":"kept","tokensBefore":100}),
            json!({"type":"custom_message","id":"hidden","parentId":"compact","display":false,"content":"message caché","details":{"token":"SECRET"}}),
            json!({"type":"message","id":"hidden-role","parentId":"hidden","message":{"role":"custom","display":false,"content":"custom caché","details":{"token":"SECRET"}}}),
            json!({"type":"message","id":"result","parentId":"hidden-role","message":{"role":"toolResult","toolCallId":"call","content":[{"type":"text","text":"sortie"}],"details":{"auth":"SECRET"}}}),
            json!({"type":"message","id":"details-result","parentId":"result","message":{"role":"toolResult","toolCallId":"call-details","details":{"text":"détail visible","token":"DETAIL_SECRET","auth":"AUTH_SECRET","credentials":"CREDENTIAL_SECRET","privateKey":"PRIVATE_KEY_SECRET"}}}),
        ]);
        let history = fixture.load().unwrap();
        let serialized = serde_json::to_string(&history.messages).unwrap();
        assert!(serialized.contains("résumé"));
        assert!(serialized.contains("conservé"));
        assert!(serialized.contains("sortie"));
        assert!(serialized.contains("détail visible"));
        assert!(serialized.contains("\"details\""));
        assert!(serialized.contains("safe.py"));
        assert!(!serialized.contains("ancien"));
        assert!(!serialized.contains("BASE64_SECRET"));
        assert!(!serialized.contains("raisonnement privé"));
        assert!(!serialized.contains("message caché"));
        assert!(!serialized.contains("custom caché"));
        assert!(!serialized.contains("ARGUMENT_SECRET"));
        assert!(!serialized.contains("DETAIL_SECRET"));
        assert!(!serialized.contains("AUTH_SECRET"));
        assert!(!serialized.contains("CREDENTIAL_SECRET"));
        assert!(!serialized.contains("PRIVATE_KEY_SECRET"));
        assert!(!serialized.contains("SECRET"));
    }

    #[test]
    fn rejects_mismatched_untrusted_session() {
        let fixture = Fixture::new(&[json!({
            "type":"message","id":"one","parentId":null,
            "message":{"role":"user","content":"ne doit pas sortir"}
        })]);
        let outside = fixture._temp.path().join("outside.jsonl");
        fs::copy(&fixture.session, &outside).unwrap();
        let error = load_session_history_blocking(
            outside.to_string_lossy().into_owned(),
            Some("different-id".to_string()),
            fixture.project.to_string_lossy().into_owned(),
            fixture.home.clone(),
        )
        .unwrap_err();
        assert!(error.contains("ne correspond"));
    }

    #[test]
    fn rejects_a_known_root_session_when_expected_id_mismatches() {
        let fixture = Fixture::new(&[json!({
            "type":"message","id":"one","parentId":null,
            "message":{"role":"user","content":"autre conversation"}
        })]);
        let error = load_session_history_blocking(
            fixture.session.to_string_lossy().into_owned(),
            Some("different-id".to_string()),
            fixture.project.to_string_lossy().into_owned(),
            fixture.home.clone(),
        )
        .unwrap_err();
        assert!(error.contains("conversation sélectionnée"));
    }

    #[test]
    fn tolerates_only_a_partial_final_line() {
        let fixture = Fixture::new(&[json!({
            "type":"message","id":"one","parentId":null,
            "message":{"role":"user","content":"visible"}
        })]);
        let mut file = fs::OpenOptions::new()
            .append(true)
            .open(&fixture.session)
            .unwrap();
        write!(file, "{{\"type\":\"message\"").unwrap();
        let history = fixture.load().unwrap();
        assert_eq!(history.messages.len(), 1);
        assert!(history.truncated);
        assert!(history.warning.unwrap().contains("incomplète"));
    }

    #[test]
    fn rejects_an_invalid_interior_line() {
        let fixture = Fixture::new(&[]);
        let mut file = fs::OpenOptions::new()
            .append(true)
            .open(&fixture.session)
            .unwrap();
        writeln!(file, "not-json").unwrap();
        writeln!(file, "{}", json!({"type":"message","id":"one","parentId":null,"message":{"role":"user","content":"x"}})).unwrap();
        let error = fixture.load().unwrap_err();
        assert!(error.contains("intérieure"));
    }

    #[test]
    fn migrates_v1_compaction_in_memory_without_rewriting() {
        let fixture = Fixture::new(&[]);
        let mut file = File::create(&fixture.session).unwrap();
        for entry in [
            json!({"type":"session","id":fixture.session_id,"cwd":fixture.project}),
            json!({"type":"message","message":{"role":"user","content":"ancien"}}),
            json!({"type":"message","message":{"role":"assistant","content":"conservé"}}),
            json!({"type":"compaction","summary":"résumé v1","firstKeptEntryIndex":2}),
            json!({"type":"message","message":{"role":"user","content":"récent"}}),
        ] {
            writeln!(file, "{entry}").unwrap();
        }
        drop(file);
        let history = fixture.load().unwrap();
        let serialized = serde_json::to_string(&history.messages).unwrap();
        assert!(serialized.contains("résumé v1"));
        assert!(serialized.contains("conservé"));
        assert!(serialized.contains("récent"));
        assert!(!serialized.contains("ancien"));
        let first_line = fs::read_to_string(&fixture.session)
            .unwrap()
            .lines()
            .next()
            .unwrap()
            .to_string();
        assert!(!first_line.contains("version"));
    }

    #[test]
    fn folds_child_usage_only_into_the_target_assistant_message() {
        let mut entries = vec![
            json!({"type":"message","id":"assistant","message":{"role":"assistant","content":"ok"}}),
            json!({"type":"message","id":"user","message":{"role":"user","content":"question"}}),
            json!({"type":"child_usage_attributed","targetId":"assistant","aggregateUsage":{"totalTokens":17}}),
            json!({"type":"child_usage_attributed","targetId":"user","aggregateUsage":{"totalTokens":99}}),
            json!({"type":"child_usage_attributed","targetId":"missing","aggregateUsage":{"totalTokens":101}}),
        ];

        fold_child_usage_attributions(&mut entries);

        assert_eq!(entries[0]["message"]["usage"]["totalTokens"], 17);
        assert!(entries[1]["message"].get("usage").is_none());
    }

    #[test]
    fn folds_a_large_usage_set_by_id() {
        const COUNT: usize = 20_000;
        let mut entries = Vec::with_capacity(COUNT * 2);
        for index in 0..COUNT {
            entries.push(json!({
                "type":"message",
                "id":format!("assistant-{index}"),
                "message":{"role":"assistant","content":"ok"}
            }));
        }
        for index in 0..COUNT {
            entries.push(json!({
                "type":"child_usage_attributed",
                "targetId":format!("assistant-{index}"),
                "aggregateUsage":{"totalTokens":index}
            }));
        }

        fold_child_usage_attributions(&mut entries);

        assert_eq!(entries[0]["message"]["usage"]["totalTokens"], 0);
        assert_eq!(
            entries[COUNT - 1]["message"]["usage"]["totalTokens"],
            COUNT - 1
        );
    }
}
