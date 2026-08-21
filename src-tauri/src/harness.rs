use crate::{
    paths::canonicalize,
    session_lease::resolve_agent_dir,
    storage::{write_atomic, PersistenceLock},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    ffi::{OsStr, OsString},
    fs::{self, File, Metadata},
    io::{BufRead, BufReader, Read},
    path::{Component, Path, PathBuf},
    sync::Arc,
};
use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;

const CURRENT_SESSION_VERSION: u64 = 3;
const CURRENT_HARNESS_SCHEMA: u64 = 1;
const MAX_SESSION_BYTES: u64 = 64 * 1024 * 1024;
const MAX_SESSION_LINE_BYTES: usize = 8 * 1024 * 1024;
const MAX_SESSION_ENTRIES: usize = 100_000;
const MAX_HARNESS_BYTES: u64 = 8 * 1024 * 1024;
const MAX_REFINEMENT_JOURNAL_BYTES: u64 = 64 * 1024 * 1024;
const MAX_HARNESS_ENTRIES: usize = 10_000;
const MAX_INVENTORY_ENTRIES: usize = 256;
const MAX_INVENTORY_BYTES: usize = 768 * 1024;
const MAX_ID_CHARS: usize = 200;
const MAX_TITLE_CHARS: usize = 480;
const MAX_CONTENT_CHARS: usize = 4_000;
const MAX_TIMESTAMP_CHARS: usize = 80;

const HARNESS_KINDS: [&str; 4] = ["prompt", "memory", "skill", "subagent"];

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum HarnessScope {
    Local,
    Global,
}

impl HarnessScope {
    fn as_str(self) -> &'static str {
        match self {
            Self::Local => "local",
            Self::Global => "global",
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum HarnessKind {
    Prompt,
    Memory,
    Skill,
    Subagent,
}

impl HarnessKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Prompt => "prompt",
            Self::Memory => "memory",
            Self::Skill => "skill",
            Self::Subagent => "subagent",
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OpenTarget {
    File,
    Folder,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HarnessTargetInput {
    session_path: String,
    expected_session_id: String,
    project_path: String,
    scope: HarnessScope,
    target: OpenTarget,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeleteHarnessEntryInput {
    session_path: String,
    expected_session_id: String,
    project_path: String,
    scope: HarnessScope,
    kind: HarnessKind,
    id: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeleteHarnessEntryResult {
    pub deleted: bool,
    pub backup_created: bool,
}

/// Public, path-free projection of one entry from Prime Agent's real harness
/// state. Session history can merge this inventory with its append-only audit
/// trail without depending on this module's filesystem representation.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HarnessInventoryEntry {
    pub id: String,
    pub kind: String,
    pub scope: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HarnessInventory {
    pub entries: Vec<HarnessInventoryEntry>,
    pub local_available: bool,
    pub global_available: bool,
    pub truncated: bool,
}

#[derive(Debug, Clone)]
struct ValidatedHarnessContext {
    agent_root: PathBuf,
    session_path: PathBuf,
    local_harness_dir: PathBuf,
    global_harness_dir: PathBuf,
}

#[derive(Debug)]
struct StateSnapshot {
    bytes: Vec<u8>,
    value: Value,
}

fn is_link_or_reparse(metadata: &Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return true;
        }
    }
    false
}

fn validate_public_id(value: &str, label: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty()
        || value.chars().count() > MAX_ID_CHARS
        || value.chars().any(char::is_control)
        || value.contains('/')
        || value.contains('\\')
        || value == "."
        || value == ".."
    {
        return Err(format!("{label} est invalide"));
    }
    Ok(value.to_string())
}

fn validate_session_id(value: &str) -> Result<String, String> {
    let value = validate_public_id(value, "L’identifiant de session")?;
    if !value
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err("L’identifiant de session contient des caractères invalides".to_string());
    }
    Ok(value)
}

fn validate_project_path(project_path: &str) -> Result<PathBuf, String> {
    let requested = PathBuf::from(project_path);
    if !requested.is_absolute() {
        return Err("Le chemin du projet doit être absolu".to_string());
    }
    let metadata = fs::symlink_metadata(&requested).map_err(|error| {
        format!(
            "Le projet {} est inaccessible: {error}",
            requested.display()
        )
    })?;
    if is_link_or_reparse(&metadata) || !metadata.is_dir() {
        return Err("Le projet doit être un dossier local non symbolique".to_string());
    }
    canonicalize(&requested).map_err(|error| {
        format!(
            "Impossible de résoudre le projet {}: {error}",
            requested.display()
        )
    })
}

fn validate_regular_directory(path: &Path, label: &str) -> Result<PathBuf, String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("{label} {} est inaccessible: {error}", path.display()))?;
    if is_link_or_reparse(&metadata) || !metadata.is_dir() {
        return Err(format!("{label} doit être un dossier local non symbolique"));
    }
    canonicalize(path)
        .map_err(|error| format!("Impossible de résoudre {}: {error}", path.display()))
}

