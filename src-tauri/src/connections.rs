use crate::{
    paths::canonicalize,
    session_lease::resolve_agent_dir,
    storage::{write_atomic, PersistenceLock},
};
use serde::{
    de::{IgnoredAny, MapAccess, Visitor},
    Deserialize, Serialize,
};
use serde_json::{Map, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    ffi::{OsStr, OsString},
    fmt,
    fs::{self, OpenOptions},
    io::{Read, Write},
    net::{IpAddr, SocketAddr, TcpStream, ToSocketAddrs},
    path::{Component, Path, PathBuf},
    str::FromStr,
    sync::{
        atomic::{AtomicU64, Ordering},
        OnceLock,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager};
use url::{Host, Url};

#[cfg(windows)]
use windows_sys::Win32::{
    Foundation::{CloseHandle, FILETIME, INVALID_HANDLE_VALUE, STILL_ACTIVE},
    Storage::FileSystem::{
        CreateFileW, GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
        FILE_FLAG_BACKUP_SEMANTICS, FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ,
        FILE_SHARE_WRITE, OPEN_EXISTING,
    },
    System::Threading::{
        GetExitCodeProcess, GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    },
};

const MAX_SETTINGS_BYTES: u64 = 8 * 1024 * 1024;
const MAX_AUTH_BYTES: u64 = 4 * 1024 * 1024;
const MAX_MODELS_BYTES: u64 = 4 * 1024 * 1024;
const SETTINGS_LOCK_STALE_AFTER: Duration = Duration::from_secs(30);
const OLLAMA_PROBE_TIMEOUT: Duration = Duration::from_millis(900);
const DEFAULT_OLLAMA_ENDPOINT: &str = "http://127.0.0.1:11434/v1";
static SETTINGS_LOCK_RECLAIM_COUNTER: AtomicU64 = AtomicU64::new(0);
static PROCESS_START_FALLBACK: OnceLock<String> = OnceLock::new();
const BUILTIN_SERVERS: [(&str, &str); 2] = [
    ("linear", "https://mcp.linear.app/mcp"),
    ("notion", "https://mcp.notion.com/mcp"),
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum McpScope {
    Global,
    Project,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum McpAuthKind {
    OAuth,
    BearerEnv,
    #[default]
    None,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicMcpServer {
    pub name: String,
    pub url: Option<String>,
    pub enabled: bool,
    pub scope: McpScope,
    pub auth_kind: McpAuthKind,
    pub has_custom_headers: bool,
    pub builtin: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrimeAgentConnections {
    pub provider_ids: Vec<String>,
    pub mcp_servers: Vec<PublicMcpServer>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PrimeAgentThinkingLevel {
    Off,
    Minimal,
    Low,
    Medium,
    High,
    Xhigh,
    Max,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrimeAgentDefaults {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_thinking_level: Option<PrimeAgentThinkingLevel>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SavePrimeAgentDefaultsInput {
    #[serde(deserialize_with = "deserialize_present_nullable")]
    pub default_provider: Option<String>,
    #[serde(deserialize_with = "deserialize_present_nullable")]
    pub default_model: Option<String>,
    #[serde(deserialize_with = "deserialize_present_nullable")]
    pub default_thinking_level: Option<PrimeAgentThinkingLevel>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavePrimeAgentDefaultsResult {
    pub path: String,
    pub backup_path: Option<String>,
    pub defaults: PrimeAgentDefaults,
}

fn deserialize_present_nullable<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
}

/// A bounded, secret-free reachability snapshot for the Ollama endpoint used
/// by Prime Agent. Configuration and catalog presence are deliberately not
/// treated as proof that the local server is actually running.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OllamaHealth {
    pub reachable: bool,
    /// False for HTTPS endpoints where a TCP connection succeeds but this
    /// lightweight probe cannot authenticate the service as Ollama.
    pub verified: bool,
    pub endpoint: String,
    pub latency_ms: u64,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveMcpServerInput {
    pub name: String,
    pub url: String,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    #[serde(default)]
    pub auth_kind: McpAuthKind,
    #[serde(default)]
    pub bearer_token_env_var: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveMcpServerResult {
    pub path: String,
    pub backup_path: Option<String>,
    pub server: PublicMcpServer,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteMcpServerResult {
    pub path: String,
    pub backup_path: Option<String>,
    pub deleted: bool,
}

fn default_enabled() -> bool {
    true
}

fn is_builtin(name: &str) -> bool {
    BUILTIN_SERVERS
        .iter()
        .any(|(builtin_name, _)| *builtin_name == name)
}

fn validate_executable_mcp_scope(scope: McpScope) -> Result<(), String> {
    if scope == McpScope::Global {
        return Ok(());
    }
    Err(
        "Prime Agent 0.8 charge les serveurs MCP personnalisés uniquement depuis les réglages globaux. Recréez ce serveur avec la portée Tous les projets."
            .to_string(),
    )
}

fn validate_server_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name.len() > 64 {
        return Err("Le nom du serveur MCP doit contenir entre 1 et 64 caractères".to_string());
    }
    let mut bytes = name.bytes();
    if !matches!(bytes.next(), Some(b'a'..=b'z'))
        || !bytes.all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
    {
        return Err(
            "Le nom du serveur MCP doit être un identifiant Python en minuscules (a-z, 0-9 et _, commençant par une lettre)"
                .to_string(),
        );
    }
    Ok(())
}

fn reject_builtin_mutation(name: &str) -> Result<(), String> {
    if is_builtin(name) {
        return Err(format!(
            "{name} est une intégration native protégée. Utilisez le flux de connexion Prime Agent au lieu de créer, modifier ou supprimer une entrée mcpServers.{name}"
        ));
    }
    Ok(())
}

fn validate_env_var_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name.len() > 128 {
        return Err(
            "Le nom de variable d’environnement doit contenir entre 1 et 128 caractères"
                .to_string(),
        );
    }
    let mut bytes = name.bytes();
    if !matches!(bytes.next(), Some(b'A'..=b'Z' | b'a'..=b'z' | b'_'))
        || !bytes.all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
    {
        return Err(
            "Le nom de variable d’environnement bearer est invalide (lettres, chiffres et _, sans valeur de token)"
                .to_string(),
        );
    }
    Ok(())
}

fn validate_http_url(value: &str) -> Result<Url, String> {
    if value.trim() != value || value.is_empty() {
        return Err("L’URL MCP ne peut pas être vide ni contenir d’espaces en bordure".to_string());
    }
    let parsed = Url::parse(value).map_err(|error| format!("URL MCP invalide: {error}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("L’URL MCP doit utiliser http:// ou https://".to_string());
    }
    if parsed.host_str().is_none() {
        return Err("L’URL MCP doit contenir un nom d’hôte".to_string());
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(
            "Les identifiants sont interdits dans l’URL MCP; utilisez OAuth ou une variable d’environnement bearer"
                .to_string(),
        );
    }
    if parsed.fragment().is_some() {
        return Err("L’URL MCP ne doit pas contenir de fragment (#…)".to_string());
    }
    if parsed.query().is_some() {
        return Err(
            "L’URL MCP ne doit pas contenir de paramètres de requête; placez les secrets dans OAuth ou une variable d’environnement bearer"
                .to_string(),
        );
    }
    Ok(parsed)
}

fn is_loopback_url(url: &Url) -> bool {
    match url.host() {
        Some(Host::Ipv4(address)) => address.is_loopback(),
        Some(Host::Ipv6(address)) => address.is_loopback(),
        Some(Host::Domain(domain)) => domain.eq_ignore_ascii_case("localhost"),
        None => false,
    }
}

/// Existing settings may predate Prime Orbit's validation. Keep the endpoint
/// visible while stripping URL locations commonly abused for credentials.
fn safe_public_http_url(value: &str, name: &str) -> Result<String, String> {
    let mut parsed = Url::parse(value)
        .map_err(|error| format!("mcpServers.{name}.url est invalide: {error}"))?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err(format!(
            "mcpServers.{name}.url doit être une URL http(s) avec un hôte"
        ));
    }
    if !parsed.username().is_empty() {
        parsed.set_username("").map_err(|_| {
            format!("Impossible de masquer les identifiants de mcpServers.{name}.url")
        })?;
    }
    if parsed.password().is_some() {
        parsed.set_password(None).map_err(|_| {
            format!("Impossible de masquer le mot de passe de mcpServers.{name}.url")
        })?;
    }
    parsed.set_query(None);
    parsed.set_fragment(None);
    Ok(parsed.into())
}

fn validate_save_input(input: &SaveMcpServerInput) -> Result<(), String> {
    validate_server_name(&input.name)?;
    reject_builtin_mutation(&input.name)?;
    let url = validate_http_url(&input.url)?;
    if url.scheme() == "http" {
        if !is_loopback_url(&url) {
            return Err(
                "Une URL MCP en HTTP clair n’est autorisée que vers localhost ou une adresse IP loopback"
                    .to_string(),
            );
        }
        if input.auth_kind != McpAuthKind::None {
            return Err(
                "OAuth et bearer sont interdits sur HTTP, même en loopback; utilisez HTTPS ou aucune authentification"
                    .to_string(),
            );
        }
    }
    match input.auth_kind {
        McpAuthKind::BearerEnv => {
            let env_name = input.bearer_token_env_var.as_deref().ok_or_else(|| {
                "bearerTokenEnvVar est requis lorsque authKind vaut bearer-env".to_string()
            })?;
            validate_env_var_name(env_name)?;
        }
        McpAuthKind::OAuth | McpAuthKind::None => {
            if input.bearer_token_env_var.is_some() {
                return Err(
                    "bearerTokenEnvVar n’est accepté que lorsque authKind vaut bearer-env"
                        .to_string(),
                );
            }
        }
    }
    Ok(())
}

fn validate_default_provider(provider: &str) -> Result<(), String> {
    if provider.is_empty() || provider.len() > 128 || provider.trim() != provider {
        return Err(
            "defaultProvider doit contenir entre 1 et 128 caractères sans espace en bordure"
                .to_string(),
        );
    }
    let mut bytes = provider.bytes();
    if !matches!(bytes.next(), Some(byte) if byte.is_ascii_alphanumeric())
        || !bytes.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err(
            "defaultProvider doit être un identifiant de fournisseur exact (lettres ASCII, chiffres, -, _ et .)"
                .to_string(),
        );
    }
    Ok(())
}

fn validate_default_model(model: &str) -> Result<(), String> {
    if model.is_empty() || model.len() > 512 || model.trim() != model {
        return Err(
            "defaultModel doit contenir entre 1 et 512 octets sans espace en bordure".to_string(),
        );
    }
    if model.starts_with('/')
        || model.ends_with('/')
        || model.contains("//")
        || model.contains('\\')
        || model
            .chars()
            .any(|character| character.is_control() || character.is_whitespace())
    {
        return Err(
            "defaultModel doit être un identifiant de modèle exact sans espace, antislash ni segment vide"
                .to_string(),
        );
    }
    Ok(())
}

fn validate_prime_agent_defaults_input(input: &SavePrimeAgentDefaultsInput) -> Result<(), String> {
    match (&input.default_provider, &input.default_model) {
        (Some(provider), Some(model)) => {
            validate_default_provider(provider)?;
            validate_default_model(model)?;
        }
        (None, None) => {}
        _ => {
            return Err(
                "defaultProvider et defaultModel doivent être définis ou retirés ensemble"
                    .to_string(),
            );
        }
    }
    Ok(())
}

fn existing_directory(path: &Path, label: &str) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err(format!("Le chemin {label} doit être absolu"));
    }
    let metadata = fs::metadata(path).map_err(|error| {
        format!(
            "Le dossier {label} {} est inaccessible: {error}",
            path.display()
        )
    })?;
    if !metadata.is_dir() {
        return Err(format!(
            "Le chemin {label} {} n’est pas un dossier",
            path.display()
        ));
    }
    canonicalize(path).map_err(|error| {
        format!(
            "Impossible de résoudre le dossier {label} {}: {error}",
            path.display()
        )
    })
}

fn home_directory(app: &AppHandle) -> Result<PathBuf, String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|error| format!("Impossible de localiser le dossier utilisateur: {error}"))?;
    existing_directory(&home, "utilisateur")
}

fn project_directory(cwd: Option<String>) -> Result<PathBuf, String> {
    let cwd = cwd.ok_or_else(|| "cwd est requis pour la portée project".to_string())?;
    if cwd.trim().is_empty() {
        return Err("cwd ne peut pas être vide".to_string());
    }
    existing_directory(Path::new(&cwd), "du projet")
}

fn resolve_global_agent_directory(
    home: &Path,
    cwd: &Path,
    prime_override: Option<&OsStr>,
    legacy_override: Option<&OsStr>,
) -> (PathBuf, bool) {
    let configured = prime_override
        .filter(|value| !value.is_empty())
        .or_else(|| legacy_override.filter(|value| !value.is_empty()));
    (
        resolve_agent_dir(home, cwd, configured),
        configured.is_some(),
    )
}

fn validate_override_agent_directory(path: &Path, create: bool) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err(format!(
            "Le dossier global Prime Agent résolu doit être absolu ({})",
            path.display()
        ));
    }
    if create {
        fs::create_dir_all(path).map_err(|error| {
            format!(
                "Impossible de créer le dossier global Prime Agent {}: {error}",
                path.display()
            )
        })?;
    }
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound && !create => {
            return Ok(path.to_path_buf());
        }
        Err(error) => {
            return Err(format!(
                "Impossible d’inspecter le dossier global Prime Agent {}: {error}",
                path.display()
            ));
        }
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(format!(
            "Le dossier global Prime Agent {} doit être un dossier régulier non symbolique",
            path.display()
        ));
    }
    canonicalize(path).map_err(|error| {
        format!(
            "Impossible de résoudre le dossier global Prime Agent {}: {error}",
            path.display()
        )
    })
}

