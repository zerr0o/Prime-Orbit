use crate::paths::canonicalize;
use crate::storage::{
    app_data_dir, load_typed_json, runtime_config_path, save_typed_json, PersistenceLock,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    ffi::OsString,
    fs,
    io::Read,
    path::{Path, PathBuf},
    process::{Child, Command, ExitStatus, Output, Stdio},
    sync::Arc,
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::AppHandle;

#[cfg(windows)]
use std::ffi::OsStr;

pub const OFFICIAL_REPOSITORY_URL: &str = "https://github.com/PrimeIntellect-ai/prime-agent.git";
pub const SUPPORTED_PRIME_AGENT_TAG: &str = "v0.7.3";
pub const SUPPORTED_PRIME_AGENT_COMMIT: &str = "61131b2d195ba7a67a4ce8ac60bb10cecae07b67";
const STARTUP_COMMAND_TIMEOUT: Duration = Duration::from_secs(6);
const COMMAND_POLL_INTERVAL: Duration = Duration::from_millis(20);
const COMMAND_TERMINATION_GRACE: Duration = Duration::from_millis(500);
const SOURCE_CLI_CANDIDATES: [&str; 2] = [
    "packages/coding-agent/dist/bundle/cli.js",
    "packages/coding-agent/dist/cli.js",
];

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeConfig {
    #[serde(default)]
    pub executable_path: Option<String>,
    #[serde(default)]
    pub source_dir: Option<String>,
    #[serde(default)]
    pub node_path: Option<String>,
    #[serde(default)]
    pub cli_path: Option<String>,
    #[serde(default)]
    pub repository_url: Option<String>,
    #[serde(default)]
    pub updated_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrimeAgentDetection {
    pub found: bool,
    pub runtime_kind: Option<String>,
    pub executable_path: Option<String>,
    pub source_dir: Option<String>,
    pub node_path: Option<String>,
    pub cli_path: Option<String>,
    pub version: Option<String>,
    pub managed: bool,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrerequisiteDiagnostic {
    pub id: String,
    pub label: String,
    pub required_for_install: bool,
    pub found: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrerequisiteDiagnostics {
    pub ready: bool,
    pub can_quick_install: bool,
    pub prime_agent: PrimeAgentDetection,
    pub items: Vec<PrerequisiteDiagnostic>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalLaunchResult {
    pub opened: bool,
    pub cwd: String,
    pub runtime_kind: String,
}

#[derive(Debug, Clone)]
pub enum LaunchSpec {
    Executable {
        executable: PathBuf,
        managed: bool,
    },
    Source {
        node: PathBuf,
        cli: PathBuf,
        source_dir: PathBuf,
        managed: bool,
    },
}

impl LaunchSpec {
    pub fn command(&self, arguments: &[OsString]) -> Command {
        match self {
            Self::Executable { executable, .. } => external_command(executable, arguments),
            Self::Source { node, cli, .. } => {
                let mut source_arguments = Vec::with_capacity(arguments.len() + 1);
                source_arguments.push(cli.as_os_str().to_owned());
                source_arguments.extend_from_slice(arguments);
                external_command(node, &source_arguments)
            }
        }
    }

    fn managed(&self) -> bool {
        match self {
            Self::Executable { managed, .. } | Self::Source { managed, .. } => *managed,
        }
    }
}

pub fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

pub fn managed_runtime_root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_dir(app)?.join("runtime"))
}

pub fn managed_source_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(managed_runtime_root(app)?.join("prime-agent"))
}

fn is_regular_file(path: &Path) -> bool {
    fs::metadata(path)
        .map(|metadata| metadata.is_file())
        .unwrap_or(false)
}

fn canonical_regular_file(path: &Path, label: &str) -> Result<PathBuf, String> {
    let metadata = fs::metadata(path)
        .map_err(|error| format!("{label} {} est inaccessible: {error}", path.display()))?;
    if !metadata.is_file() {
        return Err(format!(
            "{label} {} n’est pas un fichier régulier",
            path.display()
        ));
    }
    canonicalize(path)
        .map_err(|error| format!("Impossible de résoudre {}: {error}", path.display()))
}

fn canonical_directory(path: &Path, label: &str) -> Result<PathBuf, String> {
    let metadata = fs::metadata(path)
        .map_err(|error| format!("{label} {} est inaccessible: {error}", path.display()))?;
    if !metadata.is_dir() {
        return Err(format!("{label} {} n’est pas un dossier", path.display()));
    }
    canonicalize(path)
        .map_err(|error| format!("Impossible de résoudre {}: {error}", path.display()))
}

pub fn find_source_cli(source_dir: &Path) -> Option<PathBuf> {
    SOURCE_CLI_CANDIDATES
        .iter()
        .map(|candidate| source_dir.join(candidate))
        .find(|candidate| is_regular_file(candidate))
        .and_then(|candidate| canonicalize(candidate).ok())
}

fn source_launch_spec(
    config: &RuntimeConfig,
    source_dir: &Path,
    managed: bool,
) -> Result<LaunchSpec, String> {
    let source_dir = canonical_directory(source_dir, "Le runtime source")?;
    let cli = match config.cli_path.as_deref() {
        Some(path) => canonical_regular_file(Path::new(path), "Le CLI Prime Agent")?,
        None => find_source_cli(&source_dir).ok_or_else(|| {
            format!(
                "Aucun cli.js compilé n’a été trouvé sous {}",
                source_dir.display()
            )
        })?,
    };
    if !cli.starts_with(&source_dir) {
        return Err(format!(
            "Le CLI {} doit rester dans le runtime source {}",
            cli.display(),
            source_dir.display()
        ));
    }
    let node = match config.node_path.as_deref() {
        Some(path) => canonical_regular_file(Path::new(path), "Node.js")?,
        None => {
            find_program("node").ok_or_else(|| "Node.js est introuvable dans PATH".to_string())?
        }
    };
    ensure_supported_node(&node)?;
    Ok(LaunchSpec::Source {
        node,
        cli,
        source_dir,
        managed,
    })
}

pub fn load_runtime_config(app: &AppHandle) -> Result<Option<RuntimeConfig>, String> {
    load_typed_json(&runtime_config_path(app)?)
}

pub fn persist_runtime_config(app: &AppHandle, config: &RuntimeConfig) -> Result<(), String> {
    save_typed_json(&runtime_config_path(app)?, config)
}

fn normalized_runtime_config(config: RuntimeConfig) -> Result<RuntimeConfig, String> {
    let executable_path = match config.executable_path {
        Some(path) if path.trim().is_empty() => {
            return Err("Le chemin de l’exécutable ne peut pas être vide".to_string())
        }
        Some(path) => Some(
            canonical_regular_file(Path::new(&path), "L’exécutable Prime Agent")?
                .to_string_lossy()
                .into_owned(),
        ),
        None => None,
    };

    let (source_dir, cli_path, node_path) = match config.source_dir {
        Some(path) if path.trim().is_empty() => {
            return Err("Le chemin du runtime source ne peut pas être vide".to_string())
        }
        Some(path) => {
            let source_dir = canonical_directory(Path::new(&path), "Le runtime source")?;
            let provisional = RuntimeConfig {
                source_dir: Some(source_dir.to_string_lossy().into_owned()),
                cli_path: config.cli_path.clone(),
                node_path: config.node_path.clone(),
                ..RuntimeConfig::default()
            };
            match source_launch_spec(&provisional, &source_dir, false)? {
                LaunchSpec::Source { node, cli, .. } => (
                    Some(source_dir.to_string_lossy().into_owned()),
                    Some(cli.to_string_lossy().into_owned()),
                    Some(node.to_string_lossy().into_owned()),
                ),
                LaunchSpec::Executable { .. } => unreachable!(),
            }
        }
        None => {
            if config.cli_path.is_some() || config.node_path.is_some() {
                return Err(
                    "sourceDir est requis lorsque cliPath ou nodePath est configuré".to_string(),
                );
            }
            (None, None, None)
        }
    };

    Ok(RuntimeConfig {
        executable_path,
        source_dir,
        node_path,
        cli_path,
        repository_url: config.repository_url,
        updated_at: Some(now_millis()),
    })
}

#[tauri::command]
pub async fn get_runtime_config(app: AppHandle) -> Result<RuntimeConfig, String> {
    crate::run_blocking(move || Ok(load_runtime_config(&app)?.unwrap_or_default())).await
}

#[tauri::command]
pub async fn save_runtime_config(
    app: AppHandle,
    config: RuntimeConfig,
    persistence: tauri::State<'_, PersistenceLock>,
) -> Result<RuntimeConfig, String> {
    let persistence = Arc::clone(&persistence.0);
    crate::run_blocking(move || {
        let config = normalized_runtime_config(config)?;
        let _guard = persistence.lock();
        persist_runtime_config(&app, &config)?;
        Ok(config)
    })
    .await
}

fn detection_from_spec(spec: &LaunchSpec, mut warnings: Vec<String>) -> PrimeAgentDetection {
    let version = match capture_launch_version(spec) {
        Ok(version) => Some(version),
        Err(error) => {
            let runtime_path = match spec {
                LaunchSpec::Executable { executable, .. } => executable,
                LaunchSpec::Source { cli, .. } => cli,
            };
            warnings.push(format!(
                "Le runtime Prime Agent détecté ({}) n’est pas utilisable: {error}",
                runtime_path.display()
            ));
            None
        }
    };
    let found = version.is_some();
    match spec {
        LaunchSpec::Executable { executable, .. } => PrimeAgentDetection {
            found,
            runtime_kind: Some("executable".to_string()),
            executable_path: Some(executable.to_string_lossy().into_owned()),
            source_dir: None,
            node_path: None,
            cli_path: None,
            version,
            managed: spec.managed(),
            warnings,
        },
        LaunchSpec::Source {
            node,
            cli,
            source_dir,
            ..
        } => PrimeAgentDetection {
            found,
            runtime_kind: Some("source".to_string()),
            executable_path: None,
            source_dir: Some(source_dir.to_string_lossy().into_owned()),
            node_path: Some(node.to_string_lossy().into_owned()),
            cli_path: Some(cli.to_string_lossy().into_owned()),
            version,
            managed: spec.managed(),
            warnings,
        },
    }
}

fn inspect_launch_candidate(
    spec: LaunchSpec,
    inspected_candidates: &mut HashSet<String>,
    warnings: &mut Vec<String>,
    broken_candidate: &mut Option<PrimeAgentDetection>,
) -> Option<(PrimeAgentDetection, LaunchSpec)> {
    let identity = match &spec {
        LaunchSpec::Executable { executable, .. } => {
            format!("executable:{}", executable.to_string_lossy())
        }
        LaunchSpec::Source { node, cli, .. } => {
            format!(
                "source:{}:{}",
                node.to_string_lossy(),
                cli.to_string_lossy()
            )
        }
    };
    #[cfg(windows)]
    let identity = identity.to_ascii_lowercase();
    if !inspected_candidates.insert(identity) {
        return None;
    }

    let detection = detection_from_spec(&spec, warnings.clone());
    *warnings = detection.warnings.clone();
    if detection.found {
        Some((detection, spec))
    } else {
        if broken_candidate.is_none() {
            *broken_candidate = Some(detection);
        }
        None
    }
}

pub fn detect_internal(
    app: &AppHandle,
) -> Result<(PrimeAgentDetection, Option<LaunchSpec>), String> {
    let mut warnings = Vec::new();
    let mut broken_candidate = None;
    let mut inspected_candidates = HashSet::new();
    match load_runtime_config(app) {
        Ok(Some(config)) => {
            if let Some(path) = config.executable_path.as_deref() {
                match canonical_regular_file(Path::new(path), "L’exécutable configuré") {
                    Ok(executable) => {
                        let spec = LaunchSpec::Executable {
                            executable,
                            managed: false,
                        };
                        if let Some((detection, spec)) = inspect_launch_candidate(
                            spec,
                            &mut inspected_candidates,
                            &mut warnings,
                            &mut broken_candidate,
                        ) {
                            return Ok((detection, Some(spec)));
                        }
                    }
                    Err(error) => warnings.push(error),
                }
            }
            if let Some(source_dir) = config.source_dir.as_deref() {
                let configured_source = Path::new(source_dir);
                let managed = managed_source_dir(app)
                    .ok()
                    .and_then(|path| canonicalize(path).ok())
                    .zip(canonicalize(configured_source).ok())
                    .map(|(expected, actual)| expected == actual)
                    .unwrap_or(false);
                match source_launch_spec(&config, configured_source, managed) {
                    Ok(spec) => {
                        if let Some((detection, spec)) = inspect_launch_candidate(
                            spec,
                            &mut inspected_candidates,
                            &mut warnings,
                            &mut broken_candidate,
                        ) {
                            return Ok((detection, Some(spec)));
                        }
                    }
                    Err(error) => warnings.push(error),
                }
            }
        }
        Ok(None) => {}
        Err(error) => warnings.push(error),
    }

    if let Some(executable) = find_program("prime-agent") {
        let spec = LaunchSpec::Executable {
            executable,
            managed: false,
        };
        if let Some((detection, spec)) = inspect_launch_candidate(
            spec,
            &mut inspected_candidates,
            &mut warnings,
            &mut broken_candidate,
        ) {
            return Ok((detection, Some(spec)));
        }
    }

    let managed_source = managed_source_dir(app)?;
    if managed_source.exists() {
        let config = RuntimeConfig::default();
        match source_launch_spec(&config, &managed_source, true) {
            Ok(spec) => {
                if let Some((detection, spec)) = inspect_launch_candidate(
                    spec,
                    &mut inspected_candidates,
                    &mut warnings,
                    &mut broken_candidate,
                ) {
                    return Ok((detection, Some(spec)));
                }
            }
            Err(error) => warnings.push(error),
        }
    }

    if let Some(mut detection) = broken_candidate {
        detection.warnings = warnings;
        return Ok((detection, None));
    }

    Ok((
        PrimeAgentDetection {
            found: false,
            runtime_kind: None,
            executable_path: None,
            source_dir: None,
            node_path: None,
            cli_path: None,
            version: None,
            managed: false,
            warnings,
        },
        None,
    ))
}

#[tauri::command]
pub async fn detect_prime_agent(app: AppHandle) -> Result<PrimeAgentDetection, String> {
    crate::run_blocking(move || detect_internal(&app).map(|(detection, _)| detection)).await
}

fn terminal_cwd(cwd: String) -> Result<PathBuf, String> {
    let path = PathBuf::from(cwd);
    if !path.is_absolute() {
        return Err("Le dossier du terminal doit être un chemin absolu".to_string());
    }
    let metadata = fs::metadata(&path)
        .map_err(|error| format!("Le dossier {} est inaccessible: {error}", path.display()))?;
    if !metadata.is_dir() {
        return Err(format!("{} n’est pas un dossier", path.display()));
    }
    canonicalize(&path)
        .map_err(|error| format!("Impossible de résoudre {}: {error}", path.display()))
}

#[cfg(windows)]
fn open_terminal_for_spec(cwd: &Path, spec: &LaunchSpec) -> Result<(), String> {
    let powershell = find_program("powershell")
        .or_else(|| find_program("pwsh"))
        .ok_or_else(|| "PowerShell est introuvable".to_string())?;
    const SCRIPT: &str = r#"
$ErrorActionPreference = 'Stop'
$terminal = (Get-Process -Id $PID).Path
if ($env:PRIME_ORBIT_TERMINAL_RUNTIME_KIND -eq 'source') {
  $launch = '& $env:PRIME_ORBIT_TERMINAL_NODE $env:PRIME_ORBIT_TERMINAL_CLI'
} else {
  $launch = '& $env:PRIME_ORBIT_TERMINAL_EXECUTABLE'
}
Start-Process -FilePath $terminal -WorkingDirectory $env:PRIME_ORBIT_TERMINAL_CWD -WindowStyle Normal -ArgumentList @('-NoExit', '-NoLogo', '-NoProfile', '-Command', $launch) | Out-Null
"#;
    let mut command = Command::new(powershell);
    command
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            SCRIPT,
        ])
        .env("PRIME_ORBIT_TERMINAL_CWD", cwd);
    match spec {
        LaunchSpec::Executable { executable, .. } => {
            command
                .env("PRIME_ORBIT_TERMINAL_RUNTIME_KIND", "executable")
                .env("PRIME_ORBIT_TERMINAL_EXECUTABLE", executable);
        }
        LaunchSpec::Source { node, cli, .. } => {
            command
                .env("PRIME_ORBIT_TERMINAL_RUNTIME_KIND", "source")
                .env("PRIME_ORBIT_TERMINAL_NODE", node)
                .env("PRIME_ORBIT_TERMINAL_CLI", cli);
        }
    }
    let output = capture_command_output(&mut command)?;
    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "PowerShell n’a pas pu ouvrir le terminal: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    }
}

