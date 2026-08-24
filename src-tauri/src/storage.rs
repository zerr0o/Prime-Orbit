use crate::paths::canonicalize;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::{
    ffi::OsString,
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager};

const MAX_APP_STATE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_MODELS_JSON_BYTES: u64 = 4 * 1024 * 1024;
static TEMP_FILE_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Serializes related persistence operations so backups and replacements cannot
/// interleave when multiple windows save at the same time.
#[derive(Clone, Default)]
pub struct PersistenceLock(pub Arc<Mutex<()>>);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelsJsonDocument {
    pub path: String,
    pub exists: bool,
    pub models: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveModelsResult {
    pub path: String,
    pub backup_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppStateSnapshot {
    pub state: Value,
    pub revision: u64,
}

/// Result of an optimistic app-state write. A rejected write always carries
/// the current durable snapshot so the caller can rebase its local changes and
/// retry without replacing changes committed by another window.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveAppStateResult {
    pub saved: bool,
    pub snapshot: AppStateSnapshot,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedAppState {
    format_version: u8,
    revision: u64,
    state: Value,
}

pub fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Impossible de localiser les données de Prime Orbit: {error}"))?;
    fs::create_dir_all(&directory).map_err(|error| {
        format!(
            "Impossible de créer le dossier de données {}: {error}",
            directory.display()
        )
    })?;
    canonicalize(&directory).map_err(|error| {
        format!(
            "Impossible de résoudre le dossier de données {}: {error}",
            directory.display()
        )
    })
}

pub fn runtime_config_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_dir(app)?.join("runtime-config.json"))
}

fn app_state_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_dir(app)?.join("app-state.json"))
}

fn managed_agent_directory(home: &Path, create: bool) -> Result<PathBuf, String> {
    let home = canonicalize(home).map_err(|error| {
        format!(
            "Impossible de résoudre le dossier utilisateur {}: {error}",
            home.display()
        )
    })?;
    let mut current = home.clone();

    for component in [".prime", "agent"] {
        let candidate = current.join(component);
        match fs::symlink_metadata(&candidate) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() || !metadata.is_dir() {
                    return Err(format!(
                        "{} doit être un dossier régulier non symbolique",
                        candidate.display()
                    ));
                }
                let resolved = canonicalize(&candidate).map_err(|error| {
                    format!("Impossible de résoudre {}: {error}", candidate.display())
                })?;
                if !resolved.starts_with(&home) {
                    return Err(format!(
                        "Le dossier models.json {} sort du dossier utilisateur autorisé",
                        resolved.display()
                    ));
                }
                current = resolved;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound && create => {
                match fs::create_dir(&candidate) {
                    Ok(()) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                    Err(error) => {
                        return Err(format!(
                            "Impossible de créer le dossier de configuration {}: {error}",
                            candidate.display()
                        ));
                    }
                }
                let metadata = fs::symlink_metadata(&candidate).map_err(|error| {
                    format!("Impossible d’inspecter {}: {error}", candidate.display())
                })?;
                if metadata.file_type().is_symlink() || !metadata.is_dir() {
                    return Err(format!(
                        "{} doit être un dossier régulier non symbolique",
                        candidate.display()
                    ));
                }
                current = canonicalize(&candidate).map_err(|error| {
                    format!("Impossible de résoudre {}: {error}", candidate.display())
                })?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                // Nothing below a missing regular component can be trusted or
                // canonicalized yet. Preserve the exact managed destination;
                // save_models_json will create and revalidate it before use.
                current = candidate;
            }
            Err(error) => {
                return Err(format!(
                    "Impossible d’inspecter {}: {error}",
                    candidate.display()
                ));
            }
        }
    }
    Ok(current)
}