fn global_agent_directory(app: &AppHandle, create: bool) -> Result<PathBuf, String> {
    let home = home_directory(app)?;
    let cwd = std::env::current_dir()
        .map_err(|error| format!("Impossible de localiser le dossier courant: {error}"))?;
    let prime_override = std::env::var_os("PRIME_AGENT_CODING_AGENT_DIR");
    let legacy_override = std::env::var_os("PI_CODING_AGENT_DIR");
    let (directory, overridden) = resolve_global_agent_directory(
        &home,
        &cwd,
        prime_override.as_deref(),
        legacy_override.as_deref(),
    );
    if overridden {
        validate_override_agent_directory(&directory, create)
    } else {
        agent_config_directory(&home, create)
    }
}

fn global_agent_file_path(
    app: &AppHandle,
    create: bool,
    file_name: &'static str,
) -> Result<PathBuf, String> {
    let mut components = Path::new(file_name).components();
    if !matches!(components.next(), Some(Component::Normal(_))) || components.next().is_some() {
        return Err("Nom de fichier global Prime Agent invalide".to_string());
    }
    let directory = global_agent_directory(app, create)?;
    let path = directory.join(file_name);
    if path.parent() != Some(directory.as_path()) {
        return Err(format!(
            "Le fichier global Prime Agent sort du dossier autorisé {}",
            directory.display()
        ));
    }
    Ok(path)
}

fn agent_config_directory(root: &Path, create: bool) -> Result<PathBuf, String> {
    let root = existing_directory(root, "racine")?;
    let mut current = root.clone();
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
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                current = candidate;
                continue;
            }
            Err(error) => {
                return Err(format!(
                    "Impossible d’inspecter {}: {error}",
                    candidate.display()
                ));
            }
        }

        let resolved = canonicalize(&candidate)
            .map_err(|error| format!("Impossible de résoudre {}: {error}", candidate.display()))?;
        if !resolved.starts_with(&root) {
            return Err(format!(
                "Le dossier de configuration {} sort de la racine autorisée {}",
                resolved.display(),
                root.display()
            ));
        }
        current = resolved;
    }
    Ok(current)
}

fn settings_path(
    app: &AppHandle,
    cwd: Option<String>,
    scope: McpScope,
    create: bool,
) -> Result<PathBuf, String> {
    match scope {
        McpScope::Global => global_agent_file_path(app, create, "settings.json"),
        McpScope::Project => {
            Ok(agent_config_directory(&project_directory(cwd)?, create)?.join("settings.json"))
        }
    }
}

fn auth_path(app: &AppHandle) -> Result<PathBuf, String> {
    global_agent_file_path(app, false, "auth.json")
}

fn read_regular_file_limited(path: &Path, limit: u64) -> Result<Option<Vec<u8>>, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(format!(
                "Impossible d’inspecter {}: {error}",
                path.display()
            ))
        }
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(format!(
            "{} doit être un fichier régulier non symbolique",
            path.display()
        ));
    }
    if metadata.len() > limit {
        return Err(format!(
            "{} dépasse la limite autorisée de {limit} octets",
            path.display()
        ));
    }

    let file = fs::File::open(path)
        .map_err(|error| format!("Impossible d’ouvrir {}: {error}", path.display()))?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Impossible de lire {}: {error}", path.display()))?;
    if bytes.len() as u64 > limit {
        return Err(format!(
            "{} dépasse la limite autorisée de {limit} octets",
            path.display()
        ));
    }
    Ok(Some(bytes))
}

fn configured_ollama_endpoint(document: &Value) -> Result<String, String> {
    let configured = document
        .get("providers")
        .and_then(Value::as_object)
        .and_then(|providers| providers.get("ollama"))
        .and_then(Value::as_object)
        .and_then(|provider| provider.get("baseUrl"))
        .and_then(Value::as_str)
        .unwrap_or(DEFAULT_OLLAMA_ENDPOINT);
    let mut endpoint = Url::parse(configured)
        .map_err(|error| format!("L’endpoint Ollama est invalide: {error}"))?;
    if !matches!(endpoint.scheme(), "http" | "https")
        || endpoint.host().is_none()
        || !endpoint.username().is_empty()
        || endpoint.password().is_some()
    {
        return Err(
            "L’endpoint Ollama doit être une URL HTTP(S) sans identifiants intégrés".to_string(),
        );
    }
    // Query strings and fragments are never required for an Ollama health
    // probe and may contain secrets. Do not return them to the renderer.
    endpoint.set_query(None);
    endpoint.set_fragment(None);
    Ok(endpoint.to_string().trim_end_matches('/').to_string())
}

fn load_ollama_endpoint(app: &AppHandle) -> Result<String, String> {
    let path = agent_config_directory(&home_directory(app)?, false)?.join("models.json");
    let Some(bytes) = read_regular_file_limited(&path, MAX_MODELS_BYTES)? else {
        return Ok(DEFAULT_OLLAMA_ENDPOINT.to_string());
    };
    let document: Value = serde_json::from_slice(&bytes)
        .map_err(|error| format!("Le catalogue de modèles est invalide: {error}"))?;
    configured_ollama_endpoint(&document)
}

fn ollama_socket_addresses(endpoint: &Url) -> Result<Vec<SocketAddr>, String> {
    let port = endpoint
        .port_or_known_default()
        .ok_or_else(|| "L’endpoint Ollama ne précise aucun port utilisable".to_string())?;
    let addresses = match endpoint
        .host()
        .ok_or_else(|| "L’endpoint Ollama ne précise aucun hôte".to_string())?
    {
        Host::Ipv4(address) => vec![SocketAddr::new(IpAddr::V4(address), port)],
        Host::Ipv6(address) => vec![SocketAddr::new(IpAddr::V6(address), port)],
        Host::Domain(domain) if domain.eq_ignore_ascii_case("localhost") => vec![
            SocketAddr::new(IpAddr::from_str("127.0.0.1").expect("valid loopback"), port),
            SocketAddr::new(IpAddr::from_str("::1").expect("valid loopback"), port),
        ],
        // `std::net` does not expose a deadline-aware DNS resolver. Keep this
        // synchronous lookup off the UI thread (the command runs through
        // `run_blocking`); the default and `localhost` endpoints above avoid
        // DNS entirely, while connect/read/write operations remain governed by
        // the probe's absolute deadline. Supporting a hard DNS deadline would
        // require an asynchronous resolver rather than another blocking task.
        Host::Domain(domain) => (domain, port)
            .to_socket_addrs()
            .map_err(|error| format!("Impossible de résoudre l’hôte Ollama: {error}"))?
            .collect(),
    };
    if addresses.is_empty() {
        return Err("L’hôte Ollama n’a renvoyé aucune adresse".to_string());
    }
    Ok(addresses)
}

fn failed_ollama_health(endpoint: &str, started: Instant, error: String) -> OllamaHealth {
    OllamaHealth {
        reachable: false,
        verified: true,
        endpoint: endpoint.to_string(),
        latency_ms: started.elapsed().as_millis().min(u64::MAX as u128) as u64,
        error: Some(error),
    }
}

/// Prime Agent stores Ollama's OpenAI-compatible base URL (normally `/v1`),
/// while Ollama exposes its native health/catalog endpoint at `/api/tags`.
/// Preserve an optional reverse-proxy prefix but never append `/api/tags` to
/// `/v1` (which would produce the invalid `/v1/api/tags` route).
fn ollama_native_tags_path(endpoint: &Url) -> String {
    let configured_path = endpoint.path().trim_end_matches('/');
    if configured_path.is_empty() || configured_path == "/" || configured_path == "/v1" {
        return "/api/tags".to_string();
    }
    if configured_path.ends_with("/api/tags") {
        return configured_path.to_string();
    }
    if configured_path.ends_with("/api") {
        return format!("{configured_path}/tags");
    }
    if let Some(prefix) = configured_path.strip_suffix("/v1") {
        return format!("{prefix}/api/tags");
    }
    "/api/tags".to_string()
}

fn header_uses_chunked_encoding(headers: &str) -> bool {
    headers.lines().skip(1).any(|line| {
        line.split_once(':').is_some_and(|(name, value)| {
            name.trim().eq_ignore_ascii_case("transfer-encoding")
                && value
                    .split(',')
                    .any(|encoding| encoding.trim().eq_ignore_ascii_case("chunked"))
        })
    })
}

/// Decodes as much of a chunked response body as has been received. The
/// health probe deliberately caps its read buffer, so the final chunk may be
/// incomplete when a user has a very large local model catalog. The opening
/// JSON object still contains the discriminator (`models`) needed here.
fn decode_chunked_body_prefix(body: &[u8]) -> Vec<u8> {
    let mut decoded = Vec::with_capacity(body.len());
    let mut cursor = 0usize;
    while cursor < body.len() {
        let Some(line_end) = body[cursor..]
            .windows(2)
            .position(|window| window == b"\r\n")
            .map(|offset| cursor + offset)
        else {
            break;
        };
        let size = std::str::from_utf8(&body[cursor..line_end])
            .ok()
            .and_then(|line| line.split(';').next())
            .map(str::trim)
            .and_then(|size| usize::from_str_radix(size, 16).ok());
        let Some(size) = size else {
            break;
        };
        if size == 0 {
            break;
        }
        let chunk_start = line_end + 2;
        let available = body.len().saturating_sub(chunk_start).min(size);
        decoded.extend_from_slice(&body[chunk_start..chunk_start + available]);
        if available < size {
            break;
        }
        cursor = chunk_start + size;
        if body.get(cursor..cursor + 2) == Some(b"\r\n") {
            cursor += 2;
        } else {
            break;
        }
    }
    decoded
}