fn configured_agent_root(home: &Path, project_path: &Path) -> Result<PathBuf, String> {
    let configured = std::env::var_os("PRIME_AGENT_CODING_AGENT_DIR")
        .or_else(|| std::env::var_os("PI_CODING_AGENT_DIR"));
    let resolved = resolve_agent_dir(home, project_path, configured.as_deref());
    if !resolved.is_absolute() {
        return Err("Le dossier interne de Prime Agent doit être absolu".to_string());
    }
    validate_regular_directory(&resolved, "Le dossier interne de Prime Agent")
}

fn validate_descendant_components(root: &Path, candidate: &Path) -> Result<(), String> {
    let relative = candidate
        .strip_prefix(root)
        .map_err(|_| "Le chemin demandé sort du dossier interne de Prime Agent".to_string())?;
    let mut current = root.to_path_buf();
    for component in relative.components() {
        let Component::Normal(segment) = component else {
            return Err("Le chemin interne de Prime Agent est invalide".to_string());
        };
        current.push(segment);
        match fs::symlink_metadata(&current) {
            Ok(metadata) if is_link_or_reparse(&metadata) => {
                return Err(
                    "Prime Orbit refuse un lien symbolique dans les données Prime Agent"
                        .to_string(),
                )
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
            Err(error) => {
                return Err(format!(
                    "Impossible d’inspecter les données Prime Agent: {error}"
                ))
            }
        }
    }
    Ok(())
}

fn read_session_header_and_validate_jsonl(path: &Path) -> Result<Value, String> {
    let file = File::open(path)
        .map_err(|error| format!("Impossible d’ouvrir la session Prime Agent: {error}"))?;
    let mut reader = BufReader::new(file);
    let mut line = Vec::new();
    let mut first = None;
    let mut entries = 0_usize;

    loop {
        line.clear();
        let read = reader
            .read_until(b'\n', &mut line)
            .map_err(|error| format!("Impossible de lire la session Prime Agent: {error}"))?;
        if read == 0 {
            break;
        }
        if line.len() > MAX_SESSION_LINE_BYTES {
            return Err("Une entrée de session Prime Agent est trop volumineuse".to_string());
        }
        let terminated = line.last() == Some(&b'\n');
        while matches!(line.last(), Some(b'\n' | b'\r')) {
            line.pop();
        }
        if first.is_none() && line.starts_with(&[0xef, 0xbb, 0xbf]) {
            line.drain(..3);
        }
        if line.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        let parsed = match serde_json::from_slice::<Value>(&line) {
            Ok(value) => value,
            Err(_) if !terminated => break,
            Err(error) => {
                return Err(format!(
                    "La session contient une entrée JSONL invalide: {error}"
                ))
            }
        };
        if !parsed.is_object() {
            return Err("La session contient une entrée JSONL invalide".to_string());
        }
        entries += 1;
        if entries > MAX_SESSION_ENTRIES {
            return Err("La session Prime Agent contient trop d’entrées".to_string());
        }
        if first.is_none() {
            first = Some(parsed);
        }
    }

    first.ok_or_else(|| "La session Prime Agent est vide".to_string())
}

fn validate_session_context(
    home: &Path,
    session_path: &str,
    expected_session_id: &str,
    project_path: &str,
) -> Result<ValidatedHarnessContext, String> {
    let expected_session_id = validate_session_id(expected_session_id)?;
    let project_path = validate_project_path(project_path)?;
    let agent_root = configured_agent_root(home, &project_path)?;
    let sessions_root = validate_regular_directory(
        &agent_root.join("sessions"),
        "Le dossier des sessions Prime Agent",
    )?;
    if !sessions_root.starts_with(&agent_root) {
        return Err("Le dossier des sessions sort du dossier interne Prime Agent".to_string());
    }

    let requested = PathBuf::from(session_path);
    if !requested.is_absolute()
        || requested
            .extension()
            .and_then(OsStr::to_str)
            .is_none_or(|extension| !extension.eq_ignore_ascii_case("jsonl"))
    {
        return Err("La session doit être un fichier JSONL Prime Agent absolu".to_string());
    }
    let metadata = fs::symlink_metadata(&requested)
        .map_err(|error| format!("La session Prime Agent est inaccessible: {error}"))?;
    if is_link_or_reparse(&metadata) || !metadata.is_file() {
        return Err("La session doit être un fichier local non symbolique".to_string());
    }
    if metadata.len() > MAX_SESSION_BYTES {
        return Err("La session Prime Agent est trop volumineuse".to_string());
    }
    let canonical_session = canonicalize(&requested)
        .map_err(|error| format!("Impossible de résoudre la session Prime Agent: {error}"))?;
    if !canonical_session.starts_with(&sessions_root) {
        return Err("La session sort du dossier interne de Prime Agent".to_string());
    }
    validate_descendant_components(&agent_root, &canonical_session)?;

    let header = read_session_header_and_validate_jsonl(&canonical_session)?;
    if header.get("type").and_then(Value::as_str) != Some("session") {
        return Err("Le fichier ne contient pas un en-tête de session Prime Agent".to_string());
    }
    let version = header.get("version").and_then(Value::as_u64).unwrap_or(1);
    if version == 0 || version > CURRENT_SESSION_VERSION {
        return Err(format!(
            "Version de session Prime Agent non prise en charge ({version})"
        ));
    }
    let header_id = validate_session_id(
        header
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| "L’en-tête de session ne contient pas d’identifiant".to_string())?,
    )?;
    if header_id != expected_session_id {
        return Err("La session ne correspond pas à la conversation sélectionnée".to_string());
    }
    let header_cwd = header
        .get("cwd")
        .and_then(Value::as_str)
        .ok_or_else(|| "L’en-tête de session ne contient pas de projet".to_string())?;
    let header_cwd = canonicalize(header_cwd)
        .map_err(|_| "Le projet enregistré dans la session est inaccessible".to_string())?;
    if header_cwd != project_path {
        return Err("La session ne correspond pas au projet sélectionné".to_string());
    }

    let local_harness_dir = agent_root
        .join("session-artifacts")
        .join(&header_id)
        .join("harness");
    let global_harness_dir = agent_root.join("harness");
    validate_descendant_components(&agent_root, &local_harness_dir)?;
    validate_descendant_components(&agent_root, &global_harness_dir)?;

    Ok(ValidatedHarnessContext {
        agent_root,
        session_path: canonical_session,
        local_harness_dir,
        global_harness_dir,
    })
}

