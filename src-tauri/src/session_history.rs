use crate::paths::canonicalize;
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

const CURRENT_SESSION_VERSION: u64 = 3;
const MAX_SESSION_BYTES: u64 = 64 * 1024 * 1024;
const MAX_LINE_BYTES: usize = 8 * 1024 * 1024;
const MAX_ENTRIES: usize = 100_000;
const MAX_MESSAGES: usize = 5_000;
const MAX_PUBLIC_TEXT_CHARS: usize = 16_000;
const MAX_SUMMARY_CHARS: usize = 64_000;
const MAX_IPC_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionHistoryResult {
    pub messages: Vec<Value>,
    pub read_only: bool,
    pub truncated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
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
    if value.chars().count() <= limit {
        return value.to_string();
    }
    *truncated = true;
    let mut text = value.chars().take(limit).collect::<String>();
    text.push_str("\n… [historique tronqué]");
    text
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

fn sanitized_content(value: &Value, truncated: &mut bool) -> Value {
    match value {
        Value::String(text) => Value::String(truncate_text(
            text,
            MAX_SUMMARY_CHARS,
            truncated,
        )),
        Value::Array(blocks) => Value::Array(
            blocks
                .iter()
                .filter_map(|block| {
                    let object = block.as_object()?;
                    match object.get("type").and_then(Value::as_str)? {
                        "text" | "output_text" => Some(json!({
                            "type": object.get("type").and_then(Value::as_str).unwrap_or("text"),
                            "text": truncate_text(
                                object.get("text").or_else(|| object.get("content")).and_then(Value::as_str).unwrap_or_default(),
                                MAX_PUBLIC_TEXT_CHARS,
                                truncated,
                            ),
                        })),
                        "toolCall" => Some(json!({
                            "type": "toolCall",
                            "id": object.get("id").and_then(Value::as_str).unwrap_or("tool"),
                            "name": object.get("name").and_then(Value::as_str).unwrap_or("tool"),
                            "arguments": sanitize_payload(object.get("arguments").unwrap_or(&Value::Null), truncated),
                        })),
                        // Never move image bytes or URLs over IPC. The UI only
                        // needs the marker to render its existing placeholder.
                        "image" | "image_url" => Some(json!({
                            "type": "image",
                            "mimeType": object.get("mimeType").and_then(Value::as_str),
                        })),
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
            public.insert("id".to_string(), Value::String(entry.id.clone()));
            public.insert("role".to_string(), Value::String(role.to_string()));
            copy_timestamp(&mut public, &Value::Object(source.clone()), &entry.value);
            if let Some(content) = source.get("content") {
                let content = if role == "toolResult" {
                    match content {
                        Value::String(text) => {
                            Value::String(truncate_text(text, MAX_PUBLIC_TEXT_CHARS, truncated))
                        }
                        _ => sanitized_content(content, truncated),
                    }
                } else {
                    sanitized_content(content, truncated)
                };
                public.insert("content".to_string(), content);
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
            public.insert("id".to_string(), Value::String(entry.id.clone()));
            public.insert("role".to_string(), Value::String("custom".to_string()));
            public.insert("display".to_string(), Value::Bool(true));
            copy_timestamp(&mut public, &entry.value, &entry.value);
            public.insert(
                "content".to_string(),
                sanitized_content(
                    entry
                        .value
                        .get("content")
                        .unwrap_or(&Value::String(String::new())),
                    truncated,
                ),
            );
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
    while messages.len() > 1 && size > MAX_IPC_BYTES {
        truncated = true;
        size = size.saturating_sub(serde_json::to_vec(&messages[0]).map_or(0, |value| value.len()));
        messages.remove(0);
    }
    if size > MAX_IPC_BYTES {
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
    let (messages, output_truncated) = build_public_messages(&parsed.entries)?;
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
    Ok((
        SessionHistoryResult {
            messages,
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