fn probe_ollama_endpoint(endpoint: &str, timeout: Duration) -> OllamaHealth {
    let started = Instant::now();
    let parsed = match Url::parse(endpoint) {
        Ok(parsed) => parsed,
        Err(error) => {
            return failed_ollama_health(
                endpoint,
                started,
                format!("L’endpoint Ollama est invalide: {error}"),
            )
        }
    };
    let addresses = match ollama_socket_addresses(&parsed) {
        Ok(addresses) => addresses,
        Err(error) => return failed_ollama_health(endpoint, started, error),
    };
    let mut last_error = "Le serveur Ollama n’accepte pas les connexions".to_string();
    let mut connected = None;
    for address in addresses {
        let remaining = timeout.saturating_sub(started.elapsed());
        if remaining.is_zero() {
            last_error = "La vérification d’Ollama a expiré".to_string();
            break;
        }
        match TcpStream::connect_timeout(&address, remaining) {
            Ok(stream) => {
                connected = Some(stream);
                break;
            }
            Err(error) => last_error = format!("Ollama est injoignable: {error}"),
        }
    }
    let Some(mut stream) = connected else {
        return failed_ollama_health(endpoint, started, last_error);
    };

    // A successful TLS handshake would require a full HTTP client. A bounded
    // TCP connection still proves that a configured remote HTTPS endpoint is
    // accepting connections; the standard local Ollama endpoint is verified
    // below with an actual HTTP request.
    if parsed.scheme() == "https" {
        return OllamaHealth {
            reachable: true,
            verified: false,
            endpoint: endpoint.to_string(),
            latency_ms: started.elapsed().as_millis().min(u64::MAX as u128) as u64,
            error: None,
        };
    }

    let remaining = timeout.saturating_sub(started.elapsed());
    if remaining.is_zero() {
        return failed_ollama_health(
            endpoint,
            started,
            "La vérification HTTP d’Ollama a expiré".to_string(),
        );
    }
    let _ = stream.set_write_timeout(Some(remaining));
    let host = parsed.host_str().unwrap_or("localhost");
    let host_header = match parsed.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_string(),
    };
    let probe_path = ollama_native_tags_path(&parsed);
    let request = format!(
        "GET {probe_path} HTTP/1.1\r\nHost: {host_header}\r\nAccept: application/json\r\nConnection: close\r\n\r\n"
    );
    if let Err(error) = stream.write_all(request.as_bytes()) {
        return failed_ollama_health(
            endpoint,
            started,
            format!("Ollama n’a pas accepté la requête de vérification: {error}"),
        );
    }
    let mut response = [0u8; 8192];
    let mut count = 0usize;
    loop {
        // Socket read timeouts apply to each individual read, not to the
        // complete response. Recompute the remaining wall-clock budget before
        // every read so a server cannot keep the probe alive indefinitely by
        // dripping one byte just before each per-call timeout.
        let remaining = timeout.saturating_sub(started.elapsed());
        if remaining.is_zero() {
            break;
        }
        if let Err(error) = stream.set_read_timeout(Some(remaining)) {
            return failed_ollama_health(
                endpoint,
                started,
                format!("Impossible de borner la lecture de la réponse Ollama: {error}"),
            );
        }
        match stream.read(&mut response[count..]) {
            Ok(0) => break,
            Ok(read) => {
                count += read;
                if count == response.len() {
                    break;
                }
            }
            Err(error)
                if count > 0
                    && matches!(
                        error.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                    ) =>
            {
                break
            }
            Err(error) => {
                return failed_ollama_health(
                    endpoint,
                    started,
                    format!("Ollama n’a pas répondu dans le délai imparti: {error}"),
                )
            }
        }
    }
    let response = &response[..count];
    let header_end = response.windows(4).position(|window| window == b"\r\n\r\n");
    let (headers, raw_body) = header_end.map_or((response, &[][..]), |header_end| {
        (&response[..header_end], &response[header_end + 4..])
    });
    let headers = String::from_utf8_lossy(headers);
    let decoded_body =
        header_uses_chunked_encoding(&headers).then(|| decode_chunked_body_prefix(raw_body));
    let body = String::from_utf8_lossy(decoded_body.as_deref().unwrap_or(raw_body));
    let status = headers
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse::<u16>().ok());
    let ollama_payload = body.trim_start().starts_with('{') && body.contains("\"models\"");
    if status.is_some_and(|code| (200..300).contains(&code)) && ollama_payload {
        OllamaHealth {
            reachable: true,
            verified: true,
            endpoint: endpoint.to_string(),
            latency_ms: started.elapsed().as_millis().min(u64::MAX as u128) as u64,
            error: None,
        }
    } else {
        failed_ollama_health(
            endpoint,
            started,
            match status {
                Some(code) => format!(
                    "Le service joint a répondu HTTP {code}, sans réponse {probe_path} valide d’Ollama"
                ),
                None => "Le service joint n’a pas renvoyé de réponse HTTP Ollama".to_string(),
            },
        )
    }
}

struct AuthKeyVisitor;

impl<'de> Visitor<'de> for AuthKeyVisitor {
    type Value = Vec<String>;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("un objet JSON auth.json à la racine")
    }

    fn visit_map<M>(self, mut access: M) -> Result<Self::Value, M::Error>
    where
        M: MapAccess<'de>,
    {
        let mut keys = Vec::with_capacity(access.size_hint().unwrap_or_default());
        while let Some(key) = access.next_key::<String>()? {
            access.next_value::<IgnoredAny>()?;
            keys.push(key);
        }
        Ok(keys)
    }
}

fn parse_auth_keys(bytes: &[u8]) -> Result<Vec<String>, serde_json::Error> {
    let mut deserializer = serde_json::Deserializer::from_slice(bytes);
    let mut keys = serde::de::Deserializer::deserialize_map(&mut deserializer, AuthKeyVisitor)?;
    deserializer.end()?;
    keys.sort();
    keys.dedup();
    Ok(keys)
}

fn load_auth_keys(path: &Path) -> Result<Vec<String>, String> {
    let Some(bytes) = read_regular_file_limited(path, MAX_AUTH_BYTES)? else {
        return Ok(Vec::new());
    };
    parse_auth_keys(&bytes)
        .map_err(|error| format!("auth.json est invalide dans {}: {error}", path.display()))
}

struct SettingsDocument {
    value: Value,
    raw: Option<Vec<u8>>,
}

fn validate_settings_root(value: &Value, path: &Path) -> Result<(), String> {
    let root = value.as_object().ok_or_else(|| {
        format!(
            "settings.json doit contenir un objet JSON à la racine ({})",
            path.display()
        )
    })?;
    if let Some(servers) = root.get("mcpServers") {
        if !servers.is_object() {
            return Err(format!(
                "mcpServers doit être un objet dans {}",
                path.display()
            ));
        }
    }
    Ok(())
}

fn load_settings(path: &Path) -> Result<SettingsDocument, String> {
    let Some(raw) = read_regular_file_limited(path, MAX_SETTINGS_BYTES)? else {
        return Ok(SettingsDocument {
            value: Value::Object(Map::new()),
            raw: None,
        });
    };
    let value: Value = serde_json::from_slice(&raw)
        .map_err(|error| format!("settings.json invalide dans {}: {error}", path.display()))?;
    validate_settings_root(&value, path)?;
    Ok(SettingsDocument {
        value,
        raw: Some(raw),
    })
}

fn optional_settings_string(
    root: &Map<String, Value>,
    key: &str,
) -> Result<Option<String>, String> {
    match root.get(key) {
        Some(Value::String(value)) => Ok(Some(value.clone())),
        Some(_) => Err(format!("{key} doit être une chaîne dans settings.json")),
        None => Ok(None),
    }
}

fn inspect_prime_agent_defaults_document(value: &Value) -> Result<PrimeAgentDefaults, String> {
    let root = value
        .as_object()
        .ok_or_else(|| "settings.json doit contenir un objet JSON à la racine".to_string())?;
    let default_provider = optional_settings_string(root, "defaultProvider")?;
    let default_model = optional_settings_string(root, "defaultModel")?;
    if let Some(provider) = default_provider.as_deref() {
        validate_default_provider(provider)?;
    }
    if let Some(model) = default_model.as_deref() {
        validate_default_model(model)?;
    }
    let default_thinking_level = match root.get("defaultThinkingLevel") {
        Some(value) => Some(serde_json::from_value(value.clone()).map_err(|_| {
            "defaultThinkingLevel doit valoir off, minimal, low, medium, high, xhigh ou max"
                .to_string()
        })?),
        None => None,
    };
    Ok(PrimeAgentDefaults {
        default_provider,
        default_model,
        default_thinking_level,
    })
}

fn apply_prime_agent_defaults(
    value: &mut Value,
    input: &SavePrimeAgentDefaultsInput,
) -> Result<PrimeAgentDefaults, String> {
    validate_prime_agent_defaults_input(input)?;
    let root = value
        .as_object_mut()
        .ok_or_else(|| "settings.json doit contenir un objet JSON à la racine".to_string())?;

    match (&input.default_provider, &input.default_model) {
        (Some(provider), Some(model)) => {
            root.insert(
                "defaultProvider".to_string(),
                Value::String(provider.clone()),
            );
            root.insert("defaultModel".to_string(), Value::String(model.clone()));
        }
        (None, None) => {
            root.remove("defaultProvider");
            root.remove("defaultModel");
        }
        _ => unreachable!("provider/model pair validated before mutation"),
    }

    match input.default_thinking_level {
        Some(level) => {
            root.insert(
                "defaultThinkingLevel".to_string(),
                serde_json::to_value(level)
                    .map_err(|error| format!("Impossible de sérialiser le niveau: {error}"))?,
            );
        }
        None => {
            root.remove("defaultThinkingLevel");
        }
    }

    inspect_prime_agent_defaults_document(value)
}

fn server_enabled(config: &Map<String, Value>, name: &str) -> Result<bool, String> {
    match config.get("enabled") {
        Some(Value::Bool(enabled)) => Ok(*enabled),
        Some(_) => Err(format!("mcpServers.{name}.enabled doit être un booléen")),
        None => Ok(true),
    }
}

fn auth_kind(config: &Map<String, Value>, name: &str) -> Result<McpAuthKind, String> {
    let bearer = match config.get("bearerTokenEnvVar") {
        Some(Value::String(_)) => true,
        Some(_) => {
            return Err(format!(
                "mcpServers.{name}.bearerTokenEnvVar doit être une chaîne"
            ));
        }
        None => false,
    };
    let oauth = match config.get("oauth") {
        Some(Value::Bool(value)) => *value,
        Some(_) => return Err(format!("mcpServers.{name}.oauth doit être un booléen")),
        None => false,
    };
    Ok(if bearer {
        McpAuthKind::BearerEnv
    } else if oauth {
        McpAuthKind::OAuth
    } else {
        McpAuthKind::None
    })
}

fn same_http_origin(left: &str, right: &str, name: &str) -> Result<bool, String> {
    let parse = |value: &str| {
        Url::parse(value).map_err(|error| format!("URL invalide pour mcpServers.{name}: {error}"))
    };
    let left = parse(left)?;
    let right = parse(right)?;
    Ok(left.scheme() == right.scheme()
        && left.host_str().map(str::to_ascii_lowercase)
            == right.host_str().map(str::to_ascii_lowercase)
        && left.port_or_known_default() == right.port_or_known_default())
}