fn harness_directory(context: &ValidatedHarnessContext, scope: HarnessScope) -> &Path {
    match scope {
        HarnessScope::Local => &context.local_harness_dir,
        HarnessScope::Global => &context.global_harness_dir,
    }
}

fn validate_existing_managed_directory(
    context: &ValidatedHarnessContext,
    directory: &Path,
) -> Result<PathBuf, String> {
    validate_descendant_components(&context.agent_root, directory)?;
    let canonical = validate_regular_directory(directory, "Le dossier du continual harness")?;
    if !canonical.starts_with(&context.agent_root) {
        return Err("Le dossier du continual harness sort des données Prime Agent".to_string());
    }
    Ok(canonical)
}

fn validate_existing_managed_file(
    context: &ValidatedHarnessContext,
    path: &Path,
    max_bytes: u64,
    label: &str,
) -> Result<PathBuf, String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("{label} n’a pas de dossier parent"))?;
    let canonical_parent = validate_existing_managed_directory(context, parent)?;
    let metadata =
        fs::symlink_metadata(path).map_err(|error| format!("{label} est inaccessible: {error}"))?;
    if is_link_or_reparse(&metadata) || !metadata.is_file() {
        return Err(format!("{label} doit être un fichier local non symbolique"));
    }
    if metadata.len() > max_bytes {
        return Err(format!("{label} est trop volumineux"));
    }
    let canonical = canonicalize(path).map_err(|error| format!("{label} est invalide: {error}"))?;
    if canonical.parent() != Some(canonical_parent.as_path())
        || !canonical.starts_with(&context.agent_root)
    {
        return Err(format!("{label} sort des données Prime Agent"));
    }
    Ok(canonical)
}

fn harness_schema(root: &Value) -> Result<u64, String> {
    let schema = root
        .get("schema")
        .and_then(Value::as_u64)
        .ok_or_else(|| "Le schéma du continual harness est invalide".to_string())?;
    if schema == 0 || schema > CURRENT_HARNESS_SCHEMA {
        return Err(format!(
            "Version du continual harness non prise en charge ({schema})"
        ));
    }
    Ok(schema)
}

fn validate_harness_shape(root: &Value) -> Result<(), String> {
    harness_schema(root)?;
    let entries = root
        .get("entries")
        .and_then(Value::as_object)
        .ok_or_else(|| {
            "Le continual harness ne contient pas de collection entries valide".to_string()
        })?;
    let count = HARNESS_KINDS.iter().try_fold(0_usize, |count, kind| {
        let records = entries
            .get(*kind)
            .and_then(Value::as_object)
            .ok_or_else(|| format!("La collection {kind} du continual harness est invalide"))?;
        count
            .checked_add(records.len())
            .ok_or_else(|| "Le continual harness contient trop d’entrées".to_string())
    })?;
    if count > MAX_HARNESS_ENTRIES {
        return Err("Le continual harness contient trop d’entrées".to_string());
    }
    Ok(())
}