fn resolve_models_path_from_home(
    home: &Path,
    requested: Option<&str>,
    create_parent: bool,
) -> Result<PathBuf, String> {
    let managed_directory = managed_agent_directory(home, create_parent)?;
    // Validate the directory entry itself before any canonicalization. If the
    // managed filename is a symlink, resolving it first would make an
    // attacker-controlled target look identical to the requested path.
    let managed_path = validate_managed_models_file(managed_directory.join("models.json"))?;

    let Some(requested) = requested else {
        return validate_managed_models_file(managed_path);
    };
    if requested.trim().is_empty() {
        return Err("Le chemin models.json ne peut pas être vide".to_string());
    }
    let requested_path = PathBuf::from(requested);
    if !requested_path.is_absolute() {
        return Err("Le chemin models.json choisi doit être absolu".to_string());
    }
    if requested_path.file_name().and_then(|value| value.to_str()) != Some("models.json") {
        return Err(
            "Prime Orbit ne peut modifier que le fichier ~/.prime/agent/models.json géré"
                .to_string(),
        );
    }
    validate_managed_models_file(requested_path.clone())?;

    let resolved_requested = if requested_path.exists() {
        canonicalize(&requested_path).map_err(|error| {
            format!(
                "Impossible de résoudre {}: {error}",
                requested_path.display()
            )
        })?
    } else {
        let parent = requested_path
            .parent()
            .ok_or_else(|| "Le chemin models.json n’a pas de dossier parent".to_string())?;
        let parent = canonicalize(parent).map_err(|error| {
            format!(
                "Le dossier parent {} est inaccessible: {error}",
                parent.display()
            )
        })?;
        parent.join("models.json")
    };
    let resolved_managed = if managed_path.exists() {
        canonicalize(&managed_path).map_err(|error| {
            format!("Impossible de résoudre {}: {error}", managed_path.display())
        })?
    } else {
        managed_path
    };
    if resolved_requested != resolved_managed {
        return Err(format!(
            "Prime Orbit refuse d’accéder à {} : seul {} est géré par cet éditeur",
            resolved_requested.display(),
            resolved_managed.display()
        ));
    }
    validate_managed_models_file(resolved_managed)
}

fn validate_managed_models_file(path: PathBuf) -> Result<PathBuf, String> {
    match fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => Err(format!(
            "Le chemin {} doit désigner un fichier régulier non symbolique",
            path.display()
        )),
        Ok(_) => Ok(path),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(path),
        Err(error) => Err(format!(
            "Impossible d’inspecter {}: {error}",
            path.display()
        )),
    }
}

fn resolve_models_path(
    app: &AppHandle,
    requested: Option<String>,
    create_parent: bool,
) -> Result<PathBuf, String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|error| format!("Impossible de localiser le dossier utilisateur: {error}"))?;
    resolve_models_path_from_home(&home, requested.as_deref(), create_parent)
}

pub fn read_json_file(path: &Path, max_bytes: u64) -> Result<Value, String> {
    let metadata = fs::metadata(path)
        .map_err(|error| format!("Impossible de lire {}: {error}", path.display()))?;
    if !metadata.is_file() {
        return Err(format!("{} n’est pas un fichier régulier", path.display()));
    }
    if metadata.len() > max_bytes {
        return Err(format!(
            "{} dépasse la limite autorisée de {} octets",
            path.display(),
            max_bytes
        ));
    }
    let mut file = fs::File::open(path)
        .map_err(|error| format!("Impossible d’ouvrir {}: {error}", path.display()))?;
    let mut contents = Vec::with_capacity(metadata.len() as usize);
    file.read_to_end(&mut contents)
        .map_err(|error| format!("Impossible de lire {}: {error}", path.display()))?;
    serde_json::from_slice(&contents)
        .map_err(|error| format!("JSON invalide dans {}: {error}", path.display()))
}

fn unique_temporary_path(target: &Path) -> Result<PathBuf, String> {
    let name = target
        .file_name()
        .ok_or_else(|| format!("Chemin de destination invalide: {}", target.display()))?;
    let suffix = format!(
        ".prime-orbit-tmp-{}-{}-{}",
        std::process::id(),
        now_millis(),
        TEMP_FILE_COUNTER.fetch_add(1, Ordering::Relaxed)
    );
    let mut temporary_name = OsString::from(name);
    temporary_name.push(suffix);
    Ok(target.with_file_name(temporary_name))
}

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AtomicCreateResult {
    Created,
    AlreadyExists,
}