fn validate_custom_headers_update(
    name: &str,
    config: &Map<String, Value>,
    server: &SaveMcpServerInput,
) -> Result<(), String> {
    if !config.contains_key("headers") {
        return Ok(());
    }
    let current_url = config
        .get("url")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("mcpServers.{name}.url doit être une chaîne"))?;
    if !same_http_origin(current_url, &server.url, name)? {
        return Err(format!(
            "mcpServers.{name} contient des en-têtes configurés hors de Prime Orbit ; son origine ne peut pas être modifiée depuis l’interface"
        ));
    }
    if auth_kind(config, name)? != server.auth_kind {
        return Err(format!(
            "mcpServers.{name} contient des en-têtes configurés hors de Prime Orbit ; son authentification ne peut pas être modifiée depuis l’interface"
        ));
    }
    Ok(())
}

fn public_server(name: &str, config: &Value, scope: McpScope) -> Result<PublicMcpServer, String> {
    let config = config
        .as_object()
        .ok_or_else(|| format!("mcpServers.{name} doit être un objet"))?;
    let kind = config
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("mcpServers.{name}.type doit être une chaîne"))?;
    let url = match kind {
        "http" => Some(safe_public_http_url(
            config
                .get("url")
                .and_then(Value::as_str)
                .ok_or_else(|| format!("mcpServers.{name}.url doit être une chaîne"))?,
            name,
        )?),
        "stdio" => None,
        _ => {
            return Err(format!("mcpServers.{name}.type doit valoir http ou stdio"));
        }
    };
    Ok(PublicMcpServer {
        name: name.to_string(),
        url,
        enabled: server_enabled(config, name)?,
        scope,
        auth_kind: auth_kind(config, name)?,
        has_custom_headers: config.contains_key("headers"),
        builtin: is_builtin(name),
    })
}

fn insert_public_settings(
    destination: &mut BTreeMap<String, PublicMcpServer>,
    settings: &Value,
    scope: McpScope,
) -> Result<(), String> {
    let Some(servers) = settings.get("mcpServers") else {
        return Ok(());
    };
    let servers = servers
        .as_object()
        .ok_or_else(|| "mcpServers doit être un objet".to_string())?;
    for (name, config) in servers {
        destination.insert(name.clone(), public_server(name, config, scope)?);
    }
    Ok(())
}

fn inspect_documents(
    auth_keys: Vec<String>,
    global: &Value,
    project: Option<&Value>,
) -> Result<PrimeAgentConnections, String> {
    let auth_set: BTreeSet<&str> = auth_keys.iter().map(String::as_str).collect();
    let mut servers = BTreeMap::new();
    for (name, url) in BUILTIN_SERVERS {
        servers.insert(
            name.to_string(),
            PublicMcpServer {
                name: name.to_string(),
                url: Some(url.to_string()),
                enabled: auth_set.contains(format!("mcp:{name}").as_str()),
                scope: McpScope::Global,
                auth_kind: McpAuthKind::OAuth,
                has_custom_headers: false,
                builtin: true,
            },
        );
    }
    insert_public_settings(&mut servers, global, McpScope::Global)?;
    if let Some(project) = project {
        insert_public_settings(&mut servers, project, McpScope::Project)?;
    }
    Ok(PrimeAgentConnections {
        provider_ids: auth_keys,
        mcp_servers: servers.into_values().collect(),
    })
}

fn serialize_settings(value: &Value) -> Result<Vec<u8>, String> {
    validate_settings_root(value, Path::new("settings.json"))?;
    let mut bytes = serde_json::to_vec_pretty(value)
        .map_err(|error| format!("Impossible de sérialiser settings.json: {error}"))?;
    bytes.push(b'\n');
    if bytes.len() as u64 > MAX_SETTINGS_BYTES {
        return Err(format!(
            "settings.json dépasse la limite autorisée de {MAX_SETTINGS_BYTES} octets"
        ));
    }
    Ok(bytes)
}

fn backup_path(path: &Path) -> Result<PathBuf, String> {
    let name = path
        .file_name()
        .ok_or_else(|| format!("Chemin settings.json invalide: {}", path.display()))?;
    let mut backup_name = OsString::from(name);
    backup_name.push(".bak");
    Ok(path.with_file_name(backup_name))
}

fn write_backup(path: &Path, raw: Option<&[u8]>) -> Result<Option<PathBuf>, String> {
    let Some(raw) = raw else {
        return Ok(None);
    };
    let backup = backup_path(path)?;
    write_atomic(&backup, raw)?;
    Ok(Some(backup))
}

struct CompatibleSettingsLock {
    path: PathBuf,
    fingerprint: LockFingerprint,
    owner_path: PathBuf,
    owner: LockOwner,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct LockFingerprint {
    modified: Option<SystemTime>,
    created: Option<SystemTime>,
    identity: Option<String>,
}

impl LockFingerprint {
    fn read(path: &Path) -> Result<Self, String> {
        let metadata = fs::symlink_metadata(path)
            .map_err(|error| format!("Impossible d’inspecter {}: {error}", path.display()))?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(format!(
                "Le verrou {} doit être un dossier régulier non symbolique",
                path.display()
            ));
        }
        Ok(Self {
            modified: metadata.modified().ok(),
            created: metadata.created().ok(),
            identity: lock_file_identity(path, &metadata),
        })
    }

    fn is_stale_at(&self, now: SystemTime, stale_after: Duration) -> bool {
        self.modified
            .and_then(|modified| now.duration_since(modified).ok())
            .is_some_and(|age| age >= stale_after)
    }

    fn stable_id(&self) -> String {
        fn nanos(value: Option<SystemTime>) -> u128 {
            value
                .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
                .map_or(0, |duration| duration.as_nanos())
        }
        format!(
            "{}:{}:{}",
            self.identity.as_deref().unwrap_or("unknown"),
            nanos(self.created),
            nanos(self.modified)
        )
    }
}

#[cfg(windows)]
fn lock_file_identity(path: &Path, _metadata: &fs::Metadata) -> Option<String> {
    use std::os::windows::ffi::OsStrExt;

    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    // SAFETY: `wide` is NUL-terminated, the output structure is valid, and
    // the directory handle is closed on every path after a successful open.
    unsafe {
        let handle = CreateFileW(
            wide.as_ptr(),
            FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS,
            std::ptr::null_mut(),
        );
        if handle == INVALID_HANDLE_VALUE {
            return None;
        }
        let mut information: BY_HANDLE_FILE_INFORMATION = std::mem::zeroed();
        let read = GetFileInformationByHandle(handle, &mut information) != 0;
        let _ = CloseHandle(handle);
        if !read {
            return None;
        }
        let index = ((information.nFileIndexHigh as u64) << 32) | information.nFileIndexLow as u64;
        Some(format!(
            "windows-{}-{index}",
            information.dwVolumeSerialNumber
        ))
    }
}

#[cfg(unix)]
fn lock_file_identity(_path: &Path, metadata: &fs::Metadata) -> Option<String> {
    use std::os::unix::fs::MetadataExt;

    Some(format!("unix-{}-{}", metadata.dev(), metadata.ino()))
}

#[cfg(all(not(windows), not(unix)))]
fn lock_file_identity(_path: &Path, _metadata: &fs::Metadata) -> Option<String> {
    None
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LockOwner {
    pid: u32,
    process_start_id: String,
    acquired_at_millis: u128,
    lock_id: String,
    token: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum ProcessProbe {
    Running(String),
    Dead,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProcessLiveness {
    Alive,
    Dead,
    Unknown,
}

fn current_process_start_id() -> String {
    match process_probe(std::process::id()) {
        ProcessProbe::Running(start_id) => start_id,
        ProcessProbe::Dead | ProcessProbe::Unknown => PROCESS_START_FALLBACK
            .get_or_init(|| {
                format!(
                    "fallback-{}-{}",
                    std::process::id(),
                    SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_nanos()
                )
            })
            .clone(),
    }
}

#[cfg(windows)]
fn process_probe(pid: u32) -> ProcessProbe {
    // SAFETY: the process handle is checked before use, all FILETIME pointers
    // are valid for the duration of the calls, and the handle is always closed.
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            // ERROR_INVALID_PARAMETER is the documented result for a PID that
            // does not exist. Access denied and every other failure are not
            // proof of death: another instance may simply run elevated.
            return if std::io::Error::last_os_error().raw_os_error() == Some(87) {
                ProcessProbe::Dead
            } else {
                ProcessProbe::Unknown
            };
        }
        let empty_time = || FILETIME {
            dwLowDateTime: 0,
            dwHighDateTime: 0,
        };
        let mut creation = empty_time();
        let mut exit = empty_time();
        let mut kernel = empty_time();
        let mut user = empty_time();
        let mut exit_code = 0u32;
        let exit_code_read = GetExitCodeProcess(handle, &mut exit_code) != 0;
        let times_read =
            GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user) != 0;
        let _ = CloseHandle(handle);
        if !exit_code_read {
            return ProcessProbe::Unknown;
        }
        if exit_code != STILL_ACTIVE as u32 {
            return ProcessProbe::Dead;
        }
        if !times_read {
            return ProcessProbe::Unknown;
        }
        let ticks = ((creation.dwHighDateTime as u64) << 32) | creation.dwLowDateTime as u64;
        ProcessProbe::Running(format!("windows-filetime-{ticks}"))
    }
}

#[cfg(all(unix, not(target_os = "linux")))]
fn process_probe(pid: u32) -> ProcessProbe {
    if pid == std::process::id() {
        ProcessProbe::Running(current_process_fallback_without_recursion())
    } else {
        // std does not expose a portable Unix process identity probe. Treat an
        // unobservable foreign PID as unknown rather than risking two writers.
        ProcessProbe::Unknown
    }
}

#[cfg(target_os = "linux")]
fn process_probe(pid: u32) -> ProcessProbe {
    if !Path::new("/proc").is_dir() {
        return ProcessProbe::Unknown;
    }
    let stat = match fs::read_to_string(format!("/proc/{pid}/stat")) {
        Ok(stat) => stat,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return ProcessProbe::Dead;
        }
        Err(_) => return ProcessProbe::Unknown,
    };
    let Some((_, fields)) = stat.rsplit_once(')') else {
        return ProcessProbe::Unknown;
    };
    let Some(start_ticks) = fields.split_whitespace().nth(19) else {
        return ProcessProbe::Unknown;
    };
    ProcessProbe::Running(format!("linux-start-ticks-{start_ticks}"))
}

#[cfg(all(not(windows), not(unix)))]
fn process_probe(pid: u32) -> ProcessProbe {
    if pid == std::process::id() {
        ProcessProbe::Running(current_process_fallback_without_recursion())
    } else {
        ProcessProbe::Unknown
    }
}

#[cfg(any(all(unix, not(target_os = "linux")), all(not(windows), not(unix))))]
fn current_process_fallback_without_recursion() -> String {
    PROCESS_START_FALLBACK
        .get_or_init(|| {
            format!(
                "fallback-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos()
            )
        })
        .clone()
}

fn owner_liveness_from_probe(owner: &LockOwner, probe: ProcessProbe) -> ProcessLiveness {
    match probe {
        ProcessProbe::Running(start_id) if start_id == owner.process_start_id => {
            ProcessLiveness::Alive
        }
        // A running process with a different start identity proves that the
        // recorded process exited and its PID has since been reused.
        ProcessProbe::Running(_) | ProcessProbe::Dead => ProcessLiveness::Dead,
        ProcessProbe::Unknown => ProcessLiveness::Unknown,
    }
}