fn read_state_snapshot(
    context: &ValidatedHarnessContext,
    state_path: &Path,
) -> Result<StateSnapshot, String> {
    let state_path = validate_existing_managed_file(
        context,
        state_path,
        MAX_HARNESS_BYTES,
        "Le fichier du continual harness",
    )?;
    let mut file = File::open(&state_path)
        .map_err(|error| format!("Impossible d’ouvrir le continual harness: {error}"))?;
    let metadata = file
        .metadata()
        .map_err(|error| format!("Impossible d’inspecter le continual harness: {error}"))?;
    if metadata.len() > MAX_HARNESS_BYTES {
        return Err("Le fichier du continual harness est trop volumineux".to_string());
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.read_to_end(&mut bytes)
        .map_err(|error| format!("Impossible de lire le continual harness: {error}"))?;
    if bytes.len() as u64 > MAX_HARNESS_BYTES {
        return Err("Le fichier du continual harness est trop volumineux".to_string());
    }
    let value: Value = serde_json::from_slice(&bytes)
        .map_err(|error| format!("Le JSON du continual harness est invalide: {error}"))?;
    if !value.is_object() {
        return Err("Le JSON du continual harness doit être un objet".to_string());
    }
    validate_harness_shape(&value)?;
    Ok(StateSnapshot { bytes, value })
}

fn truncate_public_text(value: &str, limit: usize, truncated: &mut bool) -> String {
    let value = value.trim();
    if value.chars().count() <= limit {
        return value.to_string();
    }
    *truncated = true;
    let mut output = value.chars().take(limit).collect::<String>();
    output.push('…');
    output
}

fn sanitized_inventory_for_state(
    snapshot: &StateSnapshot,
    scope: HarnessScope,
    output: &mut HarnessInventory,
) {
    let Some(entries) = snapshot.value.get("entries").and_then(Value::as_object) else {
        output.truncated = true;
        return;
    };
    for kind in HARNESS_KINDS {
        let Some(records) = entries.get(kind).and_then(Value::as_object) else {
            output.truncated = true;
            continue;
        };
        for (key, raw_entry) in records {
            if output.entries.len() >= MAX_INVENTORY_ENTRIES {
                output.truncated = true;
                return;
            }
            let Ok(key) = validate_public_id(key, "L’identifiant d’entrée") else {
                output.truncated = true;
                continue;
            };
            let Some(entry) = raw_entry.as_object() else {
                output.truncated = true;
                continue;
            };
            if entry.get("id").and_then(Value::as_str) != Some(key.as_str())
                || entry.get("kind").and_then(Value::as_str) != Some(kind)
                || entry
                    .get("scope")
                    .and_then(Value::as_str)
                    .is_some_and(|value| value != scope.as_str())
            {
                output.truncated = true;
                continue;
            }
            let title = entry
                .get("title")
                .and_then(Value::as_str)
                .and_then(|value| {
                    let value = truncate_public_text(value, MAX_TITLE_CHARS, &mut output.truncated);
                    (!value.is_empty()).then_some(value)
                });
            let content = entry
                .get("content")
                .and_then(Value::as_str)
                .and_then(|value| {
                    let value =
                        truncate_public_text(value, MAX_CONTENT_CHARS, &mut output.truncated);
                    (!value.is_empty()).then_some(value)
                });
            let updated_at = entry
                .get("updated_at")
                .and_then(Value::as_str)
                .or_else(|| entry.get("updatedAt").and_then(Value::as_str))
                .and_then(|value| {
                    if value.chars().any(char::is_control) {
                        output.truncated = true;
                        return None;
                    }
                    let value =
                        truncate_public_text(value, MAX_TIMESTAMP_CHARS, &mut output.truncated);
                    (!value.is_empty()).then_some(value)
                });
            output.entries.push(HarnessInventoryEntry {
                id: key,
                kind: kind.to_string(),
                scope: scope.as_str().to_string(),
                title,
                content,
                updated_at,
            });
            if serde_json::to_vec(&output.entries)
                .map_or(true, |bytes| bytes.len() > MAX_INVENTORY_BYTES)
            {
                output.entries.pop();
                output.truncated = true;
                return;
            }
        }
    }
}

fn read_optional_state(
    context: &ValidatedHarnessContext,
    scope: HarnessScope,
) -> Result<Option<StateSnapshot>, String> {
    let state_path = harness_directory(context, scope).join("harness_state.json");
    match fs::symlink_metadata(&state_path) {
        Ok(_) => read_state_snapshot(context, &state_path).map(Some),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!(
            "Impossible d’inspecter le continual harness: {error}"
        )),
    }
}