/// Atomically publishes a new file without ever replacing an existing path.
/// The temporary inode is hard-linked into place, so a foreign collision that
/// appears after candidate selection fails closed instead of being overwritten.
pub fn write_atomic_new(path: &Path, bytes: &[u8]) -> Result<AtomicCreateResult, String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("Chemin de destination invalide: {}", path.display()))?;
    let parent_metadata = fs::symlink_metadata(parent).map_err(|error| {
        format!(
            "Le dossier de destination {} est inaccessible: {error}",
            parent.display()
        )
    })?;
    if !parent_metadata.is_dir() || parent_metadata.file_type().is_symlink() {
        return Err(format!(
            "Le dossier de destination {} n’est pas un dossier physique.",
            parent.display()
        ));
    }
    let temporary = unique_temporary_path(path)?;
    let result = (|| -> Result<AtomicCreateResult, String> {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| format!("Impossible de créer {}: {error}", temporary.display()))?;
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|error| format!("Impossible d’écrire {}: {error}", temporary.display()))?;
        drop(file);
        match fs::hard_link(&temporary, path) {
            Ok(()) => Ok(AtomicCreateResult::Created),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                Ok(AtomicCreateResult::AlreadyExists)
            }
            Err(error) => Err(format!(
                "Impossible de publier {} sans remplacement: {error}",
                path.display()
            )),
        }
    })();
    let _ = fs::remove_file(&temporary);
    result
}

pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("Chemin de destination invalide: {}", path.display()))?;
    let parent_metadata = fs::symlink_metadata(parent).map_err(|error| {
        format!(
            "Le dossier de destination {} est inaccessible: {error}",
            parent.display()
        )
    })?;
    if !parent_metadata.is_dir() || parent_metadata.file_type().is_symlink() {
        return Err(format!(
            "{} n’est pas un dossier physique",
            parent.display()
        ));
    }
    if path.exists() {
        let metadata = fs::symlink_metadata(path)
            .map_err(|error| format!("Impossible d’inspecter {}: {error}", path.display()))?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(format!(
                "La destination {} doit être un fichier régulier non symbolique",
                path.display()
            ));
        }
    }

    let temporary = unique_temporary_path(path)?;
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temporary).map_err(|error| {
        format!(
            "Impossible de créer le fichier temporaire {}: {error}",
            temporary.display()
        )
    })?;
    file.write_all(bytes).map_err(|error| {
        format!(
            "Impossible d’écrire le fichier temporaire {}: {error}",
            temporary.display()
        )
    })?;
    file.sync_all().map_err(|error| {
        format!(
            "Impossible de synchroniser le fichier temporaire {}: {error}",
            temporary.display()
        )
    })?;
    drop(file);

    replace_file(&temporary, path).map_err(|error| {
        format!(
            "Impossible de remplacer atomiquement {} (fichier temporaire conservé dans {}): {error}",
            path.display(),
            temporary.display()
        )
    })?;

    #[cfg(unix)]
    {
        if let Ok(directory) = fs::File::open(parent) {
            let _ = directory.sync_all();
        }
    }
    Ok(())
}

#[cfg(not(windows))]
fn replace_file(source: &Path, destination: &Path) -> std::io::Result<()> {
    fs::rename(source, destination)
}