fn owner_process_liveness(owner: &LockOwner) -> ProcessLiveness {
    owner_liveness_from_probe(owner, process_probe(owner.pid))
}

fn owner_file_prefix(lock_path: &Path) -> Result<String, String> {
    let name = lock_path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| format!("Chemin de verrou invalide: {}", lock_path.display()))?;
    Ok(format!("{name}.prime-orbit-owner-"))
}

fn create_lock_owner(
    lock_path: &Path,
    fingerprint: &LockFingerprint,
) -> Result<(PathBuf, LockOwner), String> {
    let prefix = owner_file_prefix(lock_path)?;
    for _ in 0..8 {
        let counter = SETTINGS_LOCK_RECLAIM_COUNTER.fetch_add(1, Ordering::Relaxed);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let token = format!("{}-{counter}-{nanos}", std::process::id());
        let owner = LockOwner {
            pid: std::process::id(),
            process_start_id: current_process_start_id(),
            acquired_at_millis: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis(),
            lock_id: fingerprint.stable_id(),
            token: token.clone(),
        };
        let path = lock_path.with_file_name(format!("{prefix}{token}.json"));
        let mut file = match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(format!(
                    "Impossible de créer le propriétaire du verrou {}: {error}",
                    path.display()
                ));
            }
        };
        let bytes = serde_json::to_vec(&owner)
            .map_err(|error| format!("Impossible de sérialiser le verrou MCP: {error}"))?;
        if let Err(error) = file.write_all(&bytes).and_then(|_| file.sync_all()) {
            let _ = fs::remove_file(&path);
            return Err(format!(
                "Impossible d’écrire le propriétaire du verrou {}: {error}",
                path.display()
            ));
        }
        return Ok((path, owner));
    }
    Err("Impossible de réserver un identifiant de propriétaire MCP unique".to_string())
}

fn read_lock_owner(path: &Path) -> Result<LockOwner, String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("Impossible d’inspecter {}: {error}", path.display()))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() > 4096 {
        return Err(format!(
            "Le propriétaire de verrou {} est invalide",
            path.display()
        ));
    }
    let bytes = fs::read(path)
        .map_err(|error| format!("Impossible de lire {}: {error}", path.display()))?;
    serde_json::from_slice(&bytes).map_err(|error| {
        format!(
            "Propriétaire de verrou invalide dans {}: {error}",
            path.display()
        )
    })
}

fn matching_lock_owners(
    lock_path: &Path,
    fingerprint: &LockFingerprint,
) -> Result<Vec<(PathBuf, LockOwner)>, String> {
    let prefix = owner_file_prefix(lock_path)?;
    let parent = lock_path
        .parent()
        .ok_or_else(|| format!("Chemin de verrou invalide: {}", lock_path.display()))?;
    let mut owners = Vec::new();
    let entries = fs::read_dir(parent)
        .map_err(|error| format!("Impossible d’inspecter {}: {error}", parent.display()))?;
    let mut owner_files_seen = 0usize;
    for entry in entries {
        let entry = entry.map_err(|error| {
            format!("Impossible d’inspecter un propriétaire de verrou: {error}")
        })?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if !name.starts_with(&prefix) || !name.ends_with(".json") {
            continue;
        }
        owner_files_seen += 1;
        if owner_files_seen > 256 {
            return Err(format!(
                "Trop de métadonnées de verrou MCP sont présentes dans {}",
                parent.display()
            ));
        }
        let path = entry.path();
        let owner = match read_lock_owner(&path) {
            Ok(owner) => owner,
            Err(_) => continue,
        };
        if owner.lock_id == fingerprint.stable_id() {
            owners.push((path, owner));
        }
    }
    owners.sort_by_key(|(_, owner)| owner.acquired_at_millis);
    Ok(owners)
}

fn unique_reclaim_path(lock_path: &Path) -> Result<PathBuf, String> {
    let file_name = lock_path
        .file_name()
        .ok_or_else(|| format!("Chemin de verrou invalide: {}", lock_path.display()))?;
    let counter = SETTINGS_LOCK_RECLAIM_COUNTER.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let mut name = OsString::from(file_name);
    name.push(format!(
        ".prime-orbit-reclaim-{}-{counter}-{nanos}",
        std::process::id()
    ));
    Ok(lock_path.with_file_name(name))
}

/// Atomically moves an observed stale directory out of the well-known lock
/// name before deleting it. Re-reading the fingerprint after the rename keeps
/// an ABA replacement from being mistaken for the stale directory we saw.
fn reclaim_stale_lock(
    lock_path: &Path,
    now: SystemTime,
    stale_after: Duration,
) -> Result<bool, String> {
    reclaim_stale_lock_with_probe(lock_path, now, stale_after, owner_process_liveness)
}

fn reclaim_stale_lock_with_probe<F>(
    lock_path: &Path,
    now: SystemTime,
    stale_after: Duration,
    probe_owner: F,
) -> Result<bool, String>
where
    F: Fn(&LockOwner) -> ProcessLiveness,
{
    let observed = match LockFingerprint::read(lock_path) {
        Ok(fingerprint) => fingerprint,
        Err(_) if !lock_path.exists() => return Ok(false),
        Err(error) => return Err(error),
    };
    if !observed.is_stale_at(now, stale_after) {
        return Ok(false);
    }
    let owners = matching_lock_owners(lock_path, &observed)?;
    // An unobservable process is not a dead process. Reclaim only when every
    // valid owner record is positively proven dead; Alive and Unknown both
    // preserve the lock and force the caller to report it as busy.
    if !owners
        .iter()
        .all(|(_, owner)| probe_owner(owner) == ProcessLiveness::Dead)
    {
        return Ok(false);
    }

    let quarantine = unique_reclaim_path(lock_path)?;
    match fs::rename(lock_path, &quarantine) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => {
            return Err(format!(
                "Impossible d’isoler le verrou expiré {}: {error}",
                lock_path.display()
            ));
        }
    }

    let moved = LockFingerprint::read(&quarantine)?;
    if moved != observed {
        match fs::rename(&quarantine, lock_path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => {
                return Err(format!(
                    "Le verrou {} a changé pendant sa récupération et n’a pas pu être restauré: {error}",
                    lock_path.display()
                ));
            }
        }
        return Err(format!(
            "Le verrou {} a changé pendant sa récupération; réessayez",
            lock_path.display()
        ));
    }

    fs::remove_dir(&quarantine).map_err(|error| {
        format!(
            "Impossible de supprimer le verrou expiré isolé {}: {error}",
            quarantine.display()
        )
    })?;
    for (owner_path, _) in owners {
        let _ = fs::remove_file(owner_path);
    }
    Ok(true)
}

impl CompatibleSettingsLock {
    fn acquire(settings_path: &Path) -> Result<Self, String> {
        let name = settings_path
            .file_name()
            .ok_or_else(|| format!("Chemin settings.json invalide: {}", settings_path.display()))?;
        let mut lock_name = OsString::from(name);
        lock_name.push(".lock");
        let lock_path = settings_path.with_file_name(lock_name);
        for attempt in 0..10 {
            match fs::create_dir(&lock_path) {
                Ok(()) => {
                    let fingerprint = match LockFingerprint::read(&lock_path) {
                        Ok(fingerprint) => fingerprint,
                        Err(error) => {
                            let _ = fs::remove_dir(&lock_path);
                            return Err(error);
                        }
                    };
                    let (owner_path, owner) = match create_lock_owner(&lock_path, &fingerprint) {
                        Ok(owner) => owner,
                        Err(error) => {
                            let _ = fs::remove_dir(&lock_path);
                            return Err(error);
                        }
                    };
                    return Ok(Self {
                        path: lock_path,
                        fingerprint,
                        owner_path,
                        owner,
                    });
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists && attempt < 9 => {
                    if reclaim_stale_lock(&lock_path, SystemTime::now(), SETTINGS_LOCK_STALE_AFTER)?
                    {
                        continue;
                    }
                    thread::sleep(Duration::from_millis(20));
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    return Err(format!(
                        "settings.json est utilisé par une autre instance (verrou {})",
                        lock_path.display()
                    ));
                }
                Err(error) => {
                    return Err(format!(
                        "Impossible de verrouiller settings.json via {}: {error}",
                        lock_path.display()
                    ));
                }
            }
        }
        Err("Impossible de verrouiller settings.json".to_string())
    }
}

impl Drop for CompatibleSettingsLock {
    fn drop(&mut self) {
        // A stalled owner can lose a stale lock to another process. Never
        // remove a replacement lock that no longer has our fingerprint.
        let still_owned = LockFingerprint::read(&self.path).as_ref() == Ok(&self.fingerprint)
            && read_lock_owner(&self.owner_path).as_ref() == Ok(&self.owner);
        if still_owned && fs::remove_dir(&self.path).is_ok() {
            let _ = fs::remove_file(&self.owner_path);
        }
    }
}

fn ensure_existing_http<'a>(
    name: &str,
    value: &'a mut Value,
) -> Result<&'a mut Map<String, Value>, String> {
    let config = value
        .as_object_mut()
        .ok_or_else(|| format!("mcpServers.{name} doit être un objet"))?;
    if config.get("type").and_then(Value::as_str) != Some("http") {
        return Err(format!(
            "mcpServers.{name} existe mais n’est pas un serveur HTTP personnalisable"
        ));
    }
    Ok(config)
}

fn settings_servers_mut(value: &mut Value) -> Result<&mut Map<String, Value>, String> {
    let root = value
        .as_object_mut()
        .ok_or_else(|| "settings.json doit contenir un objet JSON à la racine".to_string())?;
    let servers = root
        .entry("mcpServers")
        .or_insert_with(|| Value::Object(Map::new()));
    servers
        .as_object_mut()
        .ok_or_else(|| "mcpServers doit être un objet".to_string())
}

fn inspect_prime_agent_defaults_blocking(
    app: AppHandle,
    persistence: PersistenceLock,
) -> Result<PrimeAgentDefaults, String> {
    let _guard = persistence.0.lock();
    let path = settings_path(&app, None, McpScope::Global, false)?;
    let document = load_settings(&path)?;
    inspect_prime_agent_defaults_document(&document.value)
}

fn save_prime_agent_defaults_at_path(
    path: &Path,
    input: SavePrimeAgentDefaultsInput,
) -> Result<SavePrimeAgentDefaultsResult, String> {
    validate_prime_agent_defaults_input(&input)?;
    let _file_lock = CompatibleSettingsLock::acquire(path)?;
    let mut document = load_settings(path)?;
    let defaults = apply_prime_agent_defaults(&mut document.value, &input)?;
    let bytes = serialize_settings(&document.value)?;
    let backup = write_backup(path, document.raw.as_deref())?;
    write_atomic(path, &bytes)?;
    Ok(SavePrimeAgentDefaultsResult {
        path: path.to_string_lossy().into_owned(),
        backup_path: backup.map(|value| value.to_string_lossy().into_owned()),
        defaults,
    })
}

fn save_prime_agent_defaults_blocking(
    app: AppHandle,
    input: SavePrimeAgentDefaultsInput,
    persistence: PersistenceLock,
) -> Result<SavePrimeAgentDefaultsResult, String> {
    validate_prime_agent_defaults_input(&input)?;
    let path = settings_path(&app, None, McpScope::Global, true)?;
    let _guard = persistence.0.lock();
    save_prime_agent_defaults_at_path(&path, input)
}