#[cfg(target_os = "macos")]
fn open_terminal_for_spec(cwd: &Path, spec: &LaunchSpec) -> Result<(), String> {
    let osascript = find_program("osascript")
        .ok_or_else(|| "osascript est introuvable; impossible d’ouvrir Terminal".to_string())?;
    const SCRIPT: &str = r#"
on run argv
  set runtimeKind to item 1 of argv
  set workingDirectory to item 2 of argv
  set runtimeExecutable to item 3 of argv
  set commandText to "cd " & quoted form of workingDirectory & " && " & quoted form of runtimeExecutable
  if runtimeKind is "source" then
    set commandText to commandText & " " & quoted form of (item 4 of argv)
  end if
  tell application "Terminal"
    activate
    do script commandText
  end tell
end run
"#;
    let (kind, executable, cli) = match spec {
        LaunchSpec::Executable { executable, .. } => ("executable", executable, None),
        LaunchSpec::Source { node, cli, .. } => ("source", node, Some(cli)),
    };
    let mut arguments = vec![
        OsString::from("-e"),
        OsString::from(SCRIPT),
        OsString::from("--"),
        OsString::from(kind),
        cwd.as_os_str().to_owned(),
        executable.as_os_str().to_owned(),
    ];
    if let Some(cli) = cli {
        arguments.push(cli.as_os_str().to_owned());
    }
    let mut command = external_command(&osascript, &arguments);
    let output = capture_command_output(&mut command)?;
    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "Terminal n’a pas pu être ouvert: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
fn open_terminal_for_spec(cwd: &Path, spec: &LaunchSpec) -> Result<(), String> {
    let (runtime, runtime_arguments): (&Path, Vec<OsString>) = match spec {
        LaunchSpec::Executable { executable, .. } => (executable, Vec::new()),
        LaunchSpec::Source { node, cli, .. } => (node, vec![cli.as_os_str().to_owned()]),
    };

    let candidates = [
        "x-terminal-emulator",
        "gnome-terminal",
        "konsole",
        "xfce4-terminal",
        "xterm",
    ];
    for name in candidates {
        let Some(terminal) = find_program(name) else {
            continue;
        };
        let mut command = Command::new(terminal);
        command
            .current_dir(cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        match name {
            "gnome-terminal" => {
                command
                    .arg("--working-directory")
                    .arg(cwd)
                    .arg("--")
                    .arg(runtime)
                    .args(&runtime_arguments);
            }
            "konsole" => {
                command
                    .arg("--workdir")
                    .arg(cwd)
                    .arg("-e")
                    .arg(runtime)
                    .args(&runtime_arguments);
            }
            "xfce4-terminal" => {
                command
                    .arg("--working-directory")
                    .arg(cwd)
                    .arg("-x")
                    .arg(runtime)
                    .args(&runtime_arguments);
            }
            _ => {
                command.arg("-e").arg(runtime).args(&runtime_arguments);
            }
        }
        if command.spawn().is_ok() {
            return Ok(());
        }
    }
    Err(
        "Aucun terminal compatible n’a été trouvé (x-terminal-emulator, GNOME Terminal, Konsole, XFCE Terminal ou xterm)"
            .to_string(),
    )
}

#[tauri::command]
pub async fn open_prime_agent_terminal(
    app: AppHandle,
    cwd: String,
) -> Result<TerminalLaunchResult, String> {
    crate::run_blocking(move || {
        let cwd = terminal_cwd(cwd)?;
        let (detection, spec) = detect_internal(&app)?;
        let spec = spec.ok_or_else(|| {
            if detection.warnings.is_empty() {
                "Prime Agent est introuvable".to_string()
            } else {
                format!(
                    "Prime Agent est introuvable: {}",
                    detection.warnings.join("; ")
                )
            }
        })?;
        let runtime_kind = match &spec {
            LaunchSpec::Executable { .. } => "executable",
            LaunchSpec::Source { .. } => "source",
        };
        open_terminal_for_spec(&cwd, &spec)?;
        Ok(TerminalLaunchResult {
            opened: true,
            cwd: cwd.to_string_lossy().into_owned(),
            runtime_kind: runtime_kind.to_string(),
        })
    })
    .await
}

#[tauri::command]
pub async fn diagnose_prerequisites(app: AppHandle) -> Result<PrerequisiteDiagnostics, String> {
    crate::run_blocking(move || {
        let (prime_agent, _) = detect_internal(&app)?;
        let git = program_diagnostic("git", "Git", true, None);
        let npm = program_diagnostic("npm", "npm", true, None);
        let node = program_diagnostic("node", "Node.js 22.8+", true, Some((22, 8)));
        let bash = program_diagnostic("bash", "Bash", cfg!(windows), None);
        let can_quick_install =
            git.found && npm.found && node.found && (!cfg!(windows) || bash.found);
        let ready = prime_agent.found || can_quick_install;
        Ok(PrerequisiteDiagnostics {
            ready,
            can_quick_install,
            prime_agent,
            items: vec![git, node, npm, bash],
        })
    })
    .await
}

fn program_diagnostic(
    name: &str,
    label: &str,
    required_for_install: bool,
    minimum_version: Option<(u64, u64)>,
) -> PrerequisiteDiagnostic {
    let Some(path) = find_program(name) else {
        return PrerequisiteDiagnostic {
            id: name.to_string(),
            label: label.to_string(),
            required_for_install,
            found: false,
            path: None,
            version: None,
            message: format!("{label} est introuvable dans PATH"),
        };
    };
    let version_result = capture_program_version(&path, label);
    let version = version_result.as_ref().ok().cloned();
    let meets_minimum = minimum_version
        .map(|minimum| {
            version
                .as_deref()
                .and_then(parse_semver_prefix)
                .map(|actual| actual >= minimum)
                .unwrap_or(false)
        })
        .unwrap_or_else(|| version_result.is_ok());
    let message = if let Err(error) = version_result {
        error
    } else if meets_minimum {
        format!("{label} est disponible")
    } else if let Some((major, minor)) = minimum_version {
        format!("{label} doit être en version {major}.{minor} ou ultérieure")
    } else {
        format!("Version de {label} non reconnue")
    };
    PrerequisiteDiagnostic {
        id: name.to_string(),
        label: label.to_string(),
        required_for_install,
        found: meets_minimum,
        path: Some(path.to_string_lossy().into_owned()),
        version,
        message,
    }
}

fn parse_semver_prefix(value: &str) -> Option<(u64, u64)> {
    let start = value.find(|character: char| character.is_ascii_digit())?;
    let mut parts =
        value[start..].split(|character: char| !character.is_ascii_digit() && character != '.');
    let version = parts.next()?;
    let mut numbers = version.split('.');
    Some((numbers.next()?.parse().ok()?, numbers.next()?.parse().ok()?))
}

fn capture_launch_version(spec: &LaunchSpec) -> Result<String, String> {
    let arguments = vec![OsString::from("--version")];
    let mut command = spec.command(&arguments);
    capture_command_output_with_timeout(
        &mut command,
        STARTUP_COMMAND_TIMEOUT,
        "Prime Agent (--version)",
    )
    .and_then(output_version)
}

fn capture_program_version(path: &Path, label: &str) -> Result<String, String> {
    let mut command = external_command(path, &[OsString::from("--version")]);
    capture_command_output_with_timeout(
        &mut command,
        STARTUP_COMMAND_TIMEOUT,
        &format!("{label} (--version)"),
    )
    .and_then(output_version)
}

pub fn ensure_supported_node(path: &Path) -> Result<String, String> {
    let version = capture_program_version(path, "Node.js")?;
    let actual = parse_semver_prefix(&version)
        .ok_or_else(|| format!("Version Node.js non reconnue: {version}"))?;
    if actual < (22, 8) {
        return Err(format!(
            "Prime Agent requiert Node.js 22.8 ou ultérieur; version détectée: {version}"
        ));
    }
    Ok(version)
}

fn output_version(output: Output) -> Result<String, String> {
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let version_output = if !stdout.trim().is_empty() {
        stdout.as_ref()
    } else {
        stderr.as_ref()
    };
    let version = version_output.lines().next().unwrap_or_default().trim();
    if output.status.success() && !version.is_empty() {
        Ok(version.to_string())
    } else {
        let details = [stdout.trim(), stderr.trim()]
            .into_iter()
            .filter(|value| !value.is_empty())
            .collect::<Vec<_>>()
            .join("\n");
        Err(format!(
            "La commande de version a échoué avec le statut {}: {}",
            output.status, details
        ))
    }
}

pub fn capture_command_output(command: &mut Command) -> Result<Output, String> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_secondary_console(command);
    command
        .output()
        .map_err(|error| format!("Impossible de lancer la commande: {error}"))
}

fn capture_command_output_with_timeout(
    command: &mut Command,
    timeout: Duration,
    description: &str,
) -> Result<Output, String> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_secondary_console(command);
    prepare_timed_command(command);

    let mut child = command
        .spawn()
        .map_err(|error| format!("Impossible de lancer {description}: {error}"))?;
    #[cfg(windows)]
    let command_job = WindowsCommandJob::attach(&child);

    let Some(stdout) = child.stdout.take() else {
        #[cfg(unix)]
        terminate_timed_command(&mut child);
        #[cfg(windows)]
        terminate_timed_command(&mut child, command_job.as_ref());
        return Err(format!("Impossible de lire la sortie de {description}"));
    };
    let Some(stderr) = child.stderr.take() else {
        #[cfg(unix)]
        terminate_timed_command(&mut child);
        #[cfg(windows)]
        terminate_timed_command(&mut child, command_job.as_ref());
        return Err(format!("Impossible de lire les erreurs de {description}"));
    };
    let stdout_reader = thread::spawn(move || read_command_stream(stdout));
    let stderr_reader = thread::spawn(move || read_command_stream(stderr));

    let started_at = Instant::now();
    let mut exit_status: Option<ExitStatus> = None;
    loop {
        if exit_status.is_none() {
            match child.try_wait() {
                Ok(status) => exit_status = status,
                Err(error) => {
                    #[cfg(unix)]
                    terminate_timed_command(&mut child);
                    #[cfg(windows)]
                    terminate_timed_command(&mut child, command_job.as_ref());
                    return Err(format!(
                        "Impossible d’attendre la fin de {description}: {error}"
                    ));
                }
            }
        }

        if let Some(status) = exit_status {
            if stdout_reader.is_finished() && stderr_reader.is_finished() {
                let stdout = join_command_reader(stdout_reader, description, "standard")?;
                let stderr = join_command_reader(stderr_reader, description, "d’erreur")?;
                return Ok(Output {
                    status,
                    stdout,
                    stderr,
                });
            }
        }

        if started_at.elapsed() >= timeout {
            #[cfg(unix)]
            terminate_timed_command(&mut child);
            #[cfg(windows)]
            terminate_timed_command(&mut child, command_job.as_ref());
            wait_for_command_readers(&stdout_reader, &stderr_reader, COMMAND_TERMINATION_GRACE);
            return Err(format!(
                "La vérification {description} a dépassé {} secondes et a été interrompue. Vérifiez que la commande répond correctement dans un terminal.",
                timeout.as_secs()
            ));
        }

        thread::sleep(COMMAND_POLL_INTERVAL);
    }
}