#[cfg(windows)]
fn replace_file(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let source: Vec<u16> = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let result = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

fn serialize_pretty(value: &Value, max_bytes: u64, label: &str) -> Result<Vec<u8>, String> {
    let mut bytes = serde_json::to_vec_pretty(value)
        .map_err(|error| format!("Impossible de sérialiser {label}: {error}"))?;
    bytes.push(b'\n');
    if bytes.len() as u64 > max_bytes {
        return Err(format!(
            "{label} dépasse la limite autorisée de {max_bytes} octets"
        ));
    }
    Ok(bytes)
}

fn validate_models_json(value: &Value) -> Result<(), String> {
    let root = value
        .as_object()
        .ok_or_else(|| "models.json doit contenir un objet JSON à la racine".to_string())?;
    if root.keys().any(|key| key != "providers") {
        return Err("models.json ne peut contenir que la propriété racine providers".to_string());
    }
    let providers = root
        .get("providers")
        .and_then(Value::as_object)
        .ok_or_else(|| "models.json.providers est requis et doit être un objet".to_string())?;
    for (provider_id, provider) in providers {
        if provider_id.trim().is_empty() || provider_id.len() > 128 {
            return Err(
                "Un identifiant de provider doit contenir entre 1 et 128 caractères".to_string(),
            );
        }
        let provider = provider.as_object().ok_or_else(|| {
            format!("La configuration du provider {provider_id} doit être un objet")
        })?;
        for string_field in ["name", "baseUrl", "apiKey", "api"] {
            if let Some(field) = provider.get(string_field) {
                let text = field.as_str().ok_or_else(|| {
                    format!("providers.{provider_id}.{string_field} doit être une chaîne")
                })?;
                if text.is_empty() {
                    return Err(format!(
                        "providers.{provider_id}.{string_field} ne peut pas être vide"
                    ));
                }
            }
        }
        if let Some(auth_header) = provider.get("authHeader") {
            if !auth_header.is_boolean() {
                return Err(format!(
                    "providers.{provider_id}.authHeader doit être un booléen"
                ));
            }
        }
        if let Some(headers) = provider.get("headers") {
            validate_string_map(headers, &format!("providers.{provider_id}.headers"))?;
        }
        if let Some(compat) = provider.get("compat") {
            if !compat.is_object() {
                return Err(format!("providers.{provider_id}.compat doit être un objet"));
            }
        }
        if let Some(models) = provider.get("models") {
            let models = models
                .as_array()
                .ok_or_else(|| format!("providers.{provider_id}.models doit être un tableau"))?;
            for (index, model) in models.iter().enumerate() {
                validate_model_definition(provider_id, index, model)?;
            }
        }
        if let Some(overrides) = provider.get("modelOverrides") {
            let overrides = overrides.as_object().ok_or_else(|| {
                format!("providers.{provider_id}.modelOverrides doit être un objet")
            })?;
            for (model_id, value) in overrides {
                if model_id.trim().is_empty() {
                    return Err(format!(
                        "providers.{provider_id}.modelOverrides contient un identifiant vide"
                    ));
                }
                if !value.is_object() {
                    return Err(format!(
                        "providers.{provider_id}.modelOverrides.{model_id} doit être un objet"
                    ));
                }
            }
        }
    }
    Ok(())
}

fn validate_string_map(value: &Value, path: &str) -> Result<(), String> {
    let values = value
        .as_object()
        .ok_or_else(|| format!("{path} doit être un objet"))?;
    if values.values().any(|value| !value.is_string()) {
        return Err(format!(
            "Toutes les valeurs de {path} doivent être des chaînes"
        ));
    }
    Ok(())
}

fn validate_model_definition(provider_id: &str, index: usize, value: &Value) -> Result<(), String> {
    let path = format!("providers.{provider_id}.models[{index}]");
    let model = value
        .as_object()
        .ok_or_else(|| format!("{path} doit être un objet"))?;
    let id = model
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{path}.id doit être une chaîne"))?;
    if id.is_empty() {
        return Err(format!("{path}.id ne peut pas être vide"));
    }
    for string_field in ["name", "api", "baseUrl"] {
        if let Some(field) = model.get(string_field) {
            let text = field
                .as_str()
                .ok_or_else(|| format!("{path}.{string_field} doit être une chaîne"))?;
            if text.is_empty() {
                return Err(format!("{path}.{string_field} ne peut pas être vide"));
            }
        }
    }
    for boolean_field in ["reasoning"] {
        if model
            .get(boolean_field)
            .is_some_and(|value| !value.is_boolean())
        {
            return Err(format!("{path}.{boolean_field} doit être un booléen"));
        }
    }
    for number_field in ["contextWindow", "maxTokens"] {
        if model
            .get(number_field)
            .is_some_and(|value| !value.is_number())
        {
            return Err(format!("{path}.{number_field} doit être un nombre"));
        }
    }
    if let Some(input) = model.get("input") {
        let input = input
            .as_array()
            .ok_or_else(|| format!("{path}.input doit être un tableau"))?;
        if input
            .iter()
            .any(|kind| !matches!(kind.as_str(), Some("text" | "image")))
        {
            return Err(format!("{path}.input ne peut contenir que text et image"));
        }
    }
    if let Some(headers) = model.get("headers") {
        validate_string_map(headers, &format!("{path}.headers"))?;
    }
    if model.get("compat").is_some_and(|value| !value.is_object()) {
        return Err(format!("{path}.compat doit être un objet"));
    }
    Ok(())
}

fn decode_app_state(value: Value) -> Result<AppStateSnapshot, String> {
    if value.get("formatVersion").and_then(Value::as_u64).is_some()
        && value.get("revision").is_some()
        && value.get("state").is_some()
    {
        let persisted: PersistedAppState = serde_json::from_value(value)
            .map_err(|error| format!("Enveloppe d’état invalide: {error}"))?;
        if persisted.format_version != 1 {
            return Err(format!(
                "Version de format d’état non prise en charge: {}",
                persisted.format_version
            ));
        }
        if !persisted.state.is_object() {
            return Err("L’état persistant doit être un objet JSON".to_string());
        }
        return Ok(AppStateSnapshot {
            state: persisted.state,
            revision: persisted.revision,
        });
    }
    if !value.is_object() {
        return Err("L’état persistant doit être un objet JSON".to_string());
    }
    Ok(AppStateSnapshot {
        state: value,
        revision: 0,
    })
}

fn load_app_state_from_path(path: &Path) -> Result<AppStateSnapshot, String> {
    if !path.exists() {
        return Ok(AppStateSnapshot {
            state: Value::Object(Map::new()),
            revision: 0,
        });
    }
    decode_app_state(read_json_file(path, MAX_APP_STATE_BYTES)?)
}

#[tauri::command]
pub async fn load_app_state(app: AppHandle) -> Result<AppStateSnapshot, String> {
    crate::run_blocking(move || {
        let path = app_state_path(&app)?;
        load_app_state_from_path(&path)
    })
    .await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn save_app_state(
    app: AppHandle,
    state: Value,
    expected_revision: u64,
    persistence: tauri::State<'_, PersistenceLock>,
) -> Result<SaveAppStateResult, String> {
    let persistence = Arc::clone(&persistence.0);
    crate::run_blocking(move || {
        let _guard = persistence.lock();
        let path = app_state_path(&app)?;
        let result = compare_and_save_app_state(&path, state, expected_revision)?;
        drop(_guard);
        if result.saved && result.snapshot.revision > expected_revision {
            let _ = app.emit("prime-orbit://state-changed", result.snapshot.clone());
        }
        Ok(result)
    })
    .await
}

fn compare_and_save_app_state(
    path: &Path,
    state: Value,
    expected_revision: u64,
) -> Result<SaveAppStateResult, String> {
    if !state.is_object() {
        return Err("L’état persistant doit être un objet JSON".to_string());
    }
    let current = load_app_state_from_path(path)?;
    if current.revision != expected_revision {
        return Ok(SaveAppStateResult {
            saved: false,
            snapshot: current,
        });
    }
    // Treat an identical CAS payload as a successful no-op. The frontend
    // normally filters these writes, but this native guard prevents a render
    // or serialization regression from churning the state file and revision.
    if current.state == state {
        return Ok(SaveAppStateResult {
            saved: true,
            snapshot: current,
        });
    }
    let next_revision = current
        .revision
        .checked_add(1)
        .ok_or_else(|| "La révision de l’état a atteint sa valeur maximale".to_string())?;
    let persisted = PersistedAppState {
        format_version: 1,
        revision: next_revision,
        state: state.clone(),
    };
    let persisted_value = serde_json::to_value(persisted)
        .map_err(|error| format!("Impossible de sérialiser l’état: {error}"))?;
    let bytes = serialize_pretty(
        &persisted_value,
        MAX_APP_STATE_BYTES,
        "L’état de l’application",
    )?;
    write_atomic(path, &bytes)?;
    Ok(SaveAppStateResult {
        saved: true,
        snapshot: AppStateSnapshot {
            state,
            revision: next_revision,
        },
    })
}

#[tauri::command]
pub async fn read_models_json(
    app: AppHandle,
    path: Option<String>,
) -> Result<ModelsJsonDocument, String> {
    crate::run_blocking(move || {
        let path = resolve_models_path(&app, path, false)?;
        if !path.exists() {
            return Ok(ModelsJsonDocument {
                path: path.to_string_lossy().into_owned(),
                exists: false,
                models: serde_json::json!({ "providers": {} }),
            });
        }
        let models = read_json_file(&path, MAX_MODELS_JSON_BYTES)?;
        validate_models_json(&models)?;
        Ok(ModelsJsonDocument {
            path: path.to_string_lossy().into_owned(),
            exists: true,
            models,
        })
    })
    .await
}

#[tauri::command]
pub async fn save_models_json(
    app: AppHandle,
    path: Option<String>,
    models: Value,
    persistence: tauri::State<'_, PersistenceLock>,
) -> Result<SaveModelsResult, String> {
    let persistence = Arc::clone(&persistence.0);
    crate::run_blocking(move || {
        validate_models_json(&models)?;
        let bytes = serialize_pretty(&models, MAX_MODELS_JSON_BYTES, "models.json")?;
        let path = resolve_models_path(&app, path, true)?;
        let _guard = persistence.lock();

        let backup_path = if path.exists() {
            let previous = fs::read(&path).map_err(|error| {
                format!("Impossible de sauvegarder {}: {error}", path.display())
            })?;
            let name = path
                .file_name()
                .ok_or_else(|| "Nom models.json invalide".to_string())?;
            let mut backup_name = OsString::from(name);
            backup_name.push(".bak");
            let backup = path.with_file_name(backup_name);
            write_atomic(&backup, &previous)?;
            Some(backup)
        } else {
            None
        };

        write_atomic(&path, &bytes)?;
        Ok(SaveModelsResult {
            path: path.to_string_lossy().into_owned(),
            backup_path: backup_path.map(|value| value.to_string_lossy().into_owned()),
        })
    })
    .await
}

pub fn save_typed_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let json = serde_json::to_value(value)
        .map_err(|error| format!("Impossible de sérialiser {}: {error}", path.display()))?;
    let bytes = serialize_pretty(&json, 1024 * 1024, "La configuration du runtime")?;
    write_atomic(path, &bytes)
}

pub fn load_typed_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<Option<T>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let value = read_json_file(path, 1024 * 1024)?;
    serde_json::from_value(value)
        .map(Some)
        .map_err(|error| format!("Configuration invalide dans {}: {error}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::{
        compare_and_save_app_state, load_app_state_from_path, resolve_models_path_from_home,
        validate_models_json, write_atomic_new, AtomicCreateResult,
    };
    use std::fs;

    #[test]
    fn atomic_new_file_never_replaces_a_collision() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("plan.md");
        assert_eq!(
            write_atomic_new(&path, b"first").unwrap(),
            AtomicCreateResult::Created
        );
        assert_eq!(
            write_atomic_new(&path, b"second").unwrap(),
            AtomicCreateResult::AlreadyExists
        );
        assert_eq!(fs::read(path).unwrap(), b"first");
    }

    #[test]
    fn validates_provider_model_ids() {
        let valid = serde_json::json!({
            "providers": {
                "local": {
                    "baseUrl": "http://127.0.0.1:11434/v1",
                    "models": [{ "id": "local-model", "name": "Local" }]
                }
            }
        });
        assert!(validate_models_json(&valid).is_ok());

        let invalid = serde_json::json!({
            "providers": { "local": { "models": [{ "name": "Missing id" }] } }
        });
        assert!(validate_models_json(&invalid).is_err());

        assert!(validate_models_json(&serde_json::json!({})).is_err());
        assert!(validate_models_json(&serde_json::json!({ "unrelated": true })).is_err());
        assert!(validate_models_json(&serde_json::json!({
            "providers": { "local": { "headers": { "Authorization": 42 } } }
        }))
        .is_err());
    }

    #[test]
    fn models_editor_is_confined_to_the_managed_models_file() {
        let home = tempfile::tempdir().expect("temporary home");
        let managed = resolve_models_path_from_home(home.path(), None, true)
            .expect("managed path is created");
        let canonical_home =
            crate::paths::canonicalize(home.path()).expect("canonical temporary home");
        assert_eq!(
            managed,
            canonical_home
                .join(".prime")
                .join("agent")
                .join("models.json")
        );
        assert_eq!(
            resolve_models_path_from_home(home.path(), managed.to_str(), true)
                .expect("the exact managed path remains accepted"),
            managed
        );

        let unrelated = home.path().join("package.json");
        assert!(resolve_models_path_from_home(home.path(), unrelated.to_str(), true).is_err());
        let lookalike = home.path().join("elsewhere").join("models.json");
        fs::create_dir_all(lookalike.parent().unwrap()).unwrap();
        assert!(resolve_models_path_from_home(home.path(), lookalike.to_str(), true).is_err());
    }

    #[test]
    fn models_editor_rejects_a_symbolic_managed_file_before_resolution() {
        let home = tempfile::tempdir().expect("temporary home");
        let managed = home.path().join(".prime").join("agent").join("models.json");
        fs::create_dir_all(managed.parent().unwrap()).expect("create managed directory");
        let target = home.path().join("outside.json");
        fs::write(&target, br#"{"outside":true}"#).expect("write target");

        #[cfg(windows)]
        let linked = std::os::windows::fs::symlink_file(&target, &managed);
        #[cfg(unix)]
        let linked = std::os::unix::fs::symlink(&target, &managed);
        #[cfg(not(any(windows, unix)))]
        let linked: std::io::Result<()> = Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "symlink test unsupported",
        ));
        if linked.is_err() {
            // Some locked-down Windows environments disable symlink creation;
            // the production check remains platform-independent.
            return;
        }

        assert!(resolve_models_path_from_home(home.path(), None, false).is_err());
        assert!(resolve_models_path_from_home(home.path(), managed.to_str(), false).is_err());
        assert_eq!(
            fs::read_to_string(target).expect("target remains readable"),
            r#"{"outside":true}"#
        );
    }

    #[test]
    fn app_state_save_rejects_a_stale_revision_without_overwriting() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("app-state.json");
        let first_state = serde_json::json!({ "projects": [{ "id": "first" }] });
        let stale_state = serde_json::json!({ "projects": [{ "id": "stale" }] });

        let first =
            compare_and_save_app_state(&path, first_state.clone(), 0).expect("first save succeeds");
        assert!(first.saved);
        assert_eq!(first.snapshot.revision, 1);

        let stale = compare_and_save_app_state(&path, stale_state, 0)
            .expect("stale save returns a conflict snapshot");
        assert!(!stale.saved);
        assert_eq!(stale.snapshot.revision, 1);
        assert_eq!(stale.snapshot.state, first_state);

        let durable = load_app_state_from_path(&path).expect("state remains readable");
        assert_eq!(durable.revision, 1);
        assert_eq!(durable.state, first_state);
    }

    #[test]
    fn app_state_save_accepts_the_exact_current_revision() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("app-state.json");
        let first_state = serde_json::json!({ "projects": [{ "id": "first" }] });
        let second_state = serde_json::json!({ "projects": [{ "id": "second" }] });

        compare_and_save_app_state(&path, first_state, 0).expect("first save succeeds");
        let second = compare_and_save_app_state(&path, second_state.clone(), 1)
            .expect("second save succeeds");

        assert!(second.saved);
        assert_eq!(second.snapshot.revision, 2);
        assert_eq!(second.snapshot.state, second_state);
    }

    #[test]
    fn identical_app_state_save_is_an_idempotent_success() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("app-state.json");
        let state = serde_json::json!({ "projects": [{ "id": "same" }] });

        let first =
            compare_and_save_app_state(&path, state.clone(), 0).expect("first save succeeds");
        assert!(first.saved);
        assert_eq!(first.snapshot.revision, 1);

        let identical =
            compare_and_save_app_state(&path, state, 1).expect("identical save succeeds");
        assert!(identical.saved);
        assert_eq!(identical.snapshot.revision, 1);
        assert_eq!(load_app_state_from_path(&path).unwrap().revision, 1);
    }
}