fn inspect_prime_agent_connections_blocking(
    app: AppHandle,
    cwd: Option<String>,
    persistence: PersistenceLock,
) -> Result<PrimeAgentConnections, String> {
    let _guard = persistence.0.lock();
    let auth_keys = load_auth_keys(&auth_path(&app)?)?;
    let global_path = settings_path(&app, None, McpScope::Global, false)?;
    let global = load_settings(&global_path)?;
    let project = match cwd {
        Some(cwd) => {
            let path = settings_path(&app, Some(cwd), McpScope::Project, false)?;
            Some(load_settings(&path)?)
        }
        None => None,
    };
    inspect_documents(
        auth_keys,
        &global.value,
        project.as_ref().map(|document| &document.value),
    )
}

fn save_mcp_server_blocking(
    app: AppHandle,
    cwd: Option<String>,
    scope: McpScope,
    server: SaveMcpServerInput,
    persistence: PersistenceLock,
) -> Result<SaveMcpServerResult, String> {
    validate_executable_mcp_scope(scope)?;
    validate_save_input(&server)?;
    let path = settings_path(&app, cwd, scope, true)?;
    let _guard = persistence.0.lock();
    let _file_lock = CompatibleSettingsLock::acquire(&path)?;
    let mut document = load_settings(&path)?;

    let servers = settings_servers_mut(&mut document.value)?;
    if let Some(existing) = servers.get_mut(&server.name) {
        let config = ensure_existing_http(&server.name, existing)?;
        validate_custom_headers_update(&server.name, config, &server)?;
        config.insert("url".to_string(), Value::String(server.url.clone()));
        config.insert("enabled".to_string(), Value::Bool(server.enabled));
        config.remove("oauth");
        config.remove("bearerTokenEnvVar");
        match server.auth_kind {
            McpAuthKind::OAuth => {
                config.insert("oauth".to_string(), Value::Bool(true));
            }
            McpAuthKind::BearerEnv => {
                config.insert(
                    "bearerTokenEnvVar".to_string(),
                    Value::String(
                        server
                            .bearer_token_env_var
                            .clone()
                            .expect("validated bearerTokenEnvVar"),
                    ),
                );
            }
            McpAuthKind::None => {}
        }
    } else {
        let mut config = Map::new();
        config.insert("type".to_string(), Value::String("http".to_string()));
        config.insert("url".to_string(), Value::String(server.url.clone()));
        config.insert("enabled".to_string(), Value::Bool(server.enabled));
        match server.auth_kind {
            McpAuthKind::OAuth => {
                config.insert("oauth".to_string(), Value::Bool(true));
            }
            McpAuthKind::BearerEnv => {
                config.insert(
                    "bearerTokenEnvVar".to_string(),
                    Value::String(
                        server
                            .bearer_token_env_var
                            .clone()
                            .expect("validated bearerTokenEnvVar"),
                    ),
                );
            }
            McpAuthKind::None => {}
        }
        servers.insert(server.name.clone(), Value::Object(config));
    }

    let public = public_server(
        &server.name,
        servers
            .get(&server.name)
            .expect("server inserted before public projection"),
        scope,
    )?;
    let bytes = serialize_settings(&document.value)?;
    let backup = write_backup(&path, document.raw.as_deref())?;
    write_atomic(&path, &bytes)?;
    Ok(SaveMcpServerResult {
        path: path.to_string_lossy().into_owned(),
        backup_path: backup.map(|value| value.to_string_lossy().into_owned()),
        server: public,
    })
}

fn delete_mcp_server_blocking(
    app: AppHandle,
    cwd: Option<String>,
    scope: McpScope,
    name: String,
    persistence: PersistenceLock,
) -> Result<DeleteMcpServerResult, String> {
    validate_server_name(&name)?;
    reject_builtin_mutation(&name)?;
    let path = settings_path(&app, cwd, scope, false)?;
    if !path.exists() {
        return Ok(DeleteMcpServerResult {
            path: path.to_string_lossy().into_owned(),
            backup_path: None,
            deleted: false,
        });
    }
    let _guard = persistence.0.lock();
    let _file_lock = CompatibleSettingsLock::acquire(&path)?;
    let mut document = load_settings(&path)?;

    let servers = settings_servers_mut(&mut document.value)?;
    let Some(existing) = servers.get_mut(&name) else {
        return Ok(DeleteMcpServerResult {
            path: path.to_string_lossy().into_owned(),
            backup_path: None,
            deleted: false,
        });
    };
    ensure_existing_http(&name, existing)?;
    servers.remove(&name);

    let bytes = serialize_settings(&document.value)?;
    let backup = write_backup(&path, document.raw.as_deref())?;
    write_atomic(&path, &bytes)?;
    Ok(DeleteMcpServerResult {
        path: path.to_string_lossy().into_owned(),
        backup_path: backup.map(|value| value.to_string_lossy().into_owned()),
        deleted: true,
    })
}

#[tauri::command(rename_all = "camelCase")]
pub async fn inspect_prime_agent_connections(
    app: AppHandle,
    cwd: Option<String>,
    persistence: tauri::State<'_, PersistenceLock>,
) -> Result<PrimeAgentConnections, String> {
    let persistence = PersistenceLock(std::sync::Arc::clone(&persistence.0));
    crate::run_blocking(move || inspect_prime_agent_connections_blocking(app, cwd, persistence))
        .await
}