/// Reads the current local and global state stores after validating that the
/// session belongs to the selected project and Prime Agent root. No path,
/// reference, arguments, metadata, or arbitrary unknown field crosses IPC.
pub(crate) fn read_harness_inventory(
    home: &Path,
    session_path: &str,
    expected_session_id: &str,
    project_path: &str,
) -> Result<HarnessInventory, String> {
    let context = validate_session_context(home, session_path, expected_session_id, project_path)?;
    let mut output = HarnessInventory::default();
    for scope in [HarnessScope::Local, HarnessScope::Global] {
        if let Some(snapshot) = read_optional_state(&context, scope)? {
            match scope {
                HarnessScope::Local => output.local_available = true,
                HarnessScope::Global => output.global_available = true,
            }
            sanitized_inventory_for_state(&snapshot, scope, &mut output);
        }
    }
    output.entries.sort_by(|left, right| {
        right
            .updated_at
            .cmp(&left.updated_at)
            .then_with(|| left.scope.cmp(&right.scope))
            .then_with(|| left.kind.cmp(&right.kind))
            .then_with(|| left.id.cmp(&right.id))
    });
    Ok(output)
}

fn state_open_path(
    context: &ValidatedHarnessContext,
    scope: HarnessScope,
    target: OpenTarget,
) -> Result<PathBuf, String> {
    let directory = harness_directory(context, scope);
    match target {
        OpenTarget::Folder => validate_existing_managed_directory(context, directory),
        OpenTarget::File => validate_existing_managed_file(
            context,
            &directory.join("harness_state.json"),
            MAX_HARNESS_BYTES,
            "Le fichier du continual harness",
        ),
    }
}

fn refinement_open_path(
    context: &ValidatedHarnessContext,
    scope: HarnessScope,
    target: OpenTarget,
) -> Result<PathBuf, String> {
    match (scope, target) {
        (HarnessScope::Local, OpenTarget::File) => Ok(context.session_path.clone()),
        (HarnessScope::Local, OpenTarget::Folder) => context
            .session_path
            .parent()
            .map(Path::to_path_buf)
            .ok_or_else(|| "La session Prime Agent n’a pas de dossier parent".to_string()),
        (HarnessScope::Global, OpenTarget::Folder) => {
            validate_existing_managed_directory(context, &context.global_harness_dir)
        }
        (HarnessScope::Global, OpenTarget::File) => validate_existing_managed_file(
            context,
            &context.global_harness_dir.join("refinements.jsonl"),
            MAX_REFINEMENT_JOURNAL_BYTES,
            "Le journal global des refinements",
        ),
    }
}

fn open_validated_path(app: &AppHandle, path: PathBuf) -> Result<(), String> {
    app.opener()
        .open_path(path.to_string_lossy().into_owned(), None::<&str>)
        .map_err(|error| {
            "Impossible d’ouvrir la ressource demandée".to_string() + &format!(": {error}")
        })
}

#[tauri::command]
pub async fn open_harness_state(app: AppHandle, input: HarnessTargetInput) -> Result<(), String> {
    crate::run_blocking(move || {
        let home = app
            .path()
            .home_dir()
            .map_err(|error| format!("Impossible de localiser les données Prime Agent: {error}"))?;
        let context = validate_session_context(
            &home,
            &input.session_path,
            &input.expected_session_id,
            &input.project_path,
        )?;
        let path = state_open_path(&context, input.scope, input.target)?;
        open_validated_path(&app, path)
    })
    .await
}

#[tauri::command]
pub async fn open_refinement_journal(
    app: AppHandle,
    input: HarnessTargetInput,
) -> Result<(), String> {
    crate::run_blocking(move || {
        let home = app
            .path()
            .home_dir()
            .map_err(|error| format!("Impossible de localiser les données Prime Agent: {error}"))?;
        let context = validate_session_context(
            &home,
            &input.session_path,
            &input.expected_session_id,
            &input.project_path,
        )?;
        let path = refinement_open_path(&context, input.scope, input.target)?;
        open_validated_path(&app, path)
    })
    .await
}

fn backup_path(path: &Path) -> Result<PathBuf, String> {
    let file_name = path
        .file_name()
        .ok_or_else(|| "Le fichier du continual harness n’a pas de nom".to_string())?;
    let mut backup_name = OsString::from(file_name);
    backup_name.push(".bak");
    Ok(path.with_file_name(backup_name))
}