fn read_command_stream(mut stream: impl Read) -> std::io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    stream.read_to_end(&mut bytes)?;
    Ok(bytes)
}

fn join_command_reader(
    reader: thread::JoinHandle<std::io::Result<Vec<u8>>>,
    description: &str,
    stream_label: &str,
) -> Result<Vec<u8>, String> {
    reader
        .join()
        .map_err(|_| format!("La lecture de la sortie {stream_label} de {description} a échoué"))?
        .map_err(|error| {
            format!("Impossible de lire la sortie {stream_label} de {description}: {error}")
        })
}

fn wait_for_command_readers(
    stdout_reader: &thread::JoinHandle<std::io::Result<Vec<u8>>>,
    stderr_reader: &thread::JoinHandle<std::io::Result<Vec<u8>>>,
    grace: Duration,
) {
    let deadline = Instant::now() + grace;
    while (!stdout_reader.is_finished() || !stderr_reader.is_finished())
        && Instant::now() < deadline
    {
        thread::sleep(COMMAND_POLL_INTERVAL);
    }
}

#[cfg(unix)]
fn prepare_timed_command(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    command.process_group(0);
}

#[cfg(windows)]
fn prepare_timed_command(_command: &mut Command) {}

#[cfg(unix)]
fn terminate_timed_command(child: &mut Child) {
    const SIGKILL: i32 = 9;
    extern "C" {
        fn kill(pid: i32, signal: i32) -> i32;
    }

    if let Ok(process_group) = i32::try_from(child.id()) {
        // Timed commands are started in their own process group, so this also
        // terminates wrappers (shell scripts) and any descendants they spawned.
        unsafe {
            let _ = kill(-process_group, SIGKILL);
        }
    }
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(windows)]
fn terminate_timed_command(child: &mut Child, job: Option<&WindowsCommandJob>) {
    let terminated_job = job.map(WindowsCommandJob::terminate).unwrap_or(false);
    if !terminated_job {
        terminate_windows_process_tree(child.id());
    }
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(windows)]
fn terminate_windows_process_tree(process_id: u32) {
    let taskkill = std::env::var_os("WINDIR")
        .map(PathBuf::from)
        .map(|root| root.join("System32").join("taskkill.exe"))
        .filter(|candidate| is_regular_file(candidate))
        .unwrap_or_else(|| PathBuf::from("taskkill.exe"));
    let mut command = Command::new(taskkill);
    command
        .args(["/PID", &process_id.to_string(), "/T", "/F"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    hide_secondary_console(&mut command);
    let Ok(mut taskkill_child) = command.spawn() else {
        return;
    };
    let deadline = Instant::now() + COMMAND_TERMINATION_GRACE;
    while Instant::now() < deadline {
        match taskkill_child.try_wait() {
            Ok(Some(_)) => return,
            Ok(None) => thread::sleep(COMMAND_POLL_INTERVAL),
            Err(_) => break,
        }
    }
    let _ = taskkill_child.kill();
    let _ = taskkill_child.wait();
}

#[cfg(windows)]
struct WindowsCommandJob(windows_sys::Win32::Foundation::HANDLE);

#[cfg(windows)]
impl WindowsCommandJob {
    fn attach(child: &Child) -> Option<Self> {
        use std::{ffi::c_void, mem, os::windows::io::AsRawHandle, ptr};
        use windows_sys::Win32::{
            Foundation::CloseHandle,
            System::JobObjects::{
                AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
                SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            },
        };

        unsafe {
            let handle = CreateJobObjectW(ptr::null(), ptr::null());
            if handle.is_null() {
                return None;
            }
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = mem::zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast::<c_void>(),
                mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            ) == 0
                || AssignProcessToJobObject(handle, child.as_raw_handle()) == 0
            {
                let _ = CloseHandle(handle);
                return None;
            }
            Some(Self(handle))
        }
    }

    fn terminate(&self) -> bool {
        use windows_sys::Win32::System::JobObjects::TerminateJobObject;
        unsafe { TerminateJobObject(self.0, 1) != 0 }
    }
}

#[cfg(windows)]
impl Drop for WindowsCommandJob {
    fn drop(&mut self) {
        use windows_sys::Win32::Foundation::CloseHandle;
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

pub fn find_program(name: &str) -> Option<PathBuf> {
    let requested = Path::new(name);
    if requested.components().count() > 1 {
        return is_regular_file(requested)
            .then(|| canonicalize(requested).ok())
            .flatten();
    }

    let path = std::env::var_os("PATH")?;
    #[cfg(windows)]
    let extensions: Vec<OsString> = {
        let path_has_extension = requested.extension().is_some();
        if path_has_extension {
            vec![OsString::new()]
        } else {
            let configured = std::env::var_os("PATHEXT")
                .unwrap_or_else(|| OsString::from(".COM;.EXE;.BAT;.CMD"));
            let mut values: Vec<OsString> = configured
                .to_string_lossy()
                .split(';')
                .filter(|value| !value.is_empty())
                .map(OsString::from)
                .collect();
            values.push(OsString::new());
            values
        }
    };

    for directory in std::env::split_paths(&path) {
        #[cfg(windows)]
        for extension in &extensions {
            let mut file_name = OsString::from(name);
            file_name.push(extension);
            let candidate = directory.join(file_name);
            if is_regular_file(&candidate) {
                if let Ok(canonical) = canonicalize(&candidate) {
                    return Some(canonical);
                }
            }
        }

        #[cfg(not(windows))]
        {
            use std::os::unix::fs::PermissionsExt;
            let candidate = directory.join(name);
            if let Ok(metadata) = fs::metadata(&candidate) {
                if metadata.is_file() && metadata.permissions().mode() & 0o111 != 0 {
                    if let Ok(canonical) = canonicalize(&candidate) {
                        return Some(canonical);
                    }
                }
            }
        }
    }
    None
}

pub fn external_command(program: &Path, arguments: &[OsString]) -> Command {
    #[cfg(windows)]
    {
        let extension = program
            .extension()
            .and_then(OsStr::to_str)
            .unwrap_or_default();
        if extension.eq_ignore_ascii_case("cmd") || extension.eq_ignore_ascii_case("bat") {
            use std::os::windows::process::CommandExt;

            let command_processor =
                std::env::var_os("COMSPEC").unwrap_or_else(|| OsString::from("cmd.exe"));
            let mut command = Command::new(command_processor);
            command.env("PRIME_ORBIT_CMD_PROGRAM", program);
            let mut tokens = Vec::with_capacity(arguments.len() + 1);
            tokens.push("\"%PRIME_ORBIT_CMD_PROGRAM%\"".to_string());
            for (index, argument) in arguments.iter().enumerate() {
                let name = format!("PRIME_ORBIT_CMD_ARG_{index}");
                command.env(&name, argument);
                tokens.push(format!("\"%{name}%\""));
            }
            // Values travel through the child-only environment rather than
            // being concatenated into executable command text. Delayed
            // expansion is disabled, preserving exclamation marks as data.
            let invocation = format!("/D /S /V:OFF /C \"{}\"", tokens.join(" "));
            command.raw_arg(invocation);
            hide_secondary_console(&mut command);
            return command;
        }
    }

    let mut command = Command::new(program);
    command.args(arguments);
    hide_secondary_console(&mut command);
    command
}

pub fn hide_secondary_console(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    let _ = command;
}

#[cfg(test)]
mod tests {
    #[cfg(windows)]
    use super::{capture_command_output, external_command, find_program};
    use super::{
        capture_command_output_with_timeout, detection_from_spec, inspect_launch_candidate,
        parse_semver_prefix, LaunchSpec,
    };
    #[cfg(windows)]
    use std::ffi::OsString;
    use std::{collections::HashSet, fs, path::PathBuf, process::Command, time::Duration};

    fn runtime_test_program(
        directory: &std::path::Path,
        name: &str,
        version: Option<&str>,
    ) -> PathBuf {
        #[cfg(windows)]
        {
            let path = directory.join(format!("{name}.cmd"));
            let contents = match version {
                Some(version) => format!("@echo off\r\necho {version}\r\n"),
                None => "@echo off\r\necho loading Prime Agent\r\n>&2 echo Error [ERR_MODULE_NOT_FOUND]: missing @earendil-works/pi-agent-core\r\nexit /b 1\r\n".to_string(),
            };
            fs::write(&path, contents).expect("test runtime should be writable");
            path
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            let path = directory.join(name);
            let contents = match version {
                Some(version) => format!("#!/bin/sh\nprintf '%s\\n' '{version}'\n"),
                None => "#!/bin/sh\nprintf '%s\\n' 'loading Prime Agent'\nprintf '%s\\n' 'Error [ERR_MODULE_NOT_FOUND]: missing @earendil-works/pi-agent-core' >&2\nexit 1\n".to_string(),
            };
            fs::write(&path, contents).expect("test runtime should be writable");
            let mut permissions = fs::metadata(&path).unwrap().permissions();
            permissions.set_mode(0o700);
            fs::set_permissions(&path, permissions).unwrap();
            path
        }
    }

    #[test]
    fn parses_node_and_plain_semver_prefixes() {
        assert_eq!(parse_semver_prefix("v22.8.0"), Some((22, 8)));
        assert_eq!(parse_semver_prefix("node 24.3.1"), Some((24, 3)));
        assert_eq!(parse_semver_prefix("unknown"), None);
    }

    #[test]
    fn interrupts_timed_out_command() {
        #[cfg(windows)]
        let mut command = {
            let mut command = Command::new("cmd.exe");
            command.args(["/D", "/S", "/C", "ping -n 6 127.0.0.1 >NUL"]);
            command
        };
        #[cfg(unix)]
        let mut command = {
            let mut command = Command::new("sh");
            command.args(["-c", "sleep 5"]);
            command
        };

        let error = capture_command_output_with_timeout(
            &mut command,
            Duration::from_millis(100),
            "commande de test",
        )
        .expect_err("the command should time out");
        assert!(error.contains("dépassé"), "unexpected error: {error}");
        assert!(error.contains("interrompue"), "unexpected error: {error}");
    }

    #[test]
    fn rejects_a_detected_runtime_when_version_command_fails() {
        let directory = tempfile::tempdir().unwrap();
        let executable = runtime_test_program(directory.path(), "broken-prime-agent", None);
        let spec = LaunchSpec::Executable {
            executable: executable.clone(),
            managed: false,
        };

        let detection = detection_from_spec(&spec, Vec::new());

        assert!(!detection.found);
        assert_eq!(detection.version, None);
        assert_eq!(
            detection.executable_path.as_deref(),
            Some(executable.to_string_lossy().as_ref())
        );
        assert!(
            detection
                .warnings
                .iter()
                .any(|warning| warning.contains("ERR_MODULE_NOT_FOUND")
                    && warning.contains("pi-agent-core")),
            "the actionable runtime failure should be preserved: {:?}",
            detection.warnings
        );
    }

    #[test]
    fn skips_a_broken_candidate_and_accepts_the_next_healthy_runtime() {
        let directory = tempfile::tempdir().unwrap();
        let broken = LaunchSpec::Executable {
            executable: runtime_test_program(directory.path(), "broken-prime-agent", None),
            managed: false,
        };
        let healthy = LaunchSpec::Executable {
            executable: runtime_test_program(
                directory.path(),
                "healthy-prime-agent",
                Some("prime-agent 0.9.4"),
            ),
            managed: true,
        };
        let mut inspected_candidates = HashSet::new();
        let mut warnings = Vec::new();
        let mut broken_candidate = None;

        assert!(inspect_launch_candidate(
            broken,
            &mut inspected_candidates,
            &mut warnings,
            &mut broken_candidate
        )
        .is_none());
        let (detection, selected) = inspect_launch_candidate(
            healthy,
            &mut inspected_candidates,
            &mut warnings,
            &mut broken_candidate,
        )
        .expect("the healthy fallback should be selected");

        assert!(detection.found);
        assert_eq!(detection.version.as_deref(), Some("prime-agent 0.9.4"));
        assert!(detection.managed);
        assert!(selected.managed());
        assert!(broken_candidate.is_some());
        assert!(detection
            .warnings
            .iter()
            .any(|warning| warning.contains("ERR_MODULE_NOT_FOUND")));
    }

    #[test]
    fn probes_the_same_runtime_path_only_once() {
        let directory = tempfile::tempdir().unwrap();
        let broken = LaunchSpec::Executable {
            executable: runtime_test_program(directory.path(), "broken-prime-agent", None),
            managed: false,
        };
        let mut inspected_candidates = HashSet::new();
        let mut warnings = Vec::new();
        let mut broken_candidate = None;

        assert!(inspect_launch_candidate(
            broken.clone(),
            &mut inspected_candidates,
            &mut warnings,
            &mut broken_candidate,
        )
        .is_none());
        let warning_count = warnings.len();
        assert!(inspect_launch_candidate(
            broken,
            &mut inspected_candidates,
            &mut warnings,
            &mut broken_candidate,
        )
        .is_none());

        assert_eq!(warnings.len(), warning_count);
        assert_eq!(inspected_candidates.len(), 1);
    }

    #[cfg(windows)]
    #[test]
    fn executes_windows_command_shims() {
        let Some(npm) = find_program("npm") else {
            return;
        };
        let mut command = external_command(&npm, &[OsString::from("--version")]);
        let output = capture_command_output(&mut command).expect("npm shim should start");
        assert!(
            output.status.success(),
            "npm shim failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(!output.stdout.is_empty());
    }
}