#[tauri::command]
pub async fn inspect_prime_agent_defaults(
    app: AppHandle,
    persistence: tauri::State<'_, PersistenceLock>,
) -> Result<PrimeAgentDefaults, String> {
    let persistence = PersistenceLock(std::sync::Arc::clone(&persistence.0));
    crate::run_blocking(move || inspect_prime_agent_defaults_blocking(app, persistence)).await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn save_prime_agent_defaults(
    app: AppHandle,
    input: SavePrimeAgentDefaultsInput,
    persistence: tauri::State<'_, PersistenceLock>,
) -> Result<SavePrimeAgentDefaultsResult, String> {
    let persistence = PersistenceLock(std::sync::Arc::clone(&persistence.0));
    let event_app = app.clone();
    let result =
        crate::run_blocking(move || save_prime_agent_defaults_blocking(app, input, persistence))
            .await?;
    let _ = event_app.emit(
        "prime-orbit://prime-agent-defaults",
        result.defaults.clone(),
    );
    Ok(result)
}

#[tauri::command]
pub async fn check_ollama_health(app: AppHandle) -> Result<OllamaHealth, String> {
    crate::run_blocking(move || {
        let endpoint = load_ollama_endpoint(&app)?;
        Ok(probe_ollama_endpoint(&endpoint, OLLAMA_PROBE_TIMEOUT))
    })
    .await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn save_mcp_server(
    app: AppHandle,
    cwd: Option<String>,
    scope: McpScope,
    server: SaveMcpServerInput,
    persistence: tauri::State<'_, PersistenceLock>,
) -> Result<SaveMcpServerResult, String> {
    let persistence = PersistenceLock(std::sync::Arc::clone(&persistence.0));
    crate::run_blocking(move || save_mcp_server_blocking(app, cwd, scope, server, persistence))
        .await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn delete_mcp_server(
    app: AppHandle,
    cwd: Option<String>,
    scope: McpScope,
    name: String,
    persistence: tauri::State<'_, PersistenceLock>,
) -> Result<DeleteMcpServerResult, String> {
    let persistence = PersistenceLock(std::sync::Arc::clone(&persistence.0));
    crate::run_blocking(move || delete_mcp_server_blocking(app, cwd, scope, name, persistence))
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn one_shot_http_server(
        expected_path: &'static str,
        response: &'static [u8],
    ) -> (SocketAddr, thread::JoinHandle<()>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(2);
            loop {
                match listener.accept() {
                    Ok((mut socket, _)) => {
                        // Accepted sockets inherit the listener's non-blocking
                        // mode on Windows. The fixture performs one bounded,
                        // blocking request read so parallel test scheduling
                        // cannot turn it into a spurious WouldBlock failure.
                        socket.set_nonblocking(false).unwrap();
                        socket
                            .set_read_timeout(Some(Duration::from_secs(1)))
                            .unwrap();
                        let mut request = [0u8; 512];
                        let count = socket.read(&mut request).unwrap();
                        assert!(String::from_utf8_lossy(&request[..count])
                            .starts_with(&format!("GET {expected_path} HTTP/1.1")));
                        socket.write_all(response).unwrap();
                        return;
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        assert!(Instant::now() < deadline, "health probe never connected");
                        thread::sleep(Duration::from_millis(5));
                    }
                    Err(error) => panic!("listener failed: {error}"),
                }
            }
        });
        (address, server)
    }

    #[test]
    fn ollama_endpoint_comes_from_the_effective_provider_without_exposing_query_secrets() {
        let document = serde_json::json!({
            "providers": {
                "ollama": {
                    "baseUrl": "http://127.0.0.1:11434/v1?token=NEVER_EXPOSED#fragment"
                }
            }
        });
        let endpoint = configured_ollama_endpoint(&document).unwrap();
        assert_eq!(endpoint, "http://127.0.0.1:11434/v1");
        assert!(!endpoint.contains("NEVER_EXPOSED"));
        assert_eq!(
            configured_ollama_endpoint(&serde_json::json!({ "providers": {} })).unwrap(),
            DEFAULT_OLLAMA_ENDPOINT
        );
        assert!(configured_ollama_endpoint(&serde_json::json!({
            "providers": { "ollama": { "baseUrl": "http://user:secret@127.0.0.1:11434/v1" } }
        }))
        .is_err());
    }

    #[test]
    fn ollama_native_probe_path_translates_openai_compatible_base_urls() {
        assert_eq!(
            ollama_native_tags_path(&Url::parse("http://127.0.0.1:11434/v1").unwrap()),
            "/api/tags"
        );
        assert_eq!(
            ollama_native_tags_path(&Url::parse("https://models.example.test/ollama/v1").unwrap()),
            "/ollama/api/tags"
        );
        assert_eq!(
            ollama_native_tags_path(&Url::parse("http://127.0.0.1:11434/api/tags").unwrap()),
            "/api/tags"
        );
    }

    #[test]
    fn ollama_probe_accepts_the_chunked_response_used_by_the_real_server() {
        let (address, server) = one_shot_http_server(
            "/api/tags",
            b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\nd\r\n{\"models\":[]}\r\n0\r\n\r\n",
        );
        let endpoint = format!("http://{address}/v1");
        let health = probe_ollama_endpoint(&endpoint, Duration::from_millis(500));
        server.join().unwrap();
        assert!(health.reachable, "{:?}", health.error);
        assert!(health.verified);
        assert_eq!(health.endpoint, endpoint);
    }

    #[test]
    fn ollama_probe_requires_an_http_response_and_is_bounded() {
        let (address, server) = one_shot_http_server(
            "/api/tags",
            b"HTTP/1.1 200 OK\r\nContent-Length: 13\r\n\r\n{\"models\":[]}",
        );
        let endpoint = format!("http://{address}/v1");
        let health = probe_ollama_endpoint(&endpoint, Duration::from_millis(500));
        server.join().unwrap();
        assert!(health.reachable, "{:?}", health.error);
        assert!(health.verified);
        assert_eq!(health.endpoint, endpoint);
        assert!(health.error.is_none());

        let (address, server) = one_shot_http_server(
            "/api/tags",
            b"HTTP/1.1 404 Not Found\r\nContent-Length: 13\r\n\r\n{\"models\":[]}",
        );
        let health =
            probe_ollama_endpoint(&format!("http://{address}/v1"), Duration::from_millis(500));
        server.join().unwrap();
        assert!(
            !health.reachable,
            "a generic HTTP response is not Ollama health"
        );

        let (address, server) = one_shot_http_server(
            "/api/tags",
            b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}",
        );
        let health =
            probe_ollama_endpoint(&format!("http://{address}/v1"), Duration::from_millis(500));
        server.join().unwrap();
        assert!(
            !health.reachable,
            "a 2xx response without an Ollama payload is not healthy"
        );

        let unavailable = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let unavailable_address = unavailable.local_addr().unwrap();
        drop(unavailable);
        let started = Instant::now();
        let health = probe_ollama_endpoint(
            &format!("http://{unavailable_address}/v1"),
            Duration::from_millis(150),
        );
        assert!(!health.reachable);
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn ollama_probe_enforces_one_deadline_for_a_slow_drip_response() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(1)))
                .unwrap();
            let mut request = [0u8; 512];
            let _ = socket.read(&mut request).unwrap();
            // Every individual byte arrives well within the probe timeout. A
            // fixed per-read timeout would therefore allow the peer to extend
            // the probe until the whole response has been sent.
            for byte in b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{" {
                if socket.write_all(std::slice::from_ref(byte)).is_err() {
                    break;
                }
                thread::sleep(Duration::from_millis(25));
            }
        });

        let started = Instant::now();
        let health =
            probe_ollama_endpoint(&format!("http://{address}/v1"), Duration::from_millis(120));
        let elapsed = started.elapsed();
        server.join().unwrap();

        assert!(!health.reachable);
        assert!(
            elapsed < Duration::from_millis(450),
            "slow response exceeded the absolute deadline: {elapsed:?}"
        );
    }

    #[test]
    fn auth_parser_returns_only_sorted_root_keys() {
        let input = br#"{
          "openai": {"type":"api_key","key":"TOP-SECRET"},
          "mcp:linear": {"type":"oauth","access":"ACCESS","refresh":"REFRESH"},
          "anthropic": {"nested":{"token":"NEVER RETURNED"}}
        }"#;
        assert_eq!(
            parse_auth_keys(input).unwrap(),
            vec!["anthropic", "mcp:linear", "openai"]
        );
    }

    #[test]
    fn inspection_merges_by_server_name_and_redacts_sensitive_fields() {
        let global = serde_json::json!({
            "mcpServers": {
                "acme": {
                    "type": "http",
                    "url": "https://global.example/mcp",
                    "headers": {"Authorization": "Bearer SECRET"},
                    "bearerTokenEnvVar": "GLOBAL_SECRET_ENV"
                },
                "local": {
                    "type": "stdio",
                    "command": "secret-command",
                    "env": {"TOKEN": "SECRET"}
                },
                "legacy": {
                    "type": "http",
                    "url": "https://user:URL_SECRET@example.test/mcp?token=QUERY_SECRET#fragment"
                },
                "header_only": {
                    "type": "http",
                    "url": "https://headers.example.test/mcp",
                    "headers": {"Authorization": "Bearer HEADER_SECRET"}
                }
            }
        });
        let project = serde_json::json!({
            "mcpServers": {
                "acme": {
                    "type": "http",
                    "url": "https://project.example/mcp",
                    "oauth": true,
                    "enabled": false
                }
            }
        });
        let result = inspect_documents(
            vec!["mcp:linear".to_string(), "openai".to_string()],
            &global,
            Some(&project),
        )
        .unwrap();
        let acme = result
            .mcp_servers
            .iter()
            .find(|server| server.name == "acme")
            .unwrap();
        assert_eq!(acme.scope, McpScope::Project);
        assert_eq!(acme.url.as_deref(), Some("https://project.example/mcp"));
        assert_eq!(acme.auth_kind, McpAuthKind::OAuth);
        assert!(!acme.enabled);
        let linear = result
            .mcp_servers
            .iter()
            .find(|server| server.name == "linear")
            .unwrap();
        assert!(linear.builtin && linear.enabled);
        let legacy = result
            .mcp_servers
            .iter()
            .find(|server| server.name == "legacy")
            .unwrap();
        assert_eq!(legacy.url.as_deref(), Some("https://example.test/mcp"));
        let header_only = result
            .mcp_servers
            .iter()
            .find(|server| server.name == "header_only")
            .unwrap();
        assert!(header_only.has_custom_headers);
        assert_eq!(header_only.auth_kind, McpAuthKind::None);

        let serialized = serde_json::to_string(&result).unwrap();
        for secret in [
            "SECRET",
            "Authorization",
            "GLOBAL_SECRET_ENV",
            "secret-command",
            "TOKEN",
            "bearerTokenEnvVar",
            "URL_SECRET",
            "QUERY_SECRET",
            "HEADER_SECRET",
        ] {
            assert!(!serialized.contains(secret));
        }
        assert!(!serialized.contains("\"headers\":"));
    }

    #[test]
    fn validates_safe_custom_http_contract() {
        let valid = SaveMcpServerInput {
            name: "acme_tools".to_string(),
            url: "https://mcp.acme.test/mcp".to_string(),
            enabled: true,
            auth_kind: McpAuthKind::BearerEnv,
            bearer_token_env_var: Some("ACME_TOKEN".to_string()),
        };
        assert!(validate_save_input(&valid).is_ok());

        let mut invalid = valid.clone();
        invalid.name = "linear".to_string();
        assert!(validate_save_input(&invalid).is_err());
        invalid.name = "bad-name".to_string();
        assert!(validate_save_input(&invalid).is_err());
        invalid.name = "acme".to_string();
        invalid.url = "file:///etc/passwd".to_string();
        assert!(validate_save_input(&invalid).is_err());
        invalid.url = "https://user:secret@example.test/mcp".to_string();
        assert!(validate_save_input(&invalid).is_err());
        invalid.url = "https://example.test/mcp".to_string();
        invalid.bearer_token_env_var = Some("TOKEN=value".to_string());
        assert!(validate_save_input(&invalid).is_err());
        invalid.bearer_token_env_var = Some("TOKEN".to_string());
        invalid.url = "https://example.test/mcp?token=secret".to_string();
        assert!(validate_save_input(&invalid).is_err());

        let loopback_without_secret = SaveMcpServerInput {
            name: "local_tools".to_string(),
            url: "http://127.0.0.1:3000/mcp".to_string(),
            enabled: true,
            auth_kind: McpAuthKind::None,
            bearer_token_env_var: None,
        };
        assert!(validate_save_input(&loopback_without_secret).is_ok());

        let mut cleartext_bearer = loopback_without_secret.clone();
        cleartext_bearer.auth_kind = McpAuthKind::BearerEnv;
        cleartext_bearer.bearer_token_env_var = Some("LOCAL_TOKEN".to_string());
        assert!(validate_save_input(&cleartext_bearer).is_err());

        let mut remote_cleartext = loopback_without_secret;
        remote_cleartext.url = "http://mcp.example.test/mcp".to_string();
        assert!(validate_save_input(&remote_cleartext).is_err());
    }

    #[test]
    fn prime_agent_080_executes_only_global_custom_mcp_settings() {
        assert!(validate_executable_mcp_scope(McpScope::Global).is_ok());
        let error = validate_executable_mcp_scope(McpScope::Project)
            .expect_err("project MCP settings are legacy inventory only");
        assert!(error.contains("Prime Agent 0.8"));
        assert!(error.contains("réglages globaux"));
    }

    #[test]
    fn custom_headers_cannot_move_to_another_origin_or_change_auth() {
        let config = serde_json::json!({
            "type": "http",
            "url": "https://api.example.test/old",
            "headers": {"Authorization": "Bearer SECRET"}
        });
        let config = config.as_object().unwrap();
        let mut input = SaveMcpServerInput {
            name: "acme".to_string(),
            url: "https://api.example.test/new".to_string(),
            enabled: true,
            auth_kind: McpAuthKind::None,
            bearer_token_env_var: None,
        };
        assert!(validate_custom_headers_update("acme", config, &input).is_ok());

        input.url = "https://attacker.example/new".to_string();
        assert!(validate_custom_headers_update("acme", config, &input).is_err());

        input.url = "https://api.example.test/new".to_string();
        input.auth_kind = McpAuthKind::OAuth;
        assert!(validate_custom_headers_update("acme", config, &input).is_err());
    }

    #[test]
    fn stale_settings_lock_is_quarantined_before_reuse() {
        let directory = tempfile::tempdir().unwrap();
        let lock = directory.path().join("settings.json.lock");
        fs::create_dir(&lock).unwrap();

        assert!(reclaim_stale_lock(&lock, SystemTime::now(), Duration::ZERO).unwrap());
        assert!(!lock.exists());
        assert!(fs::read_dir(directory.path()).unwrap().next().is_none());

        let guard = CompatibleSettingsLock::acquire(&directory.path().join("settings.json"))
            .expect("the reclaimed lock can be acquired again");
        assert!(lock.is_dir());
        drop(guard);
        assert!(!lock.exists());
    }

    #[test]
    fn fresh_settings_lock_is_never_reclaimed() {
        let directory = tempfile::tempdir().unwrap();
        let lock = directory.path().join("settings.json.lock");
        fs::create_dir(&lock).unwrap();
        assert!(!reclaim_stale_lock(&lock, SystemTime::now(), Duration::from_secs(60)).unwrap());
        assert!(lock.is_dir());
    }

    #[test]
    fn live_owner_prevents_timeout_based_recovery() {
        let directory = tempfile::tempdir().unwrap();
        let settings = directory.path().join("settings.json");
        let guard = CompatibleSettingsLock::acquire(&settings).unwrap();
        let lock = directory.path().join("settings.json.lock");

        assert!(!reclaim_stale_lock(&lock, SystemTime::now(), Duration::ZERO).unwrap());
        assert!(lock.is_dir());
        drop(guard);
        assert!(!lock.exists());
    }

    #[test]
    fn process_probe_distinguishes_alive_dead_and_unverifiable_owners() {
        let owner = LockOwner {
            pid: 42,
            process_start_id: "start-a".to_string(),
            acquired_at_millis: 1,
            lock_id: "lock".to_string(),
            token: "owner".to_string(),
        };

        assert_eq!(
            owner_liveness_from_probe(&owner, ProcessProbe::Running("start-a".to_string())),
            ProcessLiveness::Alive
        );
        assert_eq!(
            owner_liveness_from_probe(&owner, ProcessProbe::Running("start-b".to_string())),
            ProcessLiveness::Dead
        );
        assert_eq!(
            owner_liveness_from_probe(&owner, ProcessProbe::Dead),
            ProcessLiveness::Dead
        );
        assert_eq!(
            owner_liveness_from_probe(&owner, ProcessProbe::Unknown),
            ProcessLiveness::Unknown
        );
    }

    #[test]
    fn unverifiable_owner_preserves_an_expired_lock() {
        let directory = tempfile::tempdir().unwrap();
        let lock = directory.path().join("settings.json.lock");
        fs::create_dir(&lock).unwrap();
        let fingerprint = LockFingerprint::read(&lock).unwrap();
        let owner = LockOwner {
            pid: 42,
            process_start_id: "unverifiable".to_string(),
            acquired_at_millis: 1,
            lock_id: fingerprint.stable_id(),
            token: "unknown-owner".to_string(),
        };
        let owner_path = directory
            .path()
            .join("settings.json.lock.prime-orbit-owner-unknown-owner.json");
        fs::write(&owner_path, serde_json::to_vec(&owner).unwrap()).unwrap();

        assert!(
            !reclaim_stale_lock_with_probe(&lock, SystemTime::now(), Duration::ZERO, |_| {
                ProcessLiveness::Unknown
            },)
            .unwrap()
        );
        assert!(lock.is_dir());
        assert!(owner_path.is_file());
    }

    #[test]
    fn expired_dead_owner_is_recovered_with_its_metadata() {
        let directory = tempfile::tempdir().unwrap();
        let lock = directory.path().join("settings.json.lock");
        fs::create_dir(&lock).unwrap();
        let fingerprint = LockFingerprint::read(&lock).unwrap();
        let owner = LockOwner {
            pid: u32::MAX,
            process_start_id: "definitely-not-a-live-process".to_string(),
            acquired_at_millis: 1,
            lock_id: fingerprint.stable_id(),
            token: "dead-owner".to_string(),
        };
        let owner_path = directory
            .path()
            .join("settings.json.lock.prime-orbit-owner-dead-owner.json");
        fs::write(&owner_path, serde_json::to_vec(&owner).unwrap()).unwrap();

        assert!(
            reclaim_stale_lock_with_probe(&lock, SystemTime::now(), Duration::ZERO, |_| {
                ProcessLiveness::Dead
            },)
            .unwrap()
        );
        assert!(!lock.exists());
        assert!(!owner_path.exists());
    }

    #[test]
    fn lock_drop_does_not_remove_a_replacement() {
        let directory = tempfile::tempdir().unwrap();
        let settings = directory.path().join("settings.json");
        let mut guard = CompatibleSettingsLock::acquire(&settings).unwrap();
        let lock = directory.path().join("settings.json.lock");
        fs::remove_dir(&lock).unwrap();
        fs::create_dir(&lock).unwrap();
        // Make the expected owner identity unambiguously different even on
        // filesystems with coarse directory timestamp precision.
        guard.fingerprint = LockFingerprint {
            modified: Some(UNIX_EPOCH),
            created: Some(UNIX_EPOCH),
            identity: None,
        };

        drop(guard);
        assert!(lock.is_dir());
    }

    #[test]
    fn save_shape_preserves_unmanaged_http_fields() {
        let mut settings = serde_json::json!({
            "otherSetting": true,
            "mcpServers": {
                "acme": {
                    "type": "http",
                    "url": "https://old.example/mcp",
                    "headers": {"X-Secret": "KEEP-ME"},
                    "enabledTools": ["one"]
                }
            }
        });
        let servers = settings_servers_mut(&mut settings).unwrap();
        let config = ensure_existing_http("acme", servers.get_mut("acme").unwrap()).unwrap();
        config.insert(
            "url".to_string(),
            Value::String("https://new.example/mcp".to_string()),
        );
        config.insert("oauth".to_string(), Value::Bool(true));

        assert_eq!(settings["otherSetting"], Value::Bool(true));
        assert_eq!(
            settings["mcpServers"]["acme"]["headers"]["X-Secret"],
            Value::String("KEEP-ME".to_string())
        );
        assert_eq!(
            settings["mcpServers"]["acme"]["enabledTools"],
            serde_json::json!(["one"])
        );
    }

    #[test]
    fn writes_an_exact_backup_before_atomic_replacement() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("settings.json");
        let original = br#"{"mcpServers":{"acme":{"type":"http","url":"https://old.example/mcp","headers":{"Authorization":"Bearer SECRET"}}}}"#;
        write_atomic(&path, original).unwrap();

        let document = load_settings(&path).unwrap();
        let replacement = serde_json::json!({
            "mcpServers": {
                "acme": {
                    "type": "http",
                    "url": "https://new.example/mcp",
                    "enabled": true
                }
            }
        });
        let replacement = serialize_settings(&replacement).unwrap();
        let backup = write_backup(&path, document.raw.as_deref())
            .unwrap()
            .unwrap();
        write_atomic(&path, &replacement).unwrap();

        assert_eq!(fs::read(backup).unwrap(), original);
        let persisted: Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        assert_eq!(
            persisted["mcpServers"]["acme"]["url"],
            Value::String("https://new.example/mcp".to_string())
        );
    }

    #[test]
    fn reads_official_prime_agent_defaults_without_exposing_other_settings() {
        let settings = serde_json::json!({
            "defaultProvider": "openrouter",
            "defaultModel": "anthropic/claude-sonnet-4",
            "defaultThinkingLevel": "xhigh",
            "apiKey": "DO-NOT-RETURN",
            "mcpServers": {
                "private": {
                    "type": "http",
                    "url": "https://example.test/mcp",
                    "headers": { "Authorization": "Bearer SECRET" }
                }
            }
        });

        let defaults = inspect_prime_agent_defaults_document(&settings).unwrap();
        assert_eq!(
            defaults,
            PrimeAgentDefaults {
                default_provider: Some("openrouter".to_string()),
                default_model: Some("anthropic/claude-sonnet-4".to_string()),
                default_thinking_level: Some(PrimeAgentThinkingLevel::Xhigh),
            }
        );
        let public = serde_json::to_value(defaults).unwrap();
        assert!(public.get("apiKey").is_none());
        assert!(public.get("mcpServers").is_none());
    }

    #[test]
    fn resolves_global_agent_directory_with_prime_then_legacy_then_fallback_priority() {
        let directory = tempfile::tempdir().unwrap();
        let home = directory.path().join("home");
        let cwd = directory.path().join("project");
        let prime = directory.path().join("prime-agent-dir");
        let legacy = directory.path().join("legacy-agent-dir");

        assert_eq!(
            resolve_global_agent_directory(&home, &cwd, None, None),
            (home.join(".prime").join("agent"), false)
        );
        assert_eq!(
            resolve_global_agent_directory(
                &home,
                &cwd,
                Some(prime.as_os_str()),
                Some(legacy.as_os_str()),
            ),
            (prime.clone(), true),
            "PRIME_AGENT_CODING_AGENT_DIR must win over the legacy override"
        );
        assert_eq!(
            resolve_global_agent_directory(&home, &cwd, None, Some(legacy.as_os_str())),
            (legacy.clone(), true)
        );
        assert_eq!(
            resolve_global_agent_directory(
                &home,
                &cwd,
                Some(OsStr::new("")),
                Some(legacy.as_os_str()),
            ),
            (legacy, true),
            "an empty primary override must not mask a usable legacy override"
        );
    }

    #[test]
    fn resolves_global_agent_override_as_the_agent_directory_itself() {
        let directory = tempfile::tempdir().unwrap();
        let home = directory.path().join("home");
        let cwd = directory.path().join("project");

        assert_eq!(
            resolve_global_agent_directory(&home, &cwd, Some(OsStr::new("relative-agent")), None,),
            (cwd.join("relative-agent"), true)
        );
        assert_eq!(
            resolve_global_agent_directory(&home, &cwd, Some(OsStr::new("~/custom-agent")), None,),
            (home.join("custom-agent"), true)
        );
    }

    #[test]
    fn override_agent_directory_is_created_and_must_be_a_regular_directory() {
        let directory = tempfile::tempdir().unwrap();
        let configured = directory.path().join("nested").join("agent");
        let resolved = validate_override_agent_directory(&configured, true).unwrap();
        assert!(resolved.is_dir());

        let invalid = directory.path().join("not-a-directory");
        fs::write(&invalid, b"file").unwrap();
        assert!(validate_override_agent_directory(&invalid, false).is_err());
    }

    #[test]
    fn saves_defaults_with_exact_backup_and_preserves_unknown_secrets_and_mcp() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("settings.json");
        let original = br#"{
  "defaultProvider": "anthropic",
  "defaultModel": "claude-old",
  "defaultThinkingLevel": "low",
  "opaqueSecret": { "token": "KEEP-ME" },
  "futureSetting": [1, 2, 3],
  "mcpServers": {
    "acme": {
      "type": "http",
      "url": "https://example.test/mcp",
      "headers": { "Authorization": "Bearer SECRET" }
    }
  }
}"#;
        write_atomic(&path, original).unwrap();

        let result = save_prime_agent_defaults_at_path(
            &path,
            SavePrimeAgentDefaultsInput {
                default_provider: Some("openrouter".to_string()),
                default_model: Some("anthropic/claude-sonnet-4".to_string()),
                default_thinking_level: Some(PrimeAgentThinkingLevel::Max),
            },
        )
        .unwrap();

        assert_eq!(
            fs::read(result.backup_path.unwrap()).unwrap(),
            original,
            "the backup must contain the exact pre-save document"
        );
        let persisted: Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        assert_eq!(persisted["defaultProvider"], "openrouter");
        assert_eq!(persisted["defaultModel"], "anthropic/claude-sonnet-4");
        assert_eq!(persisted["defaultThinkingLevel"], "max");
        assert_eq!(persisted["opaqueSecret"]["token"], "KEEP-ME");
        assert_eq!(persisted["futureSetting"], serde_json::json!([1, 2, 3]));
        assert_eq!(
            persisted["mcpServers"]["acme"]["headers"]["Authorization"],
            "Bearer SECRET"
        );
    }

    #[test]
    fn null_defaults_remove_only_the_official_keys() {
        let mut settings = serde_json::json!({
            "defaultProvider": "ollama",
            "defaultModel": "qwen:latest",
            "defaultThinkingLevel": "medium",
            "unknown": true,
            "mcpServers": {}
        });
        let defaults = apply_prime_agent_defaults(
            &mut settings,
            &SavePrimeAgentDefaultsInput {
                default_provider: None,
                default_model: None,
                default_thinking_level: None,
            },
        )
        .unwrap();

        assert_eq!(
            defaults,
            PrimeAgentDefaults {
                default_provider: None,
                default_model: None,
                default_thinking_level: None,
            }
        );
        assert!(settings.get("defaultProvider").is_none());
        assert!(settings.get("defaultModel").is_none());
        assert!(settings.get("defaultThinkingLevel").is_none());
        assert_eq!(settings["unknown"], Value::Bool(true));
        assert_eq!(settings["mcpServers"], serde_json::json!({}));
    }

    #[test]
    fn rejects_incomplete_or_non_canonical_model_defaults_before_writing() {
        let valid_thinking = Some(PrimeAgentThinkingLevel::High);
        for input in [
            SavePrimeAgentDefaultsInput {
                default_provider: Some("anthropic".to_string()),
                default_model: None,
                default_thinking_level: valid_thinking,
            },
            SavePrimeAgentDefaultsInput {
                default_provider: Some("openrouter/model".to_string()),
                default_model: Some("anthropic/claude".to_string()),
                default_thinking_level: valid_thinking,
            },
            SavePrimeAgentDefaultsInput {
                default_provider: Some("ollama".to_string()),
                default_model: Some(" qwen:latest".to_string()),
                default_thinking_level: valid_thinking,
            },
            SavePrimeAgentDefaultsInput {
                default_provider: Some("ollama".to_string()),
                default_model: Some("qwen//latest".to_string()),
                default_thinking_level: valid_thinking,
            },
        ] {
            assert!(validate_prime_agent_defaults_input(&input).is_err());
        }

        let invalid_level =
            serde_json::from_value::<SavePrimeAgentDefaultsInput>(serde_json::json!({
                "defaultProvider": "ollama",
                "defaultModel": "qwen:latest",
                "defaultThinkingLevel": "ultra"
            }));
        assert!(invalid_level.is_err());

        let unknown_field =
            serde_json::from_value::<SavePrimeAgentDefaultsInput>(serde_json::json!({
                "defaultProvider": null,
                "defaultModel": null,
                "defaultThinkingLevel": null,
                "secret": "unexpected"
            }));
        assert!(unknown_field.is_err());

        let missing_field =
            serde_json::from_value::<SavePrimeAgentDefaultsInput>(serde_json::json!({
                "defaultProvider": null,
                "defaultModel": null
            }));
        assert!(missing_field.is_err());
    }
}
