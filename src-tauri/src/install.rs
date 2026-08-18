use crate::{
    paths::canonicalize,
    runtime::{
        capture_command_output, ensure_supported_node, external_command, find_program,
        find_source_cli, managed_runtime_root, now_millis, persist_runtime_config, RuntimeConfig,
        OFFICIAL_REPOSITORY_URL,
    },
    storage::PersistenceLock,
};
use serde::Serialize;
use std::{
    ffi::OsString,
    fs,
    io::{BufRead, BufReader, Read},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread,
};
use tauri::{AppHandle, Emitter, Manager};

pub struct InstallState(pub Arc<AtomicBool>);

impl Default for InstallState {
    fn default() -> Self {
        Self(Arc::new(AtomicBool::new(false)))
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickInstallStarted {
    pub started: bool,
    pub source_dir: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct InstallProgressEvent {
    stage: String,
    message: String,
    percent: Option<u8>,
    stream: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct InstallCompleteEvent {
    success: bool,
    source_dir: String,
    cli_path: Option<String>,
    error: Option<String>,
}

fn emit_progress(
    app: &AppHandle,
    stage: &str,
    message: impl Into<String>,
    percent: Option<u8>,
    stream: Option<&str>,
) {
    let _ = app.emit(
        "prime-agent://install-progress",
        InstallProgressEvent {
            stage: stage.to_string(),
            message: message.into(),
            percent,
            stream: stream.map(str::to_string),
        },
    );
}

fn stream_command_output<R: Read>(reader: R, app: AppHandle, stage: String, stream: &'static str) {
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
                let line = String::from_utf8_lossy(&record).trim().to_string();
                if !line.is_empty() {
                    emit_progress(&app, &stage, line, None, Some(stream));
                }
            }
            Err(error) => {
                emit_progress(
                    &app,
                    &stage,
                    format!("Erreur de lecture de {stream}: {error}"),
                    None,
                    Some("stderr"),
                );
                break;
            }
        }
    }
}

fn run_streaming(
    app: &AppHandle,
    stage: &str,
    mut command: Command,
    cwd: &Path,
) -> Result<(), String> {
    command
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|error| format!("Impossible de lancer l’étape {stage}: {error}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| format!("L’étape {stage} n’a pas fourni stdout"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| format!("L’étape {stage} n’a pas fourni stderr"))?;
    let stdout_app = app.clone();
    let stderr_app = app.clone();
    let stdout_stage = stage.to_string();
    let stderr_stage = stage.to_string();
    let stdout_thread =
        thread::spawn(move || stream_command_output(stdout, stdout_app, stdout_stage, "stdout"));
    let stderr_thread =
        thread::spawn(move || stream_command_output(stderr, stderr_app, stderr_stage, "stderr"));
    let status = child
        .wait()
        .map_err(|error| format!("Impossible d’attendre l’étape {stage}: {error}"))?;
    let _ = stdout_thread.join();
    let _ = stderr_thread.join();
    if status.success() {
        Ok(())
    } else {
        Err(format!("L’étape {stage} a échoué avec le statut {status}"))
    }
}

fn normalized_repository_url(value: &str) -> String {
    value
        .trim()
        .trim_end_matches('/')
        .trim_end_matches(".git")
        .replace("git@github.com:", "https://github.com/")
        .to_ascii_lowercase()
}

fn git_text(git: &Path, source_dir: &Path, arguments: &[&str]) -> Result<String, String> {
    let mut command_arguments = vec![OsString::from("-C"), source_dir.as_os_str().to_owned()];
    command_arguments.extend(arguments.iter().map(OsString::from));
    let mut command = external_command(git, &command_arguments);
    let output = capture_command_output(&mut command)?;
    if !output.status.success() {
        return Err(format!(
            "Git {} a échoué dans {}: {}",
            arguments.join(" "),
            source_dir.display(),
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn verify_official_repository(git: &Path, source_dir: &Path) -> Result<(), String> {
    let actual = git_text(git, source_dir, &["remote", "get-url", "origin"])?;
    if normalized_repository_url(&actual) != normalized_repository_url(OFFICIAL_REPOSITORY_URL) {
        return Err(format!(
            "Le dossier géré {} pointe vers une origine non officielle ({actual}). Il ne sera pas modifié.",
            source_dir.display()
        ));
    }
    Ok(())
}

fn validated_install_paths(app: &AppHandle) -> Result<(PathBuf, PathBuf), String> {
    let app_data = crate::storage::app_data_dir(app)?;
    let runtime_root = managed_runtime_root(app)?;
    if !runtime_root.exists() {
        fs::create_dir(&runtime_root).map_err(|error| {
            format!(
                "Impossible de créer le dossier runtime {}: {error}",
                runtime_root.display()
            )
        })?;
    }
    let runtime_root = canonicalize(&runtime_root).map_err(|error| {
        format!(
            "Impossible de résoudre le dossier runtime {}: {error}",
            runtime_root.display()
        )
    })?;
    if !runtime_root.starts_with(&app_data) {
        return Err(format!(
            "Le dossier runtime {} sort du stockage géré {}",
            runtime_root.display(),
            app_data.display()
        ));
    }
    let source_dir = runtime_root.join("prime-agent");
    if source_dir.exists() {
        let link_metadata = fs::symlink_metadata(&source_dir).map_err(|error| {
            format!(
                "Impossible d’inspecter le runtime {}: {error}",
                source_dir.display()
            )
        })?;
        if link_metadata.file_type().is_symlink() || !link_metadata.is_dir() {
            return Err(format!(
                "Le runtime géré {} doit être un dossier réel non symbolique",
                source_dir.display()
            ));
        }
        let canonical = canonicalize(&source_dir).map_err(|error| {
            format!(
                "Impossible de résoudre le runtime {}: {error}",
                source_dir.display()
            )
        })?;
        if !canonical.starts_with(&runtime_root)
            || canonical.parent() != Some(runtime_root.as_path())
        {
            return Err(format!(
                "La cible runtime {} ne correspond pas exactement au dossier géré attendu",
                canonical.display()
            ));
        }
        return Ok((runtime_root, canonical));
    }
    Ok((runtime_root, source_dir))
}

fn perform_install(app: &AppHandle, source_dir: &Path) -> Result<PathBuf, String> {
    let git = find_program("git").ok_or_else(|| "Git est introuvable dans PATH".to_string())?;
    let node =
        find_program("node").ok_or_else(|| "Node.js est introuvable dans PATH".to_string())?;
    ensure_supported_node(&node)?;
    let npm = find_program("npm").ok_or_else(|| "npm est introuvable dans PATH".to_string())?;
    #[cfg(windows)]
    find_program("bash").ok_or_else(|| {
        "Bash est requis par Prime Agent sous Windows (Git Bash, MSYS2/Cygwin ou WSL)".to_string()
    })?;
    let runtime_root = source_dir
        .parent()
        .ok_or_else(|| "La cible du runtime n’a pas de dossier parent".to_string())?;

    emit_progress(
        app,
        "prerequisites",
        "Git, Node.js et npm sont disponibles",
        Some(8),
        None,
    );

    if source_dir.exists() {
        let git_metadata = fs::symlink_metadata(source_dir.join(".git")).map_err(|error| {
            format!(
                "Le dossier {} existe mais n’est pas un clone Git exploitable: {error}. Aucun fichier n’a été supprimé.",
                source_dir.display()
            )
        })?;
        if git_metadata.file_type().is_symlink() || !git_metadata.is_dir() {
            return Err(format!(
                "{} existe mais .git n’est pas un dossier réel non symbolique. Aucun fichier n’a été supprimé.",
                source_dir.display()
            ));
        }
        verify_official_repository(&git, source_dir)?;
        let branch = git_text(&git, source_dir, &["branch", "--show-current"])?;
        if branch != "main" {
            return Err(format!(
                "Le runtime géré est sur la branche {branch:?}, pas sur main. Il ne sera pas modifié."
            ));
        }
        let tracked_changes = git_text(
            &git,
            source_dir,
            &["status", "--porcelain", "--untracked-files=no"],
        )?;
        if !tracked_changes.is_empty() {
            return Err(
                "Le runtime géré contient des modifications suivies. L’installation refuse de les écraser; aucun fichier n’a été supprimé."
                    .to_string(),
            );
        }
        emit_progress(
            app,
            "update",
            "Mise à jour du clone officiel (fast-forward uniquement)",
            Some(18),
            None,
        );
        let arguments = vec![
            OsString::from("-C"),
            source_dir.as_os_str().to_owned(),
            OsString::from("pull"),
            OsString::from("--ff-only"),
            OsString::from("origin"),
            OsString::from("main"),
        ];
        run_streaming(
            app,
            "update",
            external_command(&git, &arguments),
            runtime_root,
        )?;
        let head = git_text(&git, source_dir, &["rev-parse", "HEAD"])?;
        let official_head = git_text(&git, source_dir, &["rev-parse", "origin/main"])?;
        if head != official_head {
            return Err(
                "Le HEAD local ne correspond pas exactement à origin/main après la mise à jour; la compilation est interrompue."
                    .to_string(),
            );
        }
    } else {
        emit_progress(
            app,
            "clone",
            "Clonage du dépôt officiel Prime Agent",
            Some(15),
            None,
        );
        let arguments = vec![
            OsString::from("clone"),
            OsString::from("--depth"),
            OsString::from("1"),
            OsString::from("--branch"),
            OsString::from("main"),
            OsString::from(OFFICIAL_REPOSITORY_URL),
            source_dir.as_os_str().to_owned(),
        ];
        run_streaming(
            app,
            "clone",
            external_command(&git, &arguments),
            runtime_root,
        )?;
        let canonical = canonicalize(source_dir).map_err(|error| {
            format!(
                "Le clone {} ne peut pas être résolu: {error}",
                source_dir.display()
            )
        })?;
        if canonical.parent() != Some(runtime_root) {
            return Err("Le clone a été créé hors de la cible gérée attendue".to_string());
        }
        verify_official_repository(&git, &canonical)?;
    }

    emit_progress(
        app,
        "dependencies",
        "Installation reproductible des dépendances npm",
        Some(42),
        None,
    );
    run_streaming(
        app,
        "dependencies",
        external_command(&npm, &[OsString::from("ci")]),
        source_dir,
    )?;

    emit_progress(app, "build", "Compilation de Prime Agent", Some(72), None);
    run_streaming(
        app,
        "build",
        external_command(&npm, &[OsString::from("run"), OsString::from("build")]),
        source_dir,
    )?;

    let source_dir = canonicalize(source_dir).map_err(|error| {
        format!(
            "Impossible de résoudre le runtime compilé {}: {error}",
            source_dir.display()
        )
    })?;
    let cli = find_source_cli(&source_dir).ok_or_else(|| {
        format!(
            "La compilation s’est terminée sans produire le cli.js attendu dans {}",
            source_dir.display()
        )
    })?;
    let node = canonicalize(&node).unwrap_or(node);
    let config = RuntimeConfig {
        executable_path: None,
        source_dir: Some(source_dir.to_string_lossy().into_owned()),
        node_path: Some(node.to_string_lossy().into_owned()),
        cli_path: Some(cli.to_string_lossy().into_owned()),
        repository_url: Some(OFFICIAL_REPOSITORY_URL.to_string()),
        updated_at: Some(now_millis()),
    };
    // The quick installer is single-flight. This lock also prevents a settings
    // save in another window from interleaving with this atomic config write.
    let persistence = app.state::<PersistenceLock>();
    let _guard = persistence.0.lock();
    persist_runtime_config(app, &config)?;
    emit_progress(
        app,
        "complete",
        "Prime Agent est installé et prêt",
        Some(100),
        None,
    );
    Ok(cli)
}

fn quick_install_prime_agent_blocking(
    app: AppHandle,
    install_flag: Arc<AtomicBool>,
) -> Result<QuickInstallStarted, String> {
    install_flag
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .map_err(|_| "Une installation de Prime Agent est déjà en cours".to_string())?;

    let flag = Arc::clone(&install_flag);
    let (_, source_dir) = match validated_install_paths(&app) {
        Ok(paths) => paths,
        Err(error) => {
            flag.store(false, Ordering::SeqCst);
            return Err(error);
        }
    };
    let response = QuickInstallStarted {
        started: true,
        source_dir: source_dir.to_string_lossy().into_owned(),
    };
    let event_source_dir = response.source_dir.clone();
    thread::spawn(move || {
        emit_progress(
            &app,
            "starting",
            "Préparation de l’installation Prime Agent",
            Some(2),
            None,
        );
        let result = perform_install(&app, &source_dir);
        let complete = match result {
            Ok(cli) => InstallCompleteEvent {
                success: true,
                source_dir: event_source_dir,
                cli_path: Some(cli.to_string_lossy().into_owned()),
                error: None,
            },
            Err(error) => {
                emit_progress(&app, "error", &error, None, Some("stderr"));
                InstallCompleteEvent {
                    success: false,
                    source_dir: event_source_dir,
                    cli_path: None,
                    error: Some(error),
                }
            }
        };
        flag.store(false, Ordering::SeqCst);
        let _ = app.emit("prime-agent://install-complete", complete);
    });
    Ok(response)
}

#[tauri::command]
pub async fn quick_install_prime_agent(
    app: AppHandle,
    install_state: tauri::State<'_, InstallState>,
) -> Result<QuickInstallStarted, String> {
    let flag = Arc::clone(&install_state.0);
    crate::run_blocking(move || quick_install_prime_agent_blocking(app, flag)).await
}

#[tauri::command]
pub fn is_prime_agent_installing(install_state: tauri::State<'_, InstallState>) -> bool {
    install_state.0.load(Ordering::SeqCst)
}

#[cfg(test)]
mod tests {
    use super::normalized_repository_url;

    #[test]
    fn normalizes_official_https_and_ssh_origins() {
        assert_eq!(
            normalized_repository_url("https://github.com/PrimeIntellect-ai/prime-agent.git"),
            normalized_repository_url("git@github.com:PrimeIntellect-ai/prime-agent.git")
        );
    }
}