fn remove_exact_entry(
    root: &mut Value,
    scope: HarnessScope,
    kind: HarnessKind,
    id: &str,
) -> Result<(), String> {
    validate_harness_shape(root)?;
    let entries = root
        .get_mut("entries")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| "La collection entries du continual harness est invalide".to_string())?;
    let records = entries
        .get_mut(kind.as_str())
        .and_then(Value::as_object_mut)
        .ok_or_else(|| "La collection demandée du continual harness est invalide".to_string())?;
    let entry = records
        .get(id)
        .and_then(Value::as_object)
        .ok_or_else(|| "Cette entrée n’existe plus dans le continual harness".to_string())?;
    if entry.get("id").and_then(Value::as_str) != Some(id)
        || entry.get("kind").and_then(Value::as_str) != Some(kind.as_str())
        || entry
            .get("scope")
            .and_then(Value::as_str)
            .is_some_and(|value| value != scope.as_str())
    {
        return Err(
            "L’entrée demandée ne correspond plus exactement au continual harness".to_string(),
        );
    }
    records.remove(id);
    Ok(())
}

fn serialize_state(value: &Value) -> Result<Vec<u8>, String> {
    let mut bytes = serde_json::to_vec_pretty(value)
        .map_err(|error| format!("Impossible de sérialiser le continual harness: {error}"))?;
    bytes.push(b'\n');
    if bytes.len() as u64 > MAX_HARNESS_BYTES {
        return Err("Le continual harness modifié est trop volumineux".to_string());
    }
    Ok(bytes)
}

fn delete_with_snapshot(
    context: &ValidatedHarnessContext,
    scope: HarnessScope,
    kind: HarnessKind,
    id: &str,
    initial: StateSnapshot,
    persistence: &PersistenceLock,
) -> Result<DeleteHarnessEntryResult, String> {
    let state_path = harness_directory(context, scope).join("harness_state.json");
    let _guard = persistence.0.lock();

    let current = read_state_snapshot(context, &state_path)?;
    if current.bytes != initial.bytes {
        return Err(
            "Le continual harness a changé pendant l’opération; actualisez puis réessayez"
                .to_string(),
        );
    }
    let mut updated = current.value;
    remove_exact_entry(&mut updated, scope, kind, id)?;
    let updated_bytes = serialize_state(&updated)?;

    let backup = backup_path(&state_path)?;
    validate_descendant_components(&context.agent_root, &backup)?;
    write_atomic(&backup, &initial.bytes)?;

    // Prime Agent is a separate writer and does not share PersistenceLock.
    // Re-read immediately before replacement so the recoverable backup always
    // corresponds exactly to the file we intend to replace.
    let before_replace = read_state_snapshot(context, &state_path)?;
    if before_replace.bytes != initial.bytes {
        return Err(
            "Le continual harness a changé pendant l’opération; aucune entrée n’a été supprimée"
                .to_string(),
        );
    }
    write_atomic(&state_path, &updated_bytes)?;
    Ok(DeleteHarnessEntryResult {
        deleted: true,
        backup_created: true,
    })
}

fn delete_harness_entry_blocking(
    home: &Path,
    input: DeleteHarnessEntryInput,
    persistence: PersistenceLock,
) -> Result<DeleteHarnessEntryResult, String> {
    let id = validate_public_id(&input.id, "L’identifiant d’entrée")?;
    let context = validate_session_context(
        home,
        &input.session_path,
        &input.expected_session_id,
        &input.project_path,
    )?;
    let state_path = harness_directory(&context, input.scope).join("harness_state.json");
    let initial = read_state_snapshot(&context, &state_path)?;
    delete_with_snapshot(
        &context,
        input.scope,
        input.kind,
        &id,
        initial,
        &persistence,
    )
}

