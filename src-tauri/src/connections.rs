use crate::{
    paths::canonicalize,
    storage::{write_atomic, PersistenceLock},
};
use serde::{
    de::{IgnoredAny, MapAccess, Visitor},
    Deserialize, Serialize,
};
use serde_json::{Map, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    ffi::OsString,
    fmt, fs,
    io::Read,
    path::{Path, PathBuf},
    thread,
    time::Duration,
};
use tauri::{AppHandle, Manager};
use url::Url;

const MAX_SETTINGS_BYTES: u64 = 8 * 1024 * 1024;
const MAX_AUTH_BYTES: u64 = 4 * 1024 * 1024;
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
    pub builtin: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrimeAgentConnections {
    pub provider_ids: Vec<String>,
    pub mcp_servers: Vec<PublicMcpServer>,
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

fn validate_http_url(value: &str) -> Result<(), String> {
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
    Ok(())
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
    validate_http_url(&input.url)?;
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
    let root = match scope {
        McpScope::Global => home_directory(app)?,
        McpScope::Project => project_directory(cwd)?,
    };
    Ok(agent_config_directory(&root, create)?.join("settings.json"))
}

fn auth_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(agent_config_directory(&home_directory(app)?, false)?.join("auth.json"))
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
                Ok(()) => return Ok(Self { path: lock_path }),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists && attempt < 9 => {
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
        let _ = fs::remove_dir(&self.path);
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
    validate_save_input(&server)?;
    let path = settings_path(&app, cwd, scope, true)?;
    let _guard = persistence.0.lock();
    let _file_lock = CompatibleSettingsLock::acquire(&path)?;
    let mut document = load_settings(&path)?;

    let servers = settings_servers_mut(&mut document.value)?;
    if let Some(existing) = servers.get_mut(&server.name) {
        let config = ensure_existing_http(&server.name, existing)?;
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

        let serialized = serde_json::to_string(&result).unwrap();
        for secret in [
            "SECRET",
            "Authorization",
            "GLOBAL_SECRET_ENV",
            "secret-command",
            "TOKEN",
            "bearerTokenEnvVar",
            "headers",
            "URL_SECRET",
            "QUERY_SECRET",
        ] {
            assert!(!serialized.contains(secret));
        }
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
}