#[tauri::command]
pub async fn delete_harness_entry(
    app: AppHandle,
    input: DeleteHarnessEntryInput,
    persistence: tauri::State<'_, PersistenceLock>,
) -> Result<DeleteHarnessEntryResult, String> {
    let persistence = PersistenceLock(Arc::clone(&persistence.0));
    crate::run_blocking(move || {
        let home = app
            .path()
            .home_dir()
            .map_err(|error| format!("Impossible de localiser les données Prime Agent: {error}"))?;
        delete_harness_entry_blocking(&home, input, persistence)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::{collections::BTreeMap, fs};

    struct Fixture {
        _temp: tempfile::TempDir,
        home: PathBuf,
        project: PathBuf,
        session: PathBuf,
        session_id: String,
        agent_root: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let temp = tempfile::tempdir().expect("temporary directory");
            let home = temp.path().join("home");
            let project = temp.path().join("project");
            let agent_root = home.join(".prime").join("agent");
            let session_dir = agent_root.join("sessions").join("project-key");
            fs::create_dir_all(&session_dir).expect("session directory");
            fs::create_dir_all(&project).expect("project directory");
            let session_id = "session-safe-id".to_string();
            let session = session_dir.join("session.jsonl");
            let header = json!({
                "type": "session",
                "version": 3,
                "id": session_id,
                "cwd": project,
            });
            fs::write(&session, format!("{header}\n")).expect("session file");
            Self {
                _temp: temp,
                home,
                project,
                session,
                session_id,
                agent_root,
            }
        }

        fn harness_dir(&self, scope: HarnessScope) -> PathBuf {
            match scope {
                HarnessScope::Local => self
                    .agent_root
                    .join("session-artifacts")
                    .join(&self.session_id)
                    .join("harness"),
                HarnessScope::Global => self.agent_root.join("harness"),
            }
        }

        fn write_state(&self, scope: HarnessScope, value: &Value) -> PathBuf {
            let directory = self.harness_dir(scope);
            fs::create_dir_all(&directory).expect("harness directory");
            let path = directory.join("harness_state.json");
            fs::write(
                &path,
                format!("{}\n", serde_json::to_string_pretty(value).unwrap()),
            )
            .expect("harness state");
            path
        }

        fn context(&self) -> ValidatedHarnessContext {
            validate_session_context(
                &self.home,
                self.session.to_str().unwrap(),
                &self.session_id,
                self.project.to_str().unwrap(),
            )
            .expect("validated context")
        }
    }

    fn state(entries: Value) -> Value {
        json!({
            "schema": 1,
            "entries": entries,
            "refinements": [],
            "futureKnownByPrimeAgent": {"kept": true}
        })
    }

    fn complete_entries(memory: Value) -> Value {
        json!({
            "prompt": {},
            "memory": memory,
            "skill": {},
            "subagent": {},
        })
    }

    fn memory(id: &str, title: &str, content: &str, scope: &str) -> Value {
        json!({
            "id": id,
            "kind": "memory",
            "title": title,
            "content": content,
            "path": "private/path",
            "scope": scope,
            "reference": {"secret": true},
            "arguments": {},
            "metadata": {"private": true},
            "source": "refine",
            "created_at": "2026-08-21T10:00:00Z",
            "updated_at": "2026-08-21T11:00:00Z",
            "version": 1,
            "unknownEntryField": {"kept": true}
        })
    }

    #[test]
    fn validates_session_identity_cwd_and_internal_root() {
        let fixture = Fixture::new();
        assert!(fixture
            .context()
            .session_path
            .starts_with(&fixture.agent_root));

        let wrong_id = validate_session_context(
            &fixture.home,
            fixture.session.to_str().unwrap(),
            "another-session",
            fixture.project.to_str().unwrap(),
        )
        .expect_err("wrong id rejected");
        assert!(wrong_id.contains("conversation"));

        let outside = fixture._temp.path().join("outside.jsonl");
        fs::copy(&fixture.session, &outside).expect("outside session");
        let traversal = validate_session_context(
            &fixture.home,
            outside.to_str().unwrap(),
            &fixture.session_id,
            fixture.project.to_str().unwrap(),
        )
        .expect_err("outside path rejected");
        assert!(traversal.contains("dossier interne"));
    }

    #[test]
    fn rejects_future_schema_and_oversized_state() {
        let fixture = Fixture::new();
        let future = fixture.write_state(
            HarnessScope::Local,
            &json!({"schema": 2, "entries": complete_entries(json!({})), "refinements": []}),
        );
        let error = read_state_snapshot(&fixture.context(), &future).expect_err("future schema");
        assert!(error.contains("non prise en charge"));

        fs::write(&future, vec![b' '; (MAX_HARNESS_BYTES + 1) as usize]).expect("large state");
        let error = read_state_snapshot(&fixture.context(), &future).expect_err("large state");
        assert!(error.contains("volumineux"));
    }

    #[test]
    fn deletes_one_exact_entry_preserves_unknown_fields_and_creates_exact_backup() {
        let fixture = Fixture::new();
        let path = fixture.write_state(
            HarnessScope::Local,
            &state(complete_entries(json!({
                "keep": memory("keep", "Keep", "still here", "local"),
                "remove": memory("remove", "Remove", "delete me", "local")
            }))),
        );
        let original = fs::read(&path).expect("original bytes");
        let result = delete_harness_entry_blocking(
            &fixture.home,
            DeleteHarnessEntryInput {
                session_path: fixture.session.to_string_lossy().into_owned(),
                expected_session_id: fixture.session_id.clone(),
                project_path: fixture.project.to_string_lossy().into_owned(),
                scope: HarnessScope::Local,
                kind: HarnessKind::Memory,
                id: "remove".to_string(),
            },
            PersistenceLock::default(),
        )
        .expect("delete exact entry");
        assert_eq!(
            result,
            DeleteHarnessEntryResult {
                deleted: true,
                backup_created: true
            }
        );
        assert_eq!(
            fs::read(path.with_file_name("harness_state.json.bak")).unwrap(),
            original
        );
        let updated: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert!(updated["entries"]["memory"].get("remove").is_none());
        assert_eq!(
            updated["entries"]["memory"]["keep"]["unknownEntryField"]["kept"],
            true
        );
        assert_eq!(updated["futureKnownByPrimeAgent"]["kept"], true);
    }

    #[test]
    fn rejects_stale_snapshot_without_replacing_newer_state() {
        let fixture = Fixture::new();
        let path = fixture.write_state(
            HarnessScope::Global,
            &state(complete_entries(json!({
                "target": memory("target", "Old", "old", "global")
            }))),
        );
        let context = fixture.context();
        let stale = read_state_snapshot(&context, &path).expect("initial snapshot");
        let newer = state(complete_entries(json!({
            "target": memory("target", "New", "new", "global")
        })));
        fs::write(
            &path,
            format!("{}\n", serde_json::to_string_pretty(&newer).unwrap()),
        )
        .expect("newer state");
        let error = delete_with_snapshot(
            &context,
            HarnessScope::Global,
            HarnessKind::Memory,
            "target",
            stale,
            &PersistenceLock::default(),
        )
        .expect_err("stale snapshot rejected");
        assert!(error.contains("changé"));
        let persisted: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(persisted["entries"]["memory"]["target"]["title"], "New");
    }

    #[test]
    fn inventory_is_bounded_and_never_exposes_paths_or_private_metadata() {
        let fixture = Fixture::new();
        fixture.write_state(
            HarnessScope::Local,
            &state(complete_entries(json!({
                "safe": memory("safe", "Useful", "Visible content", "local")
            }))),
        );
        let inventory = read_harness_inventory(
            &fixture.home,
            fixture.session.to_str().unwrap(),
            &fixture.session_id,
            fixture.project.to_str().unwrap(),
        )
        .expect("real inventory");
        assert_eq!(inventory.entries.len(), 1);
        assert!(inventory.local_available);
        assert!(!inventory.global_available);
        assert_eq!(inventory.entries[0].id, "safe");
        let serialized = serde_json::to_string(&inventory).expect("public inventory");
        for forbidden in [
            "private/path",
            "secret",
            "metadata",
            "reference",
            "arguments",
            "agent_root",
        ] {
            assert!(!serialized.contains(forbidden), "leaked {forbidden}");
        }

        let mut many = BTreeMap::new();
        for index in 0..(MAX_INVENTORY_ENTRIES + 10) {
            let id = format!("memory-{index:04}");
            many.insert(id.clone(), memory(&id, "title", "content", "local"));
        }
        fixture.write_state(
            HarnessScope::Local,
            &state(complete_entries(serde_json::to_value(many).unwrap())),
        );
        let bounded = read_harness_inventory(
            &fixture.home,
            fixture.session.to_str().unwrap(),
            &fixture.session_id,
            fixture.project.to_str().unwrap(),
        )
        .expect("bounded inventory");
        assert_eq!(bounded.entries.len(), MAX_INVENTORY_ENTRIES);
        assert!(bounded.truncated);
    }

    #[test]
    fn inventory_distinguishes_absent_and_present_empty_stores() {
        let fixture = Fixture::new();
        fixture.write_state(HarnessScope::Global, &state(complete_entries(json!({}))));
        let inventory = read_harness_inventory(
            &fixture.home,
            fixture.session.to_str().unwrap(),
            &fixture.session_id,
            fixture.project.to_str().unwrap(),
        )
        .expect("empty global store");
        assert!(inventory.entries.is_empty());
        assert!(!inventory.local_available);
        assert!(inventory.global_available);
        assert!(!inventory.truncated);
    }

    #[test]
    fn rejects_traversal_ids_and_mismatched_embedded_identity() {
        assert!(validate_public_id("../escape", "id").is_err());
        assert!(validate_public_id("..\\escape", "id").is_err());
        let mut root = state(complete_entries(json!({
            "target": memory("another", "Wrong", "wrong id", "local")
        })));
        let error = remove_exact_entry(
            &mut root,
            HarnessScope::Local,
            HarnessKind::Memory,
            "target",
        )
        .expect_err("mismatched entry rejected");
        assert!(error.contains("exactement"));
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symbolic_harness_directory() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new();
        let target = fixture._temp.path().join("attacker");
        fs::create_dir_all(&target).expect("attacker target");
        let harness = fixture.harness_dir(HarnessScope::Local);
        fs::create_dir_all(harness.parent().unwrap()).expect("artifact parent");
        symlink(&target, &harness).expect("harness symlink");
        let error = validate_existing_managed_directory(&fixture.context(), &harness)
            .expect_err("symlink rejected");
        assert!(error.contains("symbolique"));
    }
}
